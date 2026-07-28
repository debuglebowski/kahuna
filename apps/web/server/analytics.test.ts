import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildCustomQuery,
  buildPosthogQuery,
  CustomQueryError,
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

describe("custom query construction", () => {
  const CUSTOM = { ...BASE, metric: "custom" } as const
  const W = { from: new Date("2026-07-01T00:00:00.000Z"), to: new Date("2026-07-28T00:00:00.000Z") }
  const inner = "SELECT toStartOfDay(timestamp) AS bucket, count() AS value FROM events"

  it("wraps the query in a bounded subquery", () => {
    const built = buildCustomQuery({ ...CUSTOM, query: inner }, W)
    expect(built.query).toBe(`SELECT * FROM (\n${inner}\n) LIMIT 2000`)
  })

  // A trailing `-- comment` would swallow the closing paren on one line, so the
  // newlines around the subquery are load-bearing, not cosmetic.
  it("delimits the wrap with newlines so a trailing comment can't eat the paren", () => {
    const built = buildCustomQuery({ ...CUSTOM, query: `${inner} -- note` }, W)
    expect(built.query).toContain("-- note\n)")
  })

  it("binds the window as params rather than interpolating it", () => {
    const built = buildCustomQuery(
      { ...CUSTOM, query: `${inner} WHERE timestamp >= {from} AND timestamp < {to}` },
      W,
    )
    expect(built.params).toEqual({ from: W.from.toISOString(), to: W.to.toISOString() })
    expect(built.query).not.toContain("2026-07-01T00:00:00.000Z")
  })

  it("binds a resolved record value as {recordValue}", () => {
    const built = buildCustomQuery({ ...CUSTOM, query: inner, recordValue: "a@b.dev" }, W)
    expect(built.params.recordValue).toBe("a@b.dev")
    expect(built.query).not.toContain("a@b.dev")
  })

  it("rejects an embedded semicolon (it also breaks the wrap)", () => {
    expect(() => buildCustomQuery({ ...CUSTOM, query: "SELECT 1; DROP TABLE x" }, W)).toThrow(
      CustomQueryError,
    )
  })

  it("tolerates a trailing semicolon", () => {
    expect(buildCustomQuery({ ...CUSTOM, query: `${inner};` }, W).query).toContain(`${inner}\n)`)
  })

  it("rejects an empty query", () => {
    expect(() => buildCustomQuery({ ...CUSTOM, query: "   " }, W)).toThrow(CustomQueryError)
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

describe("custom query endpoint", () => {
  const oldEnv = { ...process.env }
  const CUSTOM = {
    ...BASE,
    metric: "custom",
    query: "SELECT toStartOfDay(timestamp) AS bucket, count() AS value FROM events",
  } as const

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

  /** Capture the HogQL text + values the provider was asked to run. */
  const capture = (rows: unknown[][], columns: string[]) => {
    const sent: { query: string; values: Record<string, unknown> }[] = []
    setPosthogFetchForTest(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: { query?: string; values?: Record<string, unknown> }
      }
      sent.push({ query: String(body.query?.query ?? ""), values: body.query?.values ?? {} })
      return hogqlResponse(rows, columns)
    })
    return sent
  }

  it("400s a custom query with no query text, before hitting the provider", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const sent = capture([], [])
    const res = await postQuery(actor, { ...CUSTOM, query: "" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "QUERY_REQUIRED" })
    expect(sent).toHaveLength(0)
  })

  it("400s on an embedded semicolon, before hitting the provider", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const sent = capture([], [])
    const res = await postQuery(actor, { ...CUSTOM, query: "SELECT 1 AS bucket; SELECT 2" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "SEMICOLON_NOT_ALLOWED" })
    expect(sent).toHaveLength(0)
  })

  it("runs the wrapped query with the window bound as params", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const sent = capture([["2026-07-01T00:00:00Z", 5]], ["bucket", "value"])
    const res = await postQuery(actor, CUSTOM)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.query).toBe(`SELECT * FROM (\n${CUSTOM.query}\n) LIMIT 2000`)
    expect(Object.keys(sent[0]?.values ?? {}).sort()).toEqual(["from", "to"])
  })

  it("splits into series when the query returns a series column", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    capture(
      [
        ["2026-07-01T00:00:00Z", 2, "chrome"],
        ["2026-07-01T00:00:00Z", 9, "safari"],
      ],
      ["bucket", "value", "series"],
    )
    const res = await postQuery(actor, CUSTOM)
    const body = (await res.json()) as { series: { name: string }[] }
    expect(body.series.map((s) => s.name)).toEqual(["safari", "chrome"])
  })

  // Without shape validation a mis-aliased query renders as "No data in this
  // window" — rowsToSeries silently drops rows whose bucket won't parse.
  it("names the columns it got back when the aliases are wrong", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    capture([["$pageview", 5]], ["event", "value"])
    const res = await postQuery(actor, CUSTOM)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "BAD_QUERY_SHAPE", detail: "event, value" })
  })

  it("binds {recordValue} when a record filter resolves", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const sent = capture([["2026-07-01T00:00:00Z", 1]], ["bucket", "value"])
    await postQuery(actor, {
      ...CUSTOM,
      query: `${CUSTOM.query} WHERE properties.email = {recordValue}`,
      recordProperty: "email",
      recordValue: "a@b.dev",
    })
    expect(sent[0]?.values.recordValue).toBe("a@b.dev")
    expect(sent[0]?.query).not.toContain("a@b.dev")
  })

  // Same bug class as the recordValue cache-key test: two custom widgets differ
  // in nothing BUT their query text.
  it("does NOT share cache entries across different query texts", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const sent = capture([["2026-07-01T00:00:00Z", 1]], ["bucket", "value"])
    await postQuery(actor, CUSTOM)
    await postQuery(actor, { ...CUSTOM, query: `${CUSTOM.query} WHERE event = 'x'` })
    expect(sent).toHaveLength(2)
    expect(sent[0]?.query).not.toBe(sent[1]?.query)
  })

  it("re-runs the same query over the shifted window for a delta", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    const sent = capture([["2026-07-01T00:00:00Z", 3]], ["bucket", "value"])
    await postQuery(actor, { ...CUSTOM, includePrior: true })
    expect(sent).toHaveLength(2)
    // Identical text (we never rewrite the caller's SQL), earlier window.
    expect(sent[1]?.query).toBe(sent[0]?.query)
    expect(String(sent[1]?.values.to)).toBe(String(sent[0]?.values.from))
    expect(Number(new Date(String(sent[1]?.values.from)))).toBeLessThan(
      Number(new Date(String(sent[0]?.values.from))),
    )
  })

  it("400s with the provider's message when the provider rejects the query", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    setPosthogFetchForTest(
      async () =>
        new Response(JSON.stringify({ detail: "Global variable not found: nope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    )
    const res = await postQuery(actor, { ...CUSTOM, query: "SELECT {nope} AS bucket" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: "ANALYTICS_QUERY_INVALID",
      detail: "Global variable not found: nope",
    })
  })

  // A structured query hitting the same 400 is an outage/bug on our side, not the
  // author's mistake — it must keep its 502.
  it("still 502s a provider 400 on a STRUCTURED query", async () => {
    const actor = await signUpAndOrg()
    await connectFor(actor)
    setPosthogFetchForTest(async () => new Response("boom", { status: 400 }))
    const res = await postQuery(actor, BASE)
    expect(res.status).toBe(502)
  })
})
