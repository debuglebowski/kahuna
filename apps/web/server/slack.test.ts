import { createHmac, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auth } from "./auth"
import { slackConnection, slackEvent, slackOAuthState, slackUserConnection } from "./auth-schema"
import { db } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import {
  disconnectSlack,
  disconnectSlackUser,
  handleInteractivity,
  handleSlackCallback,
  handleSlackEvents,
  handleSlackUserConnect,
  handleSlashCommand,
  postMessage,
  postSlackMessageAsMeForRequest,
  setSlackFetchForTest,
  slackApiRequest,
  slackStatus,
  verifySlackSignature,
} from "./slack"

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

/** Build a request with a valid (or deliberately invalid) Slack signature. */
const sign = (secret: string, ts: string, body: string) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`

const signedRequest = (
  rawBody: string,
  opts?: { ts?: number; secret?: string; contentType?: string },
) => {
  const ts = String(opts?.ts ?? Math.floor(Date.now() / 1000))
  const secret = opts?.secret ?? process.env.SLACK_SIGNING_SECRET ?? ""
  const headers = new Headers({
    "content-type": opts?.contentType ?? "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": sign(secret, ts, rawBody),
  })
  return new Request("http://localhost/api/integrations/slack/events", {
    method: "POST",
    headers,
    body: rawBody,
  })
}

describe("Slack integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    process.env.SLACK_CLIENT_ID = "client-id"
    process.env.SLACK_CLIENT_SECRET = "client-secret"
    process.env.SLACK_SIGNING_SECRET = "signing-secret"
    process.env.SLACK_REDIRECT_URI = "http://localhost/api/integrations/slack/callback"
    process.env.SLACK_SYNC_ENABLED = "0"
  })

  afterEach(() => {
    setSlackFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  it("verifies a valid signature and rejects forgeries, wrong secret, stale ts, and tampering", () => {
    const body = JSON.stringify({ hello: "world" })
    const good = signedRequest(body)
    expect(verifySlackSignature(good, body)).toBe(true)

    // Forged signature of the wrong length.
    const forged = new Request("http://localhost/x", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      body,
    })
    expect(verifySlackSignature(forged, body)).toBe(false)

    // Right shape, wrong secret.
    expect(verifySlackSignature(signedRequest(body, { secret: "not-it" }), body)).toBe(false)

    // Stale timestamp (>5 min skew).
    expect(
      verifySlackSignature(signedRequest(body, { ts: Math.floor(Date.now() / 1000) - 600 }), body),
    ).toBe(false)

    // Tampered body no longer matches the signed digest.
    expect(verifySlackSignature(good, `${body} tampered`)).toBe(false)
  })

  it("answers the url_verification challenge", async () => {
    const raw = JSON.stringify({ type: "url_verification", challenge: "abc123" })
    const res = await handleSlackEvents(signedRequest(raw))
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { challenge?: string }
    expect(payload.challenge).toBe("abc123")
  })

  it("rejects an event with a bad signature", async () => {
    const raw = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev1" })
    const res = await handleSlackEvents(signedRequest(raw, { secret: "wrong" }))
    expect(res.status).toBe(401)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_SIGNATURE")
  })

  it("accepts a signed event, records it, and dedups a replay by event_id", async () => {
    const actor = await signUpAndOrg()
    await db.insert(slackConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-DEDUP",
      botUserId: "U-BOT",
      botToken: encryptToken("xoxb-1"),
    })
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: "T-DEDUP",
      event_id: "Ev-100",
      event: { type: "app_mention", user: "U-HUMAN", text: "hi" },
    })

    const first = await handleSlackEvents(signedRequest(raw))
    expect(first.status).toBe(200)
    const firstPayload = (await first.json()) as { ok?: boolean; deduped?: boolean }
    expect(firstPayload.ok).toBe(true)
    expect(firstPayload.deduped).toBeFalsy()

    const [row] = await db
      .select()
      .from(slackEvent)
      .where(eq(slackEvent.dedupeKey, "evt:Ev-100"))
      .limit(1)
    expect(row?.teamId).toBe("T-DEDUP")
    expect(row?.eventType).toBe("app_mention")

    const replay = await handleSlackEvents(signedRequest(raw))
    const replayPayload = (await replay.json()) as { deduped?: boolean }
    expect(replayPayload.deduped).toBe(true)
  })

  it("ignores the bot's own messages (no dedup row written)", async () => {
    const actor = await signUpAndOrg()
    await db.insert(slackConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-BOT",
      botUserId: "U-SELF",
      botToken: encryptToken("xoxb-1"),
    })
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: "T-BOT",
      event_id: "Ev-bot",
      event: { type: "message", user: "U-SELF", text: "i posted this" },
    })
    const res = await handleSlackEvents(signedRequest(raw))
    const payload = (await res.json()) as { ok?: boolean; ignored?: boolean }
    expect(payload.ignored).toBe(true)
    const rows = await db.select().from(slackEvent).where(eq(slackEvent.dedupeKey, "evt:Ev-bot"))
    expect(rows).toHaveLength(0)
  })

  it("slash command verifies the signature and acks ephemerally", async () => {
    const raw = new URLSearchParams({
      command: "/km",
      text: "create deal",
      team_id: "T-NONE",
    }).toString()
    const req = signedRequest(raw, { contentType: "application/x-www-form-urlencoded" })
    const res = await handleSlashCommand(req)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { response_type?: string; text?: string }
    expect(payload.response_type).toBe("ephemeral")
    expect(payload.text).toContain("/km")
  })

  it("interactivity rejects a forged signature", async () => {
    const raw = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions" }))}`
    const req = signedRequest(raw, {
      secret: "wrong",
      contentType: "application/x-www-form-urlencoded",
    })
    const res = await handleInteractivity(req)
    expect(res.status).toBe(401)
  })

  it("retries a 429 from the Web API and returns the payload", async () => {
    let calls = 0
    setSlackFetchForTest(async () => {
      calls += 1
      if (calls === 1)
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      return okJson({ ok: true, value: 42 })
    })
    const out = await slackApiRequest<{ ok: boolean; value: number }>("tok", "auth.test")
    expect(out.value).toBe(42)
    expect(calls).toBe(2)
  })

  it("gives up after retrying 5xx and throws with the status", async () => {
    let calls = 0
    setSlackFetchForTest(async () => {
      calls += 1
      return new Response("boom", { status: 503, headers: { "retry-after": "0" } })
    })
    await expect(slackApiRequest("tok", "auth.test")).rejects.toThrow(/Slack API 503/)
    expect(calls).toBe(4) // initial + 3 retries
  })

  it("postMessage posts to a channel and returns the ts", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(slackConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        teamId: "T-POST",
        botUserId: "U-BOT",
        botToken: encryptToken("xoxb-post"),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    let seenBody: Record<string, unknown> = {}
    setSlackFetchForTest(async (input, init) => {
      expect(String(input)).toBe("https://slack.com/api/chat.postMessage")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-post")
      seenBody = JSON.parse(String(init?.body ?? "{}"))
      return okJson({ ok: true, ts: "1700000000.000100", channel: "C-1" })
    })

    const result = await postMessage(connection, "C-1", { text: "hello world" })
    expect(result.ts).toBe("1700000000.000100")
    expect(seenBody.channel).toBe("C-1")
    expect(seenBody.text).toBe("hello world")
  })

  it("surfaces a Slack ok:false error", async () => {
    setSlackFetchForTest(async () => okJson({ ok: false, error: "channel_not_found" }))
    await expect(slackApiRequest("tok", "chat.postMessage", { channel: "C-x" })).rejects.toThrow(
      /channel_not_found/,
    )
  })

  it("callback exchanges the code and stores the bot token encrypted per workspace", async () => {
    const actor = await signUpAndOrg()
    await db.insert(slackOAuthState).values({
      state: "slack-state-1",
      orgId: actor.orgId,
      userId: actor.userId,
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    })
    setSlackFetchForTest(async (input) => {
      if (String(input).endsWith("/oauth.v2.access")) {
        return okJson({
          ok: true,
          access_token: "xoxb-workspace",
          scope: "chat:write,commands",
          bot_user_id: "U-BOTID",
          app_id: "A-APP",
          team: { id: "T-WS", name: "Acme Inc" },
          authed_user: { id: "U-INSTALLER" },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    const res = await handleSlackCallback(
      new Request(
        "http://localhost/api/integrations/slack/callback?code=the-code&state=slack-state-1",
        { headers: actor.headers },
      ),
    )
    expect(res.status).toBe(302)

    const [row] = await db
      .select()
      .from(slackConnection)
      .where(eq(slackConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("connected")
    expect(row?.teamId).toBe("T-WS")
    expect(row?.teamName).toBe("Acme Inc")
    expect(row?.botUserId).toBe("U-BOTID")
    expect(row?.botToken).not.toBe("xoxb-workspace")
    expect(decryptToken(row?.botToken)).toBe("xoxb-workspace")
  })

  it("callback rejects a state that does not match the session", async () => {
    const actor = await signUpAndOrg()
    const other = await signUpAndOrg()
    await db.insert(slackOAuthState).values({
      state: "slack-state-2",
      orgId: other.orgId,
      userId: other.userId,
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    })
    const res = await handleSlackCallback(
      new Request("http://localhost/api/integrations/slack/callback?code=c&state=slack-state-2", {
        headers: actor.headers,
      }),
    )
    expect(res.status).toBe(403)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("STATE_SESSION_MISMATCH")
  })

  it("status.configured reflects the presence of server OAuth + signing env", async () => {
    const actor = await signUpAndOrg()
    process.env.SLACK_SIGNING_SECRET = ""
    const disabled = (await (
      await slackStatus(
        new Request("http://localhost/api/integrations/slack/status", { headers: actor.headers }),
      )
    ).json()) as { configured?: boolean; connected?: boolean }
    expect(disabled.configured).toBe(false)
    expect(disabled.connected).toBe(false)

    process.env.SLACK_SIGNING_SECRET = "signing-secret"
    const enabled = (await (
      await slackStatus(
        new Request("http://localhost/api/integrations/slack/status", { headers: actor.headers }),
      )
    ).json()) as { configured?: boolean; connected?: boolean }
    expect(enabled.configured).toBe(true)
    expect(enabled.connected).toBe(false)
  })

  it("status reports the connected workspace shape with inbound URLs", async () => {
    const actor = await signUpAndOrg()
    await db.insert(slackConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-STATUS",
      teamName: "Workspace",
      botUserId: "U-B",
      botToken: encryptToken("xoxb-k"),
      scopes: "chat:write,commands",
    })
    const res = await slackStatus(
      new Request("http://localhost/api/integrations/slack/status", { headers: actor.headers }),
    )
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.configured).toBe(true)
    expect(payload.connected).toBe(true)
    expect(payload.teamName).toBe("Workspace")
    expect(payload.scopes).toEqual(["chat:write", "commands"])
    expect(String(payload.eventsUrl)).toContain("/api/integrations/slack/events")
    expect(String(payload.commandsUrl)).toContain("/api/integrations/slack/commands")
  })

  // ── per-user (xoxp user-token) auth ──────────────────────────────────────────

  // Each test gets a distinct team id by default — slack_connection.team_id is
  // UNIQUE and the test DB is not reset between cases within this file.
  const seedBot = (orgId: string, userId: string, teamId = `T-${randomUUID().slice(0, 8)}`) =>
    db.insert(slackConnection).values({
      orgId,
      userId,
      teamId,
      botUserId: "U-BOT",
      botToken: encryptToken("xoxb-bot"),
      scopes: "chat:write",
    })

  it("user connect requires the org bot to be installed first", async () => {
    const actor = await signUpAndOrg()
    const res = await handleSlackUserConnect(
      new Request("http://localhost/api/integrations/slack/user/connect", {
        headers: actor.headers,
      }),
    )
    expect(res.status).toBe(404)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("NO_SLACK_CONNECTION")
  })

  it("user connect redirects to Slack requesting user_scope and stores a kind='user' state", async () => {
    const actor = await signUpAndOrg()
    await seedBot(actor.orgId, actor.userId)
    const res = await handleSlackUserConnect(
      new Request("http://localhost/api/integrations/slack/user/connect", {
        headers: actor.headers,
      }),
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location") ?? "")
    expect(location.origin + location.pathname).toBe("https://slack.com/oauth/v2/authorize")
    expect(location.searchParams.get("user_scope")).toContain("chat:write")
    expect(location.searchParams.get("scope")).toBeNull()
    const state = location.searchParams.get("state") ?? ""
    const [row] = await db
      .select()
      .from(slackOAuthState)
      .where(eq(slackOAuthState.state, state))
      .limit(1)
    expect(row?.kind).toBe("user")
  })

  it("user callback stores the xoxp token per (org,user), validated via auth.test", async () => {
    const actor = await signUpAndOrg()
    await seedBot(actor.orgId, actor.userId, "T-UCB")
    await db.insert(slackOAuthState).values({
      state: "slack-user-state",
      orgId: actor.orgId,
      userId: actor.userId,
      kind: "user",
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    })
    setSlackFetchForTest(async (input) => {
      const u = String(input)
      if (u.endsWith("/oauth.v2.access"))
        return okJson({
          ok: true,
          authed_user: { id: "U-ME", access_token: "xoxp-me", scope: "chat:write,search:read" },
          team: { id: "T-UCB" },
        })
      if (u.endsWith("/auth.test"))
        return okJson({ ok: true, user_id: "U-ME", user: "me", team_id: "T-UCB" })
      return new Response("unexpected", { status: 500 })
    })

    const res = await handleSlackCallback(
      new Request(
        "http://localhost/api/integrations/slack/callback?code=c&state=slack-user-state",
        { headers: actor.headers },
      ),
    )
    expect(res.status).toBe(302)
    const [row] = await db
      .select()
      .from(slackUserConnection)
      .where(eq(slackUserConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("connected")
    expect(row?.slackUserId).toBe("U-ME")
    expect(row?.slackUserName).toBe("me")
    expect(row?.scopes).toBe("chat:write,search:read")
    expect(row?.userToken).not.toBe("xoxp-me")
    expect(decryptToken(row?.userToken)).toBe("xoxp-me")
  })

  it("user callback rejects a token from a different workspace than the org bot", async () => {
    const actor = await signUpAndOrg()
    await seedBot(actor.orgId, actor.userId, "T-MMB")
    await db.insert(slackOAuthState).values({
      state: "slack-user-mismatch",
      orgId: actor.orgId,
      userId: actor.userId,
      kind: "user",
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    })
    setSlackFetchForTest(async (input) => {
      const u = String(input)
      if (u.endsWith("/oauth.v2.access"))
        return okJson({
          ok: true,
          authed_user: { id: "U-ME", access_token: "xoxp-me", scope: "chat:write" },
          team: { id: "T-OTHER" },
        })
      if (u.endsWith("/auth.test"))
        return okJson({ ok: true, user_id: "U-ME", user: "me", team_id: "T-OTHER" })
      return new Response("unexpected", { status: 500 })
    })
    const res = await handleSlackCallback(
      new Request(
        "http://localhost/api/integrations/slack/callback?code=c&state=slack-user-mismatch",
        { headers: actor.headers },
      ),
    )
    expect(res.status).toBe(403)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("TEAM_MISMATCH")
    const rows = await db
      .select()
      .from(slackUserConnection)
      .where(eq(slackUserConnection.orgId, actor.orgId))
    expect(rows).toHaveLength(0)
  })

  it("post-as-me posts with the user token and returns the ts", async () => {
    const actor = await signUpAndOrg()
    await db.insert(slackUserConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-WS",
      slackUserId: "U-ME",
      slackUserName: "me",
      userToken: encryptToken("xoxp-me"),
      scopes: "chat:write",
    })
    let seenAuth = ""
    setSlackFetchForTest(async (input, init) => {
      expect(String(input)).toBe("https://slack.com/api/chat.postMessage")
      seenAuth = new Headers(init?.headers).get("authorization") ?? ""
      return okJson({ ok: true, ts: "1700000000.000200", channel: "C-9" })
    })
    const res = await postSlackMessageAsMeForRequest(
      new Request("http://localhost/api/integrations/slack/post-as-me", {
        method: "POST",
        headers: actor.headers,
        body: JSON.stringify({ channel: "C-9", text: "as me" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(seenAuth).toBe("Bearer xoxp-me")
    const payload = (await res.json()) as { ts?: string | null }
    expect(payload.ts).toBe("1700000000.000200")
  })

  it("status surfaces the per-user connection block", async () => {
    const actor = await signUpAndOrg()
    await seedBot(actor.orgId, actor.userId)
    await db.insert(slackUserConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-WS",
      slackUserId: "U-ME",
      slackUserName: "me",
      userToken: encryptToken("xoxp-me"),
      scopes: "chat:write,search:read",
    })
    const res = await slackStatus(
      new Request("http://localhost/api/integrations/slack/status", { headers: actor.headers }),
    )
    const payload = (await res.json()) as {
      user?: { connected?: boolean; slackUserName?: string; scopes?: string[] }
    }
    expect(payload.user?.connected).toBe(true)
    expect(payload.user?.slackUserName).toBe("me")
    expect(payload.user?.scopes).toEqual(["chat:write", "search:read"])
  })

  it("disconnecting a user nulls its token and revokes it", async () => {
    const actor = await signUpAndOrg()
    await db.insert(slackUserConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-WS",
      slackUserId: "U-ME",
      userToken: encryptToken("xoxp-me"),
      scopes: "chat:write",
    })
    let revoked = false
    setSlackFetchForTest(async (input) => {
      if (String(input).endsWith("/auth.revoke")) {
        revoked = true
        return okJson({ ok: true, revoked: true })
      }
      return new Response("unexpected", { status: 500 })
    })
    const res = await disconnectSlackUser(
      new Request("http://localhost/api/integrations/slack/user/disconnect", {
        method: "POST",
        headers: actor.headers,
      }),
    )
    expect(res.status).toBe(200)
    expect(revoked).toBe(true)
    const [row] = await db
      .select()
      .from(slackUserConnection)
      .where(eq(slackUserConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("disconnected")
    expect(row?.userToken).toBeNull()
  })

  it("disconnecting the org bot sweeps per-user tokens", async () => {
    const actor = await signUpAndOrg()
    await seedBot(actor.orgId, actor.userId)
    await db.insert(slackUserConnection).values({
      orgId: actor.orgId,
      userId: actor.userId,
      teamId: "T-WS",
      slackUserId: "U-ME",
      userToken: encryptToken("xoxp-me"),
      scopes: "chat:write",
    })
    const res = await disconnectSlack(
      new Request("http://localhost/api/integrations/slack/disconnect", {
        method: "POST",
        headers: actor.headers,
      }),
    )
    expect(res.status).toBe(200)
    const [row] = await db
      .select()
      .from(slackUserConnection)
      .where(eq(slackUserConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("disconnected")
    expect(row?.userToken).toBeNull()
  })
})
