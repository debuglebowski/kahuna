import { createHmac, randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { linearConnection, linearIssue } from "#db"
import { auth } from "./auth"
import { db, pool } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import {
  closeLinearIssue,
  connectLinear,
  handleLinearWebhook,
  linearGraphQL,
  linearStatus,
  setLinearFetchForTest,
  syncLinearConnection,
  updateLinearIssue,
} from "./linear"
import { createUserDirect } from "./provision"

const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

const signUpAndOrg = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  const created = await createUserDirect({ email, password, name: "Tester" })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: created.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers })
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new Error("missing session")
  return { headers, orgId: org.id, userId: session.user.id }
}

const okData = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } })

/** Parse the GraphQL document + variables out of a mocked fetch init. */
const queryOf = (init: Parameters<typeof fetch>[1]): { query: string; variables: unknown } => {
  try {
    return JSON.parse(String(init?.body ?? "{}"))
  } catch {
    return { query: "", variables: undefined }
  }
}

const postConnect = (actor: { headers: Headers }, body: unknown) => {
  const headers = new Headers(actor.headers)
  headers.set("content-type", "application/json")
  return connectLinear(
    new Request("http://localhost/api/integrations/linear/connect", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  )
}

describe("Linear integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    process.env.LINEAR_SYNC_ENABLED = "0"
  })

  afterEach(() => {
    setLinearFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  it("retries a 429 and returns the data payload", async () => {
    let calls = 0
    setLinearFetchForTest(async () => {
      calls += 1
      if (calls === 1)
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      return okData({ ok: true })
    })
    const out = await linearGraphQL<{ ok: boolean }>("k", "query { ok }")
    expect(out.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it("gives up after retrying 5xx and throws with the status", async () => {
    let calls = 0
    setLinearFetchForTest(async () => {
      calls += 1
      return new Response("boom", { status: 503, headers: { "retry-after": "0" } })
    })
    await expect(linearGraphQL("k", "query { ok }")).rejects.toThrow(/Linear API 503/)
    expect(calls).toBe(4) // initial + 3 retries
  })

  it("surfaces a GraphQL errors array as a thrown error", async () => {
    setLinearFetchForTest(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "nope" }] }), {
          headers: { "content-type": "application/json" },
        }),
    )
    await expect(linearGraphQL("k", "query { ok }")).rejects.toThrow(/Linear GraphQL error: nope/)
  })

  it("connect validates the key via viewer and stores it encrypted", async () => {
    const actor = await signUpAndOrg()
    setLinearFetchForTest(async (_input, init) => {
      const { query } = queryOf(init)
      expect(new Headers(init?.headers).get("authorization")).toBe("lin_live_key")
      if (query.includes("viewer")) return okData({ viewer: { id: "usr_1", name: "Ada" } })
      return new Response("unexpected", { status: 500 })
    })

    const res = await postConnect(actor, { apiKey: "lin_live_key" })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.connected).toBe(true)
    expect(payload.viewerName).toBe("Ada")

    const [row] = await db
      .select()
      .from(linearConnection)
      .where(eq(linearConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("connected")
    expect(row?.viewerId).toBe("usr_1")
    expect(row?.token).not.toBe("lin_live_key")
    expect(decryptToken(row?.token)).toBe("lin_live_key")
    expect(row?.webhookToken).toBeTruthy()
  })

  it("rejects a bad key with a 400", async () => {
    const actor = await signUpAndOrg()
    setLinearFetchForTest(async () => new Response("unauthorized", { status: 401 }))
    const res = await postConnect(actor, { apiKey: "lin_bad" })
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_API_KEY")
  })

  it("status reports the connected viewer shape with a webhook url", async () => {
    const actor = await signUpAndOrg()
    await db.insert(linearConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      token: encryptToken("lin_k"),
      webhookToken: "wh-token",
      webhookSecret: encryptToken("whsecret"),
      viewerId: "usr_9",
      viewerName: "Grace",
    })
    const res = await linearStatus(
      new Request("http://localhost/api/integrations/linear/status", { headers: actor.headers }),
    )
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.configured).toBe(true)
    expect(payload.connected).toBe(true)
    expect(payload.viewerName).toBe("Grace")
    expect(payload.webhookConfigured).toBe(true)
    expect(String(payload.webhookUrl)).toContain("token=wh-token")
  })

  it("syncs issues into the mirror table", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(linearConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        token: encryptToken("lin_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    setLinearFetchForTest(async (_input, init) => {
      const { query } = queryOf(init)
      if (query.includes("issues(first")) {
        return okData({
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "issue-1",
                identifier: "ENG-1",
                title: "Fix login",
                url: "https://linear.app/x/issue/ENG-1",
                priority: 2,
                updatedAt: "2026-06-10T00:00:00Z",
                state: { name: "In Progress", type: "started" },
                assignee: { id: "usr_1", name: "Ada" },
                team: { id: "team-1", key: "ENG" },
              },
            ],
          },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await syncLinearConnection(connection.id)

    const [issue] = await db
      .select()
      .from(linearIssue)
      .where(eq(linearIssue.linearId, "issue-1"))
      .limit(1)
    expect(issue?.identifier).toBe("ENG-1")
    expect(issue?.title).toBe("Fix login")
    expect(issue?.state).toBe("In Progress")
    expect(issue?.stateType).toBe("started")
    expect(issue?.assigneeName).toBe("Ada")
    expect(issue?.teamKey).toBe("ENG")
    expect(issue?.priority).toBe(2)

    const [updated] = await db
      .select()
      .from(linearConnection)
      .where(eq(linearConnection.id, connection.id))
      .limit(1)
    expect(updated?.lastSyncAt).toBeTruthy()
    expect(updated?.lastError).toBeNull()
  })

  it("upserts an existing issue on re-sync (no duplicate)", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(linearConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        token: encryptToken("lin_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    let title = "First"
    setLinearFetchForTest(async (_input, init) => {
      const { query } = queryOf(init)
      if (query.includes("issues(first")) {
        return okData({
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "issue-2", identifier: "ENG-2", title }],
          },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await syncLinearConnection(connection.id)
    title = "Renamed"
    await syncLinearConnection(connection.id)

    const rows = await db.select().from(linearIssue).where(eq(linearIssue.orgId, actor.orgId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe("Renamed")
  })

  const webhookRequest = (token: string, secret: string | null, raw: string, sig?: string) => {
    const headers = new Headers({ "content-type": "application/json" })
    const signature = sig ?? (secret ? createHmac("sha256", secret).update(raw).digest("hex") : "")
    headers.set("linear-signature", signature)
    return new Request(`http://localhost/api/integrations/linear/webhook?token=${token}`, {
      method: "POST",
      headers,
      body: raw,
    })
  }

  it("routes a webhook by the token HEADER as well as the query param", async () => {
    // The status endpoint now hands out a URL with no token in it, so header
    // delivery has to work. `?token=` stays supported (every other test in this
    // file uses it) because already-wired webhooks must keep delivering.
    const actor = await signUpAndOrg()
    await db.insert(linearConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      token: encryptToken("lin_k"),
      webhookToken: "wh-hdr",
      webhookSecret: encryptToken("topsecret"),
    })
    const raw = JSON.stringify({ action: "update", type: "Issue", data: { id: "issue-hdr" } })
    const headers = new Headers({ "content-type": "application/json" })
    headers.set("linear-signature", createHmac("sha256", "topsecret").update(raw).digest("hex"))
    headers.set("x-km-webhook-token", "wh-hdr")
    const res = await handleLinearWebhook(
      // No `?token=` at all — the header is the only routing information.
      new Request("http://localhost/api/integrations/linear/webhook", {
        method: "POST",
        headers,
        body: raw,
      }),
    )
    expect(res.status).toBe(200)
  })

  it("rejects a webhook with a bad signature", async () => {
    const actor = await signUpAndOrg()
    await db.insert(linearConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      token: encryptToken("lin_k"),
      webhookToken: "wh-1",
      webhookSecret: encryptToken("topsecret"),
    })
    const raw = JSON.stringify({ action: "update", type: "Issue", data: { id: "issue-9" } })
    const res = await handleLinearWebhook(webhookRequest("wh-1", null, raw, "deadbeef"))
    expect(res.status).toBe(401)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_SIGNATURE")
  })

  it("accepts a signed webhook, upserts the issue, and dedups a replay", async () => {
    // `beforeEach` disables sync deployment-wide so the connect tests don't call
    // out. The webhook honours that same toggle now, so re-enable it here.
    delete process.env.LINEAR_SYNC_ENABLED
    const actor = await signUpAndOrg()
    await db.insert(linearConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      token: encryptToken("lin_k"),
      webhookToken: "wh-2",
      webhookSecret: encryptToken("topsecret"),
    })
    const raw = JSON.stringify({
      action: "create",
      type: "Issue",
      data: {
        id: "issue-wh",
        identifier: "ENG-7",
        title: "From webhook",
        state: { name: "Todo", type: "unstarted" },
      },
    })

    const res = await handleLinearWebhook(webhookRequest("wh-2", "topsecret", raw))
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { ok?: boolean; deduped?: boolean }
    expect(payload.ok).toBe(true)
    expect(payload.deduped).toBeFalsy()

    const [issue] = await db
      .select()
      .from(linearIssue)
      .where(and(eq(linearIssue.orgId, actor.orgId), eq(linearIssue.linearId, "issue-wh")))
      .limit(1)
    expect(issue?.identifier).toBe("ENG-7")
    expect(issue?.state).toBe("Todo")

    // Replaying the identical delivery is deduped, not reprocessed.
    const replay = await handleLinearWebhook(webhookRequest("wh-2", "topsecret", raw))
    const replayPayload = (await replay.json()) as { deduped?: boolean }
    expect(replayPayload.deduped).toBe(true)
  })

  it("write-back: updateLinearIssue calls issueUpdate and re-mirrors the issue", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(linearConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        token: encryptToken("lin_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    let seenVars: unknown
    setLinearFetchForTest(async (_input, init) => {
      const { query, variables } = queryOf(init)
      if (query.includes("issueUpdate")) {
        seenVars = variables
        return okData({
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-3",
              identifier: "ENG-3",
              title: "Done record",
              state: { name: "Done", type: "completed" },
            },
          },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    const issue = await updateLinearIssue(connection, "issue-3", { stateId: "state-done" })
    expect(issue?.identifier).toBe("ENG-3")
    expect(seenVars).toEqual({ id: "issue-3", input: { stateId: "state-done" } })

    const [row] = await db
      .select()
      .from(linearIssue)
      .where(eq(linearIssue.linearId, "issue-3"))
      .limit(1)
    expect(row?.state).toBe("Done")
    expect(row?.stateType).toBe("completed")
  })

  it("write-back: closeLinearIssue resolves a completed state then updates", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(linearConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        token: encryptToken("lin_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    let updateVars: { input?: { stateId?: string } } | undefined
    setLinearFetchForTest(async (_input, init) => {
      const { query, variables } = queryOf(init)
      if (query.includes("issueUpdate")) {
        updateVars = variables as { input?: { stateId?: string } }
        return okData({ issueUpdate: { success: true, issue: { id: "issue-4" } } })
      }
      if (query.includes("states(filter")) {
        return okData({
          issue: { id: "issue-4", team: { states: { nodes: [{ id: "state-completed" }] } } },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await closeLinearIssue(connection, "issue-4")
    expect(updateVars?.input?.stateId).toBe("state-completed")
  })
})

describe("Linear → Kingsmaker concept mirror (Phase 1)", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    process.env.LINEAR_SYNC_ENABLED = "0"
  })

  afterEach(() => {
    setLinearFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  // Two issues; `title` is parameterized so a re-sync can change a value.
  const mockIssues = (title: string) =>
    setLinearFetchForTest(async (_input, init) => {
      const { query } = queryOf(init)
      if (query.includes("issues(first")) {
        return okData({
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "i1",
                identifier: "ENG-1",
                title,
                url: "https://linear.app/x/issue/ENG-1",
                priority: 2,
                updatedAt: "2026-06-10T00:00:00Z",
                state: { name: "In Progress", type: "started" },
                assignee: { id: "u1", name: "Ada" },
                team: { id: "t1", key: "ENG" },
              },
              {
                id: "i2",
                identifier: "ENG-2",
                title: "Second",
                state: { name: "Done", type: "completed" },
                team: { id: "t1", key: "ENG" },
              },
            ],
          },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

  const instanceStates = (orgId: string, conceptId: string) =>
    pool
      .query<{ state: Record<string, unknown> }>(
        `SELECT state FROM record_versions WHERE org_id = $1 AND concept_id = $2 AND archived_at IS NULL`,
        [orgId, conceptId],
      )
      .then((r) => r.rows.map((row) => row.state))

  it("mirrors synced issues into a Ticket concept and re-syncs idempotently", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(linearConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        token: encryptToken("lin_k"),
        webhookToken: randomUUID(),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    mockIssues("First title")
    await syncLinearConnection(connection.id)

    // The connector provisioned a Ticket concept and stored its ids on the row.
    const [conn1] = await db
      .select()
      .from(linearConnection)
      .where(eq(linearConnection.id, connection.id))
      .limit(1)
    expect(conn1?.conceptId).toBeTruthy()
    const conceptId = conn1?.conceptId as string
    const fieldMap = (conn1?.fieldMap ?? {}) as Record<string, string>
    expect(fieldMap.identifier).toBeTruthy()

    const concept = await pool.query<{ name: string }>(
      `SELECT name FROM concepts WHERE org_id = $1 AND id = $2`,
      [actor.orgId, conceptId],
    )
    expect(concept.rows[0]?.name).toBe("Linear - Ticket")

    const fId = fieldMap.identifier as string
    const fTitle = fieldMap.title as string
    const fStatus = fieldMap.status as string
    const fAssignee = fieldMap.assignee as string
    const fTeam = fieldMap.team as string
    const fPriority = fieldMap.priority as string

    const states = await instanceStates(actor.orgId, conceptId)
    expect(states).toHaveLength(2)
    const eng1 = states.find((s) => s[fId] === "ENG-1")
    if (!eng1) throw new Error("ENG-1 recordVersion missing")
    expect(eng1[fTitle]).toBe("First title")
    expect(eng1[fStatus]).toBe("started") // mapped from Linear state.type
    expect(eng1[fAssignee]).toBe("Ada")
    expect(eng1[fTeam]).toBe("ENG")
    expect(eng1[fPriority]).toBe(2)
    // Raw payload is NOT written into record version fields (only typed columns).
    expect(Object.keys(eng1).every((k) => Object.values(fieldMap).includes(k))).toBe(true)

    // Second sync with a changed title: same record version count, updated in place.
    mockIssues("Renamed title")
    await syncLinearConnection(connection.id)

    const states2 = await instanceStates(actor.orgId, conceptId)
    expect(states2).toHaveLength(2)
    const eng1b = states2.find((s) => s[fId] === "ENG-1")
    expect(eng1b?.[fTitle]).toBe("Renamed title")
  })
})
