import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import {
  slackAuditLog,
  slackChannel,
  slackConnection,
  slackEvent,
  slackOAuthState,
  slackUserConnection,
} from "#db"
import { db } from "./db"
import { readIntegrationSettings } from "./integrationSettings"
import { type AuditEntry, writeAuditLog } from "./integrations/audit"
import { decryptToken, encryptToken } from "./integrations/crypto"
import { connectorFailure, logConnectorError, publicConnectorError } from "./integrations/errors"
import { sleepBeforeRetry } from "./integrations/http"
import { redirect, safeReturnTo } from "./integrations/oauth"
import { connectionForOrgIn } from "./integrations/rows"
import { resolveAdmin, resolveOrg } from "./session"

/**
 * Slack connector — the first OAuth-based integration on the shared scaffold
 * (PostHog/Linear are key-based, Google is the OAuth reference). Auth is Slack
 * OAuth v2: a workspace admin installs the app and we exchange the code for a
 * bot token (xoxb) via `oauth.v2.access`, stored ENCRYPTED at the ORG level
 * (one workspace per org), keyed by `team_id` so inbound Events/slash/
 * interactivity POSTs route back to the right org.
 *
 * `status.configured` reflects server-side OAuth creds (`SLACK_CLIENT_ID` +
 * `SLACK_CLIENT_SECRET` + `SLACK_SIGNING_SECRET`) — without them the card shows
 * "Disabled", like Google. Inbound requests are verified with the Slack signing
 * secret (`v0=` HMAC over `v0:{ts}:{body}`, with a 5-minute skew window).
 *
 * KM wiring is DEFERRED (same discipline as PostHog/Linear): no automation
 * "post to Slack" action, and slash commands ack generically rather than
 * creating/looking up record versions against specific concepts.
 */

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
const SLACK_API = "https://slack.com/api"

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** Default bot scopes; overridable via `SLACK_SCOPES` (space/comma separated).
 *
 *  Adding a scope here does NOT re-grant it on workspaces that already installed
 *  the app — Slack only issues what was asked for at authorization time, so an
 *  existing install keeps its old grant until someone re-authorizes. That is why
 *  `slackHasScope` exists and why the editor warns per action instead of assuming
 *  this list reflects reality. */
const DEFAULT_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
  "commands",
  "app_mentions:read",
  "channels:history",
  "team:read",
  // For `slack.addReaction`. Absent on every install made before this shipped.
  "reactions:write",
]

/**
 * Default USER scopes (xoxp), requested in the per-user connect flow so KM can
 * act AS the person; overridable via `SLACK_USER_SCOPES`. These must also be
 * added under "User Token Scopes" in the Slack app config + the workspace
 * re-authorized once before they're grantable.
 */
const DEFAULT_USER_SCOPES = ["chat:write", "search:read", "users.profile:write", "reminders:write"]

const splitScopes = (raw: string | undefined): string[] =>
  (raw ?? "").split(/[\s,]+/).filter(Boolean)

const config = () => ({
  clientId: process.env.SLACK_CLIENT_ID ?? "",
  clientSecret: process.env.SLACK_CLIENT_SECRET ?? "",
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  redirectUri:
    process.env.SLACK_REDIRECT_URI ??
    `${process.env.BETTER_AUTH_URL ?? "http://localhost:3100"}/api/integrations/slack/callback`,
  scopes: splitScopes(process.env.SLACK_SCOPES).length
    ? splitScopes(process.env.SLACK_SCOPES)
    : DEFAULT_SCOPES,
  userScopes: splitScopes(process.env.SLACK_USER_SCOPES).length
    ? splitScopes(process.env.SLACK_USER_SCOPES)
    : DEFAULT_USER_SCOPES,
})

const requireConfig = () => {
  const c = config()
  if (!c.clientId || !c.clientSecret) {
    throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required")
  }
  return c
}

type SlackFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>
let slackFetch: SlackFetch = fetch

export const setSlackFetchForTest = (next: SlackFetch) => {
  slackFetch = next
}

/** Write one row to this connector's audit log. */
const audit = (input: AuditEntry) => writeAuditLog(slackAuditLog, input)

const connectionForOrg = (orgId: string) => connectionForOrgIn(slackConnection, orgId)

/**
 * Post to a channel as the org's bot, resolving the connection here.
 *
 * Exists for callers outside a request (the automation runner) that have an org
 * id but no `Request` to authenticate — so they don't reimplement the connection
 * lookup. Returns false when the org has no Slack connected, rather than
 * throwing: a missing integration is a recorded per-action outcome, not a run
 * failure.
 */
export async function postMessageForOrg(
  orgId: string,
  channel: string,
  text: string,
): Promise<boolean> {
  const conn = await connectionForOrg(orgId)
  if (!conn) return false
  const result = await postMessage(conn, channel, { text })
  return result.ok !== false
}

/**
 * The org's Slack connection, only when usable (connected + has a bot token).
 *
 * `postMessageForOrg` above predates this and skips the status check, so a
 * disconnected org reaches `tokenFor` and THROWS rather than reading as "not
 * connected" — harmless only because the automation runner happens to swallow it.
 * New callers use this instead.
 */
export const slackConnectionForOrg = async (orgId: string) => {
  const row = await connectionForOrg(orgId)
  return row?.status === "connected" ? row : null
}

/**
 * Whether a connection was actually GRANTED a scope.
 *
 * Google's equivalent is private and splits on whitespace only; Slack stores
 * scopes comma-separated, so reusing it would have matched nothing. `splitScopes`
 * handles both spellings.
 */
export const slackHasScope = (conn: typeof slackConnection.$inferSelect, scope: string): boolean =>
  new Set(splitScopes(conn.scopes)).has(scope)

/** What a Slack action reports back to the automation runner. `ts`/`channel` feed
 *  the `{{slack.*}}` chain tokens; `note` is user-visible in run history. */
export interface SlackActionResult {
  readonly ok: boolean
  readonly note: string
  readonly ts?: string
  readonly channel?: string
}

/**
 * Turn a thrown Slack error into a short, honest note.
 *
 * `publicConnectorError` maps by HTTP status class, but a Slack `ok:false` body
 * throws with no status at all — so `missing_scope` and `channel_not_found` both
 * came out as "Could not reach the provider.", which is neither true nor
 * actionable. Match the API's error slug first and only fall back to the generic
 * mapper. Notes render `truncate`d to one line, so they stay terse.
 */
const slackNote = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const slug = /Slack API error: (\w+)/.exec(raw)?.[1]
  switch (slug) {
    case undefined:
      break
    case "missing_scope":
    case "not_allowed_token_type":
      return "Slack denied the scope — reconnect Slack"
    case "channel_not_found":
      return "no such channel"
    case "not_in_channel":
      return "bot is not in that channel"
    case "is_archived":
      return "channel is archived"
    case "message_not_found":
      return "no such message"
    case "already_reacted":
      return "already reacted"
    case "invalid_name":
      return "no such emoji"
    case "user_not_found":
      return "no such Slack user"
    case "ratelimited":
      return "Slack is rate limiting us"
    default:
      return `Slack rejected the request (${slug})`
  }
  return publicConnectorError(error)
}

/** Run a Slack call for an org, mapping both "not connected" and every thrown
 *  error onto a recorded outcome. Every Slack automation action goes through
 *  this, so the not-connected note is written exactly once. */
const slackActionForOrg = async (
  orgId: string,
  run: (conn: typeof slackConnection.$inferSelect) => Promise<SlackActionResult>,
): Promise<SlackActionResult> => {
  const conn = await slackConnectionForOrg(orgId)
  if (!conn) return { ok: false, note: "Slack not connected" }
  try {
    return await run(conn)
  } catch (error) {
    logConnectorError("slack", "automation", error)
    return { ok: false, note: slackNote(error) }
  }
}

/** Post a message (optionally into a thread, optionally as Block Kit). */
export const postForOrg = (
  orgId: string,
  input: {
    channel: string
    text?: string
    blocks?: unknown[]
    threadTs?: string
  },
): Promise<SlackActionResult> =>
  slackActionForOrg(orgId, async (conn) => {
    const res = await postMessage(conn, input.channel, {
      text: input.text,
      blocks: input.blocks,
      threadTs: input.threadTs,
    })
    return {
      ok: res.ok !== false,
      note: input.threadTs ? `replied in ${input.channel}` : `posted to ${input.channel}`,
      ts: res.ts,
      channel: res.channel ?? input.channel,
    }
  })

/** Open (or reuse) a DM with a Slack user and post into it. */
export const dmUserForOrg = (
  orgId: string,
  input: { slackUserId: string; text?: string; blocks?: unknown[] },
): Promise<SlackActionResult> =>
  slackActionForOrg(orgId, async (conn) => {
    const opened = await slackApiRequest<{ ok: boolean; channel?: { id?: string } }>(
      tokenFor(conn),
      "conversations.open",
      { users: input.slackUserId },
    )
    const channel = opened.channel?.id
    if (!channel) return { ok: false, note: "could not open a DM" }
    const res = await postMessage(conn, channel, { text: input.text, blocks: input.blocks })
    return {
      ok: res.ok !== false,
      note: `DMed ${input.slackUserId}`,
      ts: res.ts,
      channel,
    }
  })

/**
 * Add an emoji reaction to a message.
 *
 * Pre-flights the scope rather than letting Slack answer `missing_scope`: the
 * grant is missing on every workspace installed before `reactions:write` was
 * added, and "reconnect Slack" is a fix the reader can act on.
 */
export const addReactionForOrg = (
  orgId: string,
  input: { channel: string; ts: string; name: string },
): Promise<SlackActionResult> =>
  slackActionForOrg(orgId, async (conn) => {
    if (!slackHasScope(conn, "reactions:write")) {
      return { ok: false, note: "Slack missing reactions:write — reconnect Slack" }
    }
    const emoji = input.name.replace(/^:|:$/g, "")
    await slackApiRequest(tokenFor(conn), "reactions.add", {
      channel: input.channel,
      timestamp: input.ts,
      name: emoji,
    })
    return { ok: true, note: `reacted :${emoji}:`, ts: input.ts, channel: input.channel }
  })

const connectionForTeam = async (teamId: string) => {
  const [row] = await db
    .select()
    .from(slackConnection)
    .where(and(eq(slackConnection.teamId, teamId), eq(slackConnection.status, "connected")))
    .limit(1)
  return row ?? null
}

const tokenFor = (conn: typeof slackConnection.$inferSelect): string => {
  const token = decryptToken(conn.botToken)
  if (!token) throw new Error("Slack connection has no bot token")
  return token
}

const userConnectionFor = async (orgId: string, userId: string) => {
  const [row] = await db
    .select()
    .from(slackUserConnection)
    .where(and(eq(slackUserConnection.orgId, orgId), eq(slackUserConnection.userId, userId)))
    .limit(1)
  return row ?? null
}

const userTokenFor = (conn: typeof slackUserConnection.$inferSelect): string => {
  const token = decryptToken(conn.userToken)
  if (!token) throw new Error("Slack user connection has no token")
  return token
}

// ── Slack Web API ─────────────────────────────────────────────────────────────

type SlackApiResult = { ok: boolean; error?: string } & Record<string, unknown>

/**
 * Authenticated Slack Web API call. Slack methods are POSTs to
 * `https://slack.com/api/<method>` with the bot token as a Bearer. Two distinct
 * failure modes are retried up to 3× with backoff: an HTTP 429/5xx (honoring
 * `Retry-After`), AND a 200 carrying `{ ok:false, error:"ratelimited" }`, which
 * is how Slack signals app-level rate limiting. Any other `ok:false` throws.
 */
export async function slackApiRequest<T = SlackApiResult>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  attempt = 0,
): Promise<T> {
  const res = await slackFetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  })
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleepBeforeRetry(res, attempt)
    return slackApiRequest<T>(token, method, body, attempt + 1)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const err = new Error(`Slack API ${res.status}: ${detail}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  const data = (await res.json().catch(() => ({ ok: false, error: "bad_json" }))) as SlackApiResult
  if (data.ok === false) {
    // Slack's app-level throttling arrives as a 200 whose BODY says ratelimited,
    // so this is past `res.ok` — but `Retry-After` is on the same response.
    if (data.error === "ratelimited" && attempt < 3) {
      await sleepBeforeRetry(res, attempt)
      return slackApiRequest<T>(token, method, body, attempt + 1)
    }
    throw new Error(`Slack API error: ${data.error ?? "unknown"}`)
  }
  return data as T
}

/** Post a message to a channel via chat.postMessage (with retry). Generic. */
export async function postMessage(
  conn: typeof slackConnection.$inferSelect,
  channel: string,
  message: { text?: string; blocks?: unknown[]; threadTs?: string },
): Promise<{ ok: boolean; ts?: string; channel?: string }> {
  const token = tokenFor(conn)
  return slackApiRequest<{ ok: boolean; ts?: string; channel?: string }>(
    token,
    "chat.postMessage",
    {
      channel,
      text: message.text,
      blocks: message.blocks,
      thread_ts: message.threadTs,
    },
  )
}

/** Post a message AS the user (xoxp user token) — the message is authored by the person, not the bot. */
export async function postMessageAsUser(
  conn: typeof slackUserConnection.$inferSelect,
  channel: string,
  message: { text?: string; blocks?: unknown[]; threadTs?: string },
): Promise<{ ok: boolean; ts?: string; channel?: string }> {
  const token = userTokenFor(conn)
  return slackApiRequest<{ ok: boolean; ts?: string; channel?: string }>(
    token,
    "chat.postMessage",
    {
      channel,
      text: message.text,
      blocks: message.blocks,
      thread_ts: message.threadTs,
    },
  )
}

// ── signature verification ────────────────────────────────────────────────────

const FIVE_MINUTES = 60 * 5

/**
 * Verify a Slack request signature: `x-slack-signature` must equal
 * `v0=` + HMAC-SHA256(`v0:{timestamp}:{rawBody}`, signingSecret). Stale
 * timestamps (>5 min skew) are rejected to blunt replay attacks, and the digest
 * comparison is timing-safe. Returns false (rather than throwing) on any miss so
 * callers can map it straight to a 401.
 */
export function verifySlackSignature(req: Request, rawBody: string, now = Date.now()): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) return false
  const signature = req.headers.get("x-slack-signature") ?? ""
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const ts = Number(timestamp)
  if (!timestamp || !Number.isFinite(ts)) return false
  if (Math.abs(now / 1000 - ts) > FIVE_MINUTES) return false
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`
  if (signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

// ── connect / callback / disconnect / status ──────────────────────────────────

export async function handleSlackConnect(req: Request) {
  // Admin-only: this is the workspace-level BOT install. `handleSlackUserConnect`
  // below deliberately stays member-open (own identity, own token).
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const c = requireConfig()
  const url = new URL(req.url)
  const state = randomUUID()
  const returnTo = url.searchParams.get("returnTo") || "/settings/integrations"
  await db.insert(slackOAuthState).values({
    state,
    orgId: org.orgId,
    userId: org.actor,
    returnTo,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  })
  const authUrl = new URL(SLACK_AUTHORIZE_URL)
  authUrl.searchParams.set("client_id", c.clientId)
  authUrl.searchParams.set("scope", c.scopes.join(","))
  authUrl.searchParams.set("redirect_uri", c.redirectUri)
  authUrl.searchParams.set("state", state)
  return redirect(authUrl.toString())
}

/**
 * Per-user connect — requests only `user_scope` (no bot `scope`) so Slack shows a
 * user-consent screen for the already-installed app and returns an xoxp user
 * token. Requires the org bot to be installed first (the app must exist in the
 * workspace). Funnels through the SAME `/callback` redirect URI as the install
 * flow; the `kind:'user'` state row is what tells the callback to expect a user
 * token rather than a bot token.
 */
export async function handleSlackUserConnect(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const c = requireConfig()
  const bot = await connectionForOrg(org.orgId)
  if (bot?.status !== "connected") return json({ error: "NO_SLACK_CONNECTION" }, 404)
  const url = new URL(req.url)
  const state = randomUUID()
  const returnTo = url.searchParams.get("returnTo") || "/settings/integrations"
  await db.insert(slackOAuthState).values({
    state,
    orgId: org.orgId,
    userId: org.actor,
    kind: "user",
    returnTo,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  })
  const authUrl = new URL(SLACK_AUTHORIZE_URL)
  authUrl.searchParams.set("client_id", c.clientId)
  authUrl.searchParams.set("user_scope", c.userScopes.join(","))
  authUrl.searchParams.set("redirect_uri", c.redirectUri)
  authUrl.searchParams.set("state", state)
  return redirect(authUrl.toString())
}

type OAuthAccessResponse = {
  ok?: boolean
  error?: string
  access_token?: string
  token_type?: string
  scope?: string
  bot_user_id?: string
  app_id?: string
  team?: { id?: string; name?: string }
  authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string }
  enterprise?: { id?: string } | null
}

export async function handleSlackCallback(req: Request) {
  const url = new URL(req.url)
  // User declined the install — bounce back to settings rather than erroring.
  if (url.searchParams.get("error")) return redirect(safeReturnTo("/settings/integrations"))
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) return json({ error: "BAD_OAUTH_CALLBACK" }, 400)
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [stored] = await db
    .select()
    .from(slackOAuthState)
    .where(eq(slackOAuthState.state, state))
    .limit(1)
  if (!stored || stored.expiresAt.getTime() < Date.now()) return json({ error: "BAD_STATE" }, 400)
  if (stored.orgId !== org.orgId || stored.userId !== org.actor) {
    return json({ error: "STATE_SESSION_MISMATCH" }, 403)
  }
  await db.delete(slackOAuthState).where(eq(slackOAuthState.state, state))

  const c = requireConfig()
  const tokenRes = await slackFetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
    }),
  })
  const data = (await tokenRes.json().catch(() => null)) as OAuthAccessResponse | null

  // Per-user (xoxp) flow: the user token lives in `authed_user.access_token`, NOT
  // the top-level bot `access_token`. Validate it via auth.test, ensure it's the
  // same workspace as the org bot, then upsert per (org, user) like google.
  if (stored.kind === "user") {
    const userToken = data?.authed_user?.access_token
    if (!tokenRes.ok || !data?.ok || !userToken) {
      return json({ error: data?.error ?? "USER_TOKEN_EXCHANGE_FAILED" }, 400)
    }
    const bot = await connectionForOrg(org.orgId)
    if (bot?.status !== "connected") return json({ error: "NO_SLACK_CONNECTION" }, 404)
    let test: { ok: boolean; user_id?: string; user?: string; team_id?: string }
    try {
      test = await slackApiRequest(userToken, "auth.test")
    } catch (error) {
      return json(
        { error: "USER_TOKEN_INVALID", detail: connectorFailure("slack", "user.connect", error) },
        400,
      )
    }
    if (test.team_id && test.team_id !== bot.teamId) {
      await audit({
        orgId: org.orgId,
        userId: org.actor,
        connectionId: bot.id,
        action: "user.connect",
        status: "error",
        detail: { reason: "team_mismatch", tokenTeam: test.team_id, botTeam: bot.teamId },
      })
      return json({ error: "TEAM_MISMATCH" }, 403)
    }
    const existingUser = await userConnectionFor(org.orgId, org.actor)
    const userValues = {
      orgId: org.orgId,
      userId: org.actor,
      teamId: test.team_id ?? bot.teamId,
      slackUserId: test.user_id ?? data.authed_user?.id ?? null,
      slackUserName: test.user ?? null,
      userToken: encryptToken(userToken),
      scopes: data.authed_user?.scope ?? "",
      status: "connected",
      disconnectedAt: null,
      lastError: null,
    }
    const [userConn] = existingUser
      ? await db
          .update(slackUserConnection)
          .set(userValues)
          .where(eq(slackUserConnection.id, existingUser.id))
          .returning()
      : await db.insert(slackUserConnection).values(userValues).returning()
    if (!userConn) return json({ error: "USER_CONNECTION_WRITE_FAILED" }, 500)
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: bot.id,
      action: "user.connect",
      subjectKind: "slack_user",
      subjectId: userConn.slackUserId,
      detail: { scope: data.authed_user?.scope },
    })
    return redirect(safeReturnTo(stored.returnTo))
  }

  if (!tokenRes.ok || !data?.ok || !data.access_token || !data.team?.id) {
    return json({ error: data?.error ?? "TOKEN_EXCHANGE_FAILED" }, 400)
  }

  const existing = await connectionForOrg(org.orgId)
  const values = {
    orgId: org.orgId,
    userId: org.actor,
    teamId: data.team.id,
    teamName: data.team.name ?? null,
    enterpriseId: data.enterprise?.id ?? null,
    appId: data.app_id ?? null,
    botUserId: data.bot_user_id ?? null,
    authedUserId: data.authed_user?.id ?? null,
    botToken: encryptToken(data.access_token),
    scopes: data.scope ?? "",
    status: "connected",
    disconnectedAt: null,
    lastError: null,
  }
  const [connection] = existing
    ? await db
        .update(slackConnection)
        .set(values)
        .where(eq(slackConnection.id, existing.id))
        .returning()
    : await db.insert(slackConnection).values(values).returning()
  if (!connection) return json({ error: "CONNECTION_WRITE_FAILED" }, 500)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "connect",
    detail: { teamId: data.team.id, scope: data.scope },
  })
  if ((await readIntegrationSettings(org.orgId)).slackSyncEnabled) {
    await syncSlackChannels(connection.id).catch((error) =>
      audit({
        orgId: org.orgId,
        userId: org.actor,
        connectionId: connection.id,
        action: "sync.initial",
        status: "error",
        detail: { error: String(error) },
      }),
    )
  }
  return redirect(safeReturnTo(stored.returnTo))
}

export async function disconnectSlack(req: Request) {
  // Admin-only: this cascades to EVERY member's user token (see below).
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ ok: true })
  await db
    .update(slackConnection)
    .set({ status: "disconnected", botToken: null, disconnectedAt: new Date() })
    .where(eq(slackConnection.id, connection.id))
  // "Slack is connected" is an org-level contract — disconnecting the bot also
  // disconnects every per-user token so no live xoxp tokens are left orphaned.
  await db
    .update(slackUserConnection)
    .set({ status: "disconnected", userToken: null, disconnectedAt: new Date() })
    .where(eq(slackUserConnection.orgId, org.orgId))
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "disconnect",
  })
  return json({ ok: true })
}

export async function disconnectSlackUser(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await userConnectionFor(org.orgId, org.actor)
  if (!connection) return json({ ok: true })
  // Best-effort revoke at Slack before nulling — a revoked token is dead anyway.
  if (connection.userToken) {
    await slackApiRequest(decryptToken(connection.userToken) ?? "", "auth.revoke").catch(
      () => undefined,
    )
  }
  await db
    .update(slackUserConnection)
    .set({ status: "disconnected", userToken: null, disconnectedAt: new Date() })
    .where(eq(slackUserConnection.id, connection.id))
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "user.disconnect",
  })
  return json({ ok: true })
}

const inboundUrlFor = (suffix: string): string | null => {
  const base = process.env.SLACK_WEBHOOK_BASE_URL ?? process.env.BETTER_AUTH_URL ?? ""
  const path = `/api/integrations/slack/${suffix}`
  return base ? `${base.replace(/\/+$/, "")}${path}` : path
}

export async function slackStatus(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  // `configured` reflects server-side OAuth creds + signing secret: without them
  // the install can't start / inbound requests can't be verified, so the UI
  // shows the integration as disabled.
  const c = config()
  const configured = Boolean(c.clientId && c.clientSecret && c.signingSecret)
  const connection = await connectionForOrg(org.orgId)
  // Per-user token state for the current actor — surfaced regardless of bot state
  // so the UI can show "Connect my account" once the org bot is connected.
  const userConn = await userConnectionFor(org.orgId, org.actor)
  const user =
    userConn?.status === "connected"
      ? {
          connected: true as const,
          slackUserId: userConn.slackUserId,
          slackUserName: userConn.slackUserName,
          scopes: splitScopes(userConn.scopes),
        }
      : { connected: false as const }
  if (connection?.status !== "connected") {
    return json({ configured, connected: false, user })
  }
  return json({
    configured,
    connected: true,
    teamId: connection.teamId,
    teamName: connection.teamName,
    botUserId: connection.botUserId,
    scopes: connection.scopes ? connection.scopes.split(/[\s,]+/).filter(Boolean) : [],
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
    eventsUrl: inboundUrlFor("events"),
    commandsUrl: inboundUrlFor("commands"),
    interactivityUrl: inboundUrlFor("interactivity"),
    user,
  })
}

// ── channel cache sync ────────────────────────────────────────────────────────

type SlackChannelNode = {
  id?: string
  name?: string
  is_private?: boolean
  is_archived?: boolean
}

export async function syncSlackChannels(connectionId: string) {
  const [connection] = await db
    .select()
    .from(slackConnection)
    .where(eq(slackConnection.id, connectionId))
    .limit(1)
  if (connection?.status !== "connected") return
  const token = tokenFor(connection)
  try {
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await slackApiRequest<{
        ok: boolean
        channels?: SlackChannelNode[]
        response_metadata?: { next_cursor?: string }
      }>(token, "conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit: 200,
        cursor,
      })
      for (const ch of page.channels ?? []) {
        if (!ch.id) continue
        const values = {
          connectionId: connection.id,
          orgId: connection.orgId,
          channelId: ch.id,
          name: ch.name ?? null,
          isPrivate: Boolean(ch.is_private),
          isArchived: Boolean(ch.is_archived),
          raw: ch as Record<string, unknown>,
          syncedAt: new Date(),
        }
        await db
          .insert(slackChannel)
          .values(values)
          .onConflictDoUpdate({
            target: [slackChannel.connectionId, slackChannel.channelId],
            set: {
              name: values.name,
              isPrivate: values.isPrivate,
              isArchived: values.isArchived,
              raw: values.raw,
              syncedAt: values.syncedAt,
            },
          })
      }
      cursor = page.response_metadata?.next_cursor || undefined
      pages += 1
    } while (cursor && pages < 50)
    await db
      .update(slackConnection)
      .set({ lastSyncAt: new Date(), lastError: null })
      .where(eq(slackConnection.id, connection.id))
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "sync",
    })
  } catch (error) {
    await db
      .update(slackConnection)
      // Sanitized: served to every member via `…/status`.
      .set({ lastError: publicConnectorError(error) })
      .where(eq(slackConnection.id, connection.id))
    throw error
  }
}

export async function syncSlackForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_SLACK_CONNECTION" }, 404)
  if (!(await readIntegrationSettings(org.orgId)).slackSyncEnabled) {
    return json({ error: "SYNC_DISABLED" }, 403)
  }
  await syncSlackChannels(connection.id)
  return json({ ok: true })
}

export async function listSlackChannels(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const rows = await db
    .select({
      channelId: slackChannel.channelId,
      name: slackChannel.name,
      isPrivate: slackChannel.isPrivate,
      isArchived: slackChannel.isArchived,
    })
    .from(slackChannel)
    .where(eq(slackChannel.orgId, org.orgId))
    .limit(1000)
  return json({ channels: rows })
}

/** Generic "post to a channel" endpoint — the seam the deferred automation action will reuse. */
export async function postSlackMessageForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_SLACK_CONNECTION" }, 404)
  const body = (await req.json().catch(() => null)) as {
    channel?: string
    text?: string
    blocks?: unknown[]
    threadTs?: string
  } | null
  const channel = body?.channel?.trim()
  if (!channel) return json({ error: "CHANNEL_REQUIRED" }, 400)
  if (!body?.text && !body?.blocks) return json({ error: "TEXT_OR_BLOCKS_REQUIRED" }, 400)
  try {
    const result = await postMessage(connection, channel, {
      text: body.text,
      blocks: body.blocks,
      threadTs: body.threadTs,
    })
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "post_message",
      subjectKind: "channel",
      subjectId: channel,
    })
    return json({ ok: true, ts: result.ts ?? null, channel: result.channel ?? channel })
  } catch (error) {
    return json(
      { error: "POST_FAILED", detail: connectorFailure("slack", "post_message", error) },
      502,
    )
  }
}

/**
 * Post a message AS the current user (xoxp token) — the message is authored by
 * the person, not the bot. Demonstrates the per-user token end-to-end; a revoked
 * token flips the connection to `revoked` so the UI can prompt a reconnect.
 */
export async function postSlackMessageAsMeForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await userConnectionFor(org.orgId, org.actor)
  if (connection?.status !== "connected") return json({ error: "NO_SLACK_USER_CONNECTION" }, 404)
  const body = (await req.json().catch(() => null)) as {
    channel?: string
    text?: string
    blocks?: unknown[]
    threadTs?: string
  } | null
  const channel = body?.channel?.trim()
  if (!channel) return json({ error: "CHANNEL_REQUIRED" }, 400)
  if (!body?.text && !body?.blocks) return json({ error: "TEXT_OR_BLOCKS_REQUIRED" }, 400)
  try {
    const result = await postMessageAsUser(connection, channel, {
      text: body.text,
      blocks: body.blocks,
      threadTs: body.threadTs,
    })
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "post_message.user",
      subjectKind: "channel",
      subjectId: channel,
    })
    return json({ ok: true, ts: result.ts ?? null, channel: result.channel ?? channel })
  } catch (error) {
    const message = String(error)
    if (message.includes("token_revoked") || message.includes("invalid_auth")) {
      await db
        .update(slackUserConnection)
        .set({ status: "revoked", lastError: message })
        .where(eq(slackUserConnection.id, connection.id))
    }
    return json({ error: "POST_FAILED", detail: message }, 502)
  }
}

// ── inbound: events / slash commands / interactivity ──────────────────────────

type SlackEventBody = {
  type?: string
  challenge?: string
  team_id?: string
  event_id?: string
  event?: {
    type?: string
    subtype?: string
    user?: string
    bot_id?: string
  } & Record<string, unknown>
}

/**
 * Events API receiver. Verifies the signature, answers the one-time
 * `url_verification` challenge, then dedups by `event_id` (Slack retries
 * un-acked deliveries) and ignores the bot's own messages so automations can't
 * loop. KM mapping (mention → activity/task on the matched record version) is
 * DEFERRED — events are recorded + audited only.
 */
export async function handleSlackEvents(req: Request) {
  const rawText = await req.text().catch(() => "")
  if (!verifySlackSignature(req, rawText)) return json({ error: "INVALID_SIGNATURE" }, 401)
  let body: SlackEventBody = {}
  try {
    body = rawText ? (JSON.parse(rawText) as SlackEventBody) : {}
  } catch {
    body = {}
  }
  if (body.type === "url_verification") return json({ challenge: body.challenge ?? "" })

  const teamId = typeof body.team_id === "string" ? body.team_id : null
  const eventId = typeof body.event_id === "string" ? body.event_id : null
  const connection = teamId ? await connectionForTeam(teamId) : null

  const event = body.event ?? {}
  const isOwnBot =
    Boolean(event.bot_id) ||
    event.subtype === "bot_message" ||
    (connection?.botUserId != null && event.user === connection.botUserId)
  if (isOwnBot) return json({ ok: true, ignored: true })

  const dedupeKey = eventId
    ? `evt:${eventId}`
    : `sha:${createHash("sha256").update(rawText).digest("base64url")}`
  try {
    await db.insert(slackEvent).values({
      orgId: connection?.orgId ?? null,
      connectionId: connection?.id ?? null,
      dedupeKey,
      teamId,
      eventType: event.type ?? body.type ?? null,
      payload: body as Record<string, unknown>,
    })
  } catch {
    // Unique-violation on dedupeKey → already processed; ack idempotently.
    return json({ ok: true, deduped: true })
  }
  if (connection) {
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "event",
      subjectKind: event.type ?? null,
      subjectId: eventId,
    })
  }
  return json({ ok: true })
}

/**
 * Slash-command receiver. Slack POSTs `application/x-www-form-urlencoded` and
 * expects a 200 within 3s. Verifies the signature, then acks with an ephemeral
 * reply. Verb→record version create/lookup against concepts is DEFERRED (kept generic).
 */
export async function handleSlashCommand(req: Request) {
  const rawText = await req.text().catch(() => "")
  if (!verifySlackSignature(req, rawText)) return json({ error: "INVALID_SIGNATURE" }, 401)
  const params = new URLSearchParams(rawText)
  const command = params.get("command") ?? ""
  const text = params.get("text") ?? ""
  const teamId = params.get("team_id")
  const connection = teamId ? await connectionForTeam(teamId) : null
  if (connection) {
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "slash_command",
      subjectKind: "command",
      subjectId: command,
      detail: { text },
    })
  }
  // Generic ephemeral ack — deep KM verb handling is deferred.
  return json({
    response_type: "ephemeral",
    text: `Received \`${command}${text ? ` ${text}` : ""}\`. Kingsmaker actions are coming soon.`,
  })
}

/**
 * Interactivity receiver (block actions, shortcuts, modal submits). Slack POSTs
 * a form-encoded `payload=<json>` and expects a fast 200. Verifies the signature
 * and acks; action handling is DEFERRED.
 */
export async function handleInteractivity(req: Request) {
  const rawText = await req.text().catch(() => "")
  if (!verifySlackSignature(req, rawText)) return json({ error: "INVALID_SIGNATURE" }, 401)
  const params = new URLSearchParams(rawText)
  const payloadRaw = params.get("payload")
  let payload: { team?: { id?: string }; type?: string } = {}
  try {
    payload = payloadRaw ? JSON.parse(payloadRaw) : {}
  } catch {
    payload = {}
  }
  const teamId = typeof payload.team?.id === "string" ? payload.team.id : null
  const connection = teamId ? await connectionForTeam(teamId) : null
  if (connection) {
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "interactivity",
      subjectKind: payload.type ?? null,
    })
  }
  return json({ ok: true })
}
