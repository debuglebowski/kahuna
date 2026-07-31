import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { posthogConnection, posthogPersonMetric } from "#db"
import { auth } from "./auth"
import { db } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import {
  connectPosthog,
  posthogRequest,
  posthogStatus,
  setPosthogFetchForTest,
  syncPosthogConnection,
} from "./posthog"

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

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

const postConnect = (actor: { headers: Headers }, body: unknown) => {
  const headers = new Headers(actor.headers)
  headers.set("content-type", "application/json")
  return connectPosthog(
    new Request("http://localhost/api/integrations/posthog/connect", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  )
}

describe("PostHog integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    process.env.POSTHOG_SYNC_ENABLED = "0"
  })

  afterEach(() => {
    setPosthogFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  it("round-trips an encrypted token", () => {
    const encrypted = encryptToken("phx_super_secret")
    expect(encrypted).not.toBe("phx_super_secret")
    expect(encrypted).toMatch(/^v1\./)
    expect(decryptToken(encrypted)).toBe("phx_super_secret")
    expect(encryptToken(null)).toBeNull()
    expect(decryptToken(null)).toBeNull()
  })

  it("retries a 429 and returns the body", async () => {
    let calls = 0
    setPosthogFetchForTest(async () => {
      calls += 1
      if (calls === 1)
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      return okJson({ ok: true })
    })
    const out = await posthogRequest<{ ok: boolean }>(
      { host: "https://us.posthog.com", apiKey: "k" },
      "/api/projects/",
    )
    expect(out.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it("gives up after retrying 5xx and throws with the status", async () => {
    let calls = 0
    setPosthogFetchForTest(async () => {
      calls += 1
      return new Response("boom", { status: 503, headers: { "retry-after": "0" } })
    })
    await expect(
      posthogRequest({ host: "https://us.posthog.com", apiKey: "k" }, "/api/projects/"),
    ).rejects.toThrow(/PostHog API 503/)
    expect(calls).toBe(4) // initial + 3 retries
  })

  /* A 429/5xx with NO `Retry-After` must still back off. `Number(null)` is 0 and
   * `Number.isFinite(0)` is true, so the obvious reading of the header made the
   * exponential fallback dead code and hot-looped the retries — this asserts the
   * absent header is distinguished from an explicit "0" (which stays immediate,
   * which is why every other retry test here can send "0" and run fast). */
  it("backs off when the 429 carries no retry-after header", async () => {
    let calls = 0
    const gaps: number[] = []
    let last = performance.now()
    setPosthogFetchForTest(async () => {
      calls += 1
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (calls <= 2) return new Response("rate limited", { status: 429 })
      return okJson({ ok: true })
    })
    const out = await posthogRequest<{ ok: boolean }>(
      { host: "https://us.posthog.com", apiKey: "k" },
      "/api/projects/",
    )
    expect(out.ok).toBe(true)
    expect(calls).toBe(3)
    // Gaps after the 1st/2nd attempt are the backoff: 300 * 2**0, 300 * 2**1.
    // Generous lower bounds — the point is "not zero", not the exact schedule.
    expect(gaps[1]).toBeGreaterThan(200)
    expect(gaps[2]).toBeGreaterThan(500)
  })

  it("connect validates the key, binds a project, and stores it encrypted", async () => {
    const actor = await signUpAndOrg()
    const seen: string[] = []
    setPosthogFetchForTest(async (input, init) => {
      const u = String(input)
      seen.push(u)
      if (u.endsWith("/api/projects/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer phx_live_key")
        return okJson({ results: [{ id: 42, name: "Marketing" }] })
      }
      return new Response("unexpected", { status: 500 })
    })

    const res = await postConnect(actor, { apiKey: "phx_live_key", region: "us" })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.connected).toBe(true)
    expect(payload.projectId).toBe("42")
    expect(payload.projectName).toBe("Marketing")
    expect(payload.host).toBe("https://us.posthog.com")
    expect(seen.some((u) => u.endsWith("/api/projects/"))).toBe(true)

    const [row] = await db
      .select()
      .from(posthogConnection)
      .where(eq(posthogConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("connected")
    expect(row?.projectId).toBe("42")
    expect(row?.apiKey).not.toBe("phx_live_key")
    expect(decryptToken(row?.apiKey)).toBe("phx_live_key")
    expect(row?.webhookToken).toBeTruthy()
  })

  it("rejects a bad key with a 400", async () => {
    const actor = await signUpAndOrg()
    setPosthogFetchForTest(async () => new Response("unauthorized", { status: 401 }))
    const res = await postConnect(actor, { apiKey: "phx_bad", region: "eu" })
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_API_KEY")
  })

  it("status reports the connected project shape", async () => {
    const actor = await signUpAndOrg()
    await db.insert(posthogConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      host: "https://eu.posthog.com",
      region: "eu",
      projectId: "7",
      projectName: "App",
      apiKey: encryptToken("phx_k"),
      webhookToken: "wh-token",
    })
    const res = await posthogStatus(
      new Request("http://localhost/api/integrations/posthog/status", { headers: actor.headers }),
    )
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.configured).toBe(true)
    expect(payload.connected).toBe(true)
    expect(payload.region).toBe("eu")
    expect(payload.projectId).toBe("7")
    expect(String(payload.webhookUrl)).toContain("token=wh-token")
  })

  it("syncs persons and merges event aggregates into metrics", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(posthogConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        host: "https://us.posthog.com",
        region: "us",
        projectId: "99",
        apiKey: encryptToken("phx_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    setPosthogFetchForTest(async (input) => {
      const u = String(input)
      if (u.includes("/query/")) {
        return okJson({
          columns: ["distinct_id", "event_count", "first_seen", "last_seen"],
          results: [["user-1", 5, "2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z"]],
        })
      }
      if (u.includes("/persons/")) {
        return okJson({
          next: null,
          results: [
            {
              id: 1,
              uuid: "person-uuid-1",
              name: "Ann",
              distinct_ids: ["user-1"],
              properties: { email: "ann@test.dev" },
              created_at: "2026-05-01T00:00:00Z",
              last_seen_at: "2026-06-09T00:00:00Z",
            },
          ],
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await syncPosthogConnection(connection.id)

    const [metric] = await db
      .select()
      .from(posthogPersonMetric)
      .where(eq(posthogPersonMetric.distinctId, "user-1"))
      .limit(1)
    expect(metric?.email).toBe("ann@test.dev")
    expect(metric?.name).toBe("Ann")
    expect(metric?.personId).toBe("person-uuid-1")
    expect(metric?.eventCount).toBe(5)
    // last_seen merges the person's last_seen_at with the query aggregate (max).
    expect(metric?.lastSeenAt?.toISOString()).toBe("2026-06-10T00:00:00.000Z")

    const [updated] = await db
      .select()
      .from(posthogConnection)
      .where(eq(posthogConnection.id, connection.id))
      .limit(1)
    expect(updated?.lastSyncAt).toBeTruthy()
    expect(updated?.lastError).toBeNull()
  })

  it("upserts an existing person metric on re-sync (no duplicate)", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(posthogConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        host: "https://us.posthog.com",
        region: "us",
        projectId: "99",
        apiKey: encryptToken("phx_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    let eventCount = 3
    setPosthogFetchForTest(async (input) => {
      const u = String(input)
      if (u.includes("/query/")) {
        return okJson({
          columns: ["distinct_id", "event_count", "first_seen", "last_seen"],
          results: [["user-2", eventCount, "2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z"]],
        })
      }
      if (u.includes("/persons/")) {
        return okJson({
          next: null,
          results: [{ id: 2, distinct_ids: ["user-2"], properties: { email: "b@test.dev" } }],
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await syncPosthogConnection(connection.id)
    eventCount = 9
    await syncPosthogConnection(connection.id)

    const rows = await db
      .select()
      .from(posthogPersonMetric)
      .where(eq(posthogPersonMetric.orgId, actor.orgId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.eventCount).toBe(9)
  })
})
