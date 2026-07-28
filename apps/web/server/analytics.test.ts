import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildPosthogQuery,
  clearAnalyticsCacheForTest,
  queryAnalytics,
  rowsToSeries,
} from "./analytics"
import { auth } from "./auth"
import { posthogConnection } from "./auth-schema"
import { db } from "./db"
import { encryptToken } from "./integrations/crypto"
import { setPosthogFetchForTest } from "./posthog"

const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

const signUpAndOrg = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  await auth.api.signUpEmail({ body: { email, password, name: "Tester" } })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  const org = await auth.api.createOrganization({
    body: { name: `Org ${randomUUID().slice(0, 8)}`, slug: `org-${randomUUID().slice(0, 8)}` },
    headers,
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers })
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new Error("missing session")
  return { headers, orgId: org.id, userId: session.user.id }
}

const connectFor = async (actor: { orgId: string; userId: string }) => {
  await db.insert(posthogConnection).values({
    orgId: actor.orgId,
    userId: actor.userId,
    host: "https://us.posthog.com",
    region: "us",
    projectId: "42",
    projectName: "Test",
    apiKey: encryptToken("phx_test_key"),
    webhookToken: randomUUID(),
    status: "connected",
  })
}

const postQuery = (actor: { headers: Headers }, body: unknown) => {
  const headers = new Headers(actor.headers)
  headers.set("content-type", "application/json")
  return queryAnalytics(
    new Request("http://localhost/api/integrations/analytics/query", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  )
}

/** A HogQL response with `[bucket, value]` (or `[bucket, value, series]`) rows. */
const hogqlResponse = (results: unknown[][], columns: string[]) =>
  new Response(JSON.stringify({ results, columns }), {
    headers: { "content-type": "application/json" },
  })

const BASE = {
  provider: "posthog",
  metric: "active_users",
  interval: "week",
  since: "30d",
} as const

describe("analytics query translation", () => {
  it("builds a bucketed aggregate and binds the window as params", () => {
    const from = new Date("2026-07-01T00:00:00.000Z")
    const to = new Date("2026-07-28T00:00:00.000Z")
    const built = buildPosthogQuery(
      { provider: "posthog", metric: "active_users", interval: "week", since: "30d" },
      { from, to },
    )
    expect(built.query).toContain("toStartOfWeek(timestamp) AS bucket")
    expect(built.query).toContain("count(DISTINCT distinct_id) AS value")
    expect(built.query).toContain("GROUP BY bucket")
    expect(built.params.from).toBe(from.toISOString())
    expect(built.params.to).toBe(to.toISOString())
  })

  it("uses count() for event_count and the matching bucket fn per interval", () => {
    const w = { from: new Date(0), to: new Date(1) }
    expect(
      buildPosthogQuery({ ...BASE, metric: "event_count", interval: "day" }, w).query,
    ).toContain("count() AS value")
    expect(buildPosthogQuery({ ...BASE, interval: "day" }, w).query).toContain(
      "toStartOfDay(timestamp)",
    )
    expect(buildPosthogQuery({ ...BASE, interval: "month" }, w).query).toContain(
      "toStartOfMonth(timestamp)",
    )
  })

  it("binds event / breakdown / record filters as params, never inline", () => {
    const built = buildPosthogQuery(
      {
        ...BASE,
        event: "$pageview",
        breakdown: "plan",
        recordProperty: "email",
        recordValue: "a@b.dev",
      },
      { from: new Date(0), to: new Date(1) },
    )
    expect(built.query).toContain("event = {event}")
    expect(built.query).toContain("properties[{breakdown}] AS series")
    expect(built.query).toContain("properties[{recordProperty}] = {recordValue}")
    expect(built.query).toContain("GROUP BY bucket, series")
    expect(built.params).toMatchObject({
      event: "$pageview",
      breakdown: "plan",
      recordProperty: "email",
      recordValue: "a@b.dev",
    })
    // The values themselves must not appear in the SQL text.
    expect(built.query).not.toContain("$pageview")
    expect(built.query).not.toContain("a@b.dev")
  })

  it("keeps an injection-shaped property out of the query text", () => {
    const nasty = "x') OR 1=1 --"
    const built = buildPosthogQuery(
      { ...BASE, breakdown: nasty },
      { from: new Date(0), to: new Date(1) },
    )
    expect(built.query).not.toContain(nasty)
    expect(built.params.breakdown).toBe(nasty)
  })

  it("shapes rows into one series per breakdown value, biggest first", () => {
    const series = rowsToSeries(
      {
        columns: ["bucket", "value", "series"],
        results: [
          ["2026-07-01T00:00:00Z", 2, "free"],
          ["2026-07-08T00:00:00Z", 3, "free"],
          ["2026-07-01T00:00:00Z", 40, "pro"],
        ],
      },
      true,
    )
    expect(series.map((s) => s.name)).toEqual(["pro", "free"])
    expect(series[1]?.points).toHaveLength(2)
  })

  it("collapses to a single 'value' series with no breakdown", () => {
    const series = rowsToSeries(
      { columns: ["bucket", "value"], results: [["2026-07-01T00:00:00Z", 7]] },
      false,
    )
    expect(series).toHaveLength(1)
    expect(series[0]?.name).toBe("value")
    expect(series[0]?.points[0]?.value).toBe(7)
  })
})

describe("analytics query endpoint", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    clearAnalyticsCacheForTest()
  })

  afterEach(() => {
    setPosthogFetchForTest(fetch)
    process.env = { ...oldEnv }
    clearAnalyticsCacheForTest()
  })

  it("404s when the org has no PostHog connection", async () => {
    const actor = await signUpAndOrg()
    const res = await postQuery(actor, BASE)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: "NO_POSTHOG_CONNECTION" })
  })

  it("rejects an invalid metric/interval before hitting the provider", async () => {
    const actor = await signUpAndOrg()
    let called = 0
    setPosthogFetchForTest(async () => {
      called += 1
      return hogqlResponse([], [])
    })
    const res = await postQuery(actor, { ...BASE, metric: "bogus" })
    expect(res.status).toBe(400)
    expect(called).toBe(0)
  })

  it("returns series for a connected org", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    setPosthogFetchForTest(async () =>
      hogqlResponse(
        [
          ["2026-07-01T00:00:00Z", 5],
          ["2026-07-08T00:00:00Z", 9],
        ],
        ["bucket", "value"],
      ),
    )
    const res = await postQuery(actor, BASE)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { series: { name: string; points: unknown[] }[] }
    expect(body.series).toHaveLength(1)
    expect(body.series[0]?.points).toHaveLength(2)
  })

  it("caches repeated identical queries (one provider call)", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    let calls = 0
    setPosthogFetchForTest(async () => {
      calls += 1
      return hogqlResponse([["2026-07-01T00:00:00Z", 1]], ["bucket", "value"])
    })
    await postQuery(actor, BASE)
    await postQuery(actor, BASE)
    expect(calls).toBe(1)
  })

  // The sharpest bug this design can have: a cache keyed only on the query
  // config would serve record A's numbers for record B's widget.
  it("does NOT share cache entries across record values", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const seen: string[] = []
    setPosthogFetchForTest(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: { values?: Record<string, unknown> }
      }
      seen.push(String(body.query?.values?.recordValue ?? ""))
      return hogqlResponse([["2026-07-01T00:00:00Z", 1]], ["bucket", "value"])
    })
    await postQuery(actor, { ...BASE, recordProperty: "email", recordValue: "a@b.dev" })
    await postQuery(actor, { ...BASE, recordProperty: "email", recordValue: "c@d.dev" })
    expect(seen).toEqual(["a@b.dev", "c@d.dev"])
  })

  it("returns an empty series (no provider call) when a record filter has no value", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    let calls = 0
    setPosthogFetchForTest(async () => {
      calls += 1
      return hogqlResponse([], ["bucket", "value"])
    })
    const res = await postQuery(actor, { ...BASE, recordProperty: "email", recordValue: null })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ series: [], delta: null })
    expect(calls).toBe(0)
  })

  it("queries the prior window too when a delta is requested", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    let calls = 0
    setPosthogFetchForTest(async () => {
      calls += 1
      return hogqlResponse([["2026-07-01T00:00:00Z", calls === 1 ? 10 : 4]], ["bucket", "value"])
    })
    const res = await postQuery(actor, { ...BASE, includePrior: true })
    expect(calls).toBe(2)
    const body = (await res.json()) as { delta: { cur: number; prior: number } | null }
    expect(body.delta).toEqual({ cur: 10, prior: 4 })
  })

  it("502s when the provider errors", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    setPosthogFetchForTest(async () => new Response("boom", { status: 400 }))
    const res = await postQuery(actor, BASE)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: "ANALYTICS_QUERY_FAILED" })
  })
})
