import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import {
  googleAuditLog,
  googleCalendarEvent,
  googleCalendarSync,
  googleConnection,
  googleGmailMessage,
  googleGmailSync,
  googleGmailThread,
  googleNotification,
  googleOAuthState,
} from "#db"
import type { OrgScope } from "#engine"
import { db, pool } from "./db"
import { readIntegrationSettings } from "./integrationSettings"
import { type AuditEntry, writeAuditLog } from "./integrations/audit"
import { decryptToken, encryptToken, secretMatches } from "./integrations/crypto"
import { publicConnectorError } from "./integrations/errors"
import { sleepBeforeRetry } from "./integrations/http"
import { redirect, safeReturnTo } from "./integrations/oauth"
import {
  type ProvisionConceptSpec,
  type ProvisionedConcept,
  provisionConcept,
  upsertRecordVersionByExternalId,
} from "./integrations/records"
import { systemScope } from "./runtime"
import { resolveOrg } from "./session"

// Token crypto now lives in the shared integrations helper; re-export it so
// existing importers (and tests) keep resolving these from "./google".
export { decryptToken, encryptToken } from "./integrations/crypto"

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_API = "https://www.googleapis.com"

export const GOOGLE_SCOPES = {
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  calendarFreebusy: "https://www.googleapis.com/auth/calendar.freebusy",
  gmailMetadata: "https://www.googleapis.com/auth/gmail.metadata",
  gmailLabels: "https://www.googleapis.com/auth/gmail.labels",
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
} as const

// Connect requests the full set the app uses in a single consent: calendar
// read/write + free/busy, and Gmail metadata/labels/read/send. (gmail.compose is
// intentionally omitted — no feature uses it.) `scopesForRequest` still honors
// per-capability params, but the UI no longer needs incremental grants.
const BASE_SCOPES = [
  GOOGLE_SCOPES.calendarEvents,
  GOOGLE_SCOPES.calendarFreebusy,
  GOOGLE_SCOPES.gmailMetadata,
  GOOGLE_SCOPES.gmailLabels,
  GOOGLE_SCOPES.gmailReadonly,
  GOOGLE_SCOPES.gmailSend,
]

type GoogleFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>
let googleFetch: GoogleFetch = fetch

export const setGoogleFetchForTest = (next: GoogleFetch) => {
  googleFetch = next
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

const config = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  redirectUri:
    process.env.GOOGLE_REDIRECT_URI ??
    `${process.env.BETTER_AUTH_URL ?? "http://localhost:3100"}/api/integrations/google/callback`,
  webhookBaseUrl: process.env.GOOGLE_WEBHOOK_BASE_URL ?? "",
  pubsubTopic: process.env.GOOGLE_PUBSUB_TOPIC ?? "",
  pubsubVerificationToken: process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN ?? "",
})

const requireConfig = () => {
  const c = config()
  if (!c.clientId || !c.clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required")
  }
  return c
}

/** `Authorization: Bearer <token>`, if present. Pub/Sub can be configured to send
 *  the verification token as a bearer instead of a query param; both are accepted
 *  (the header form keeps the secret out of access logs — see the Clay callback). */
const bearerToken = (req: Request): string | null => {
  const raw = req.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1]!.trim() : null
}

const toScopeList = (scopeText: string | null | undefined) =>
  new Set((scopeText ?? "").split(/\s+/).filter(Boolean))

const hasScope = (scopeText: string | null | undefined, scope: string) =>
  toScopeList(scopeText).has(scope)

const scopesForRequest = (url: URL) => {
  const scopes = new Set<string>(BASE_SCOPES)
  for (const capability of url.searchParams.getAll("capability")) {
    if (capability === "gmail.read") scopes.add(GOOGLE_SCOPES.gmailReadonly)
    if (capability === "gmail.send") scopes.add(GOOGLE_SCOPES.gmailSend)
    if (capability === "gmail.compose") scopes.add(GOOGLE_SCOPES.gmailCompose)
    if (capability === "calendar.freebusy") scopes.add(GOOGLE_SCOPES.calendarFreebusy)
  }
  return [...scopes]
}

/** Write one row to this connector's audit log. */
const audit = (input: AuditEntry) => writeAuditLog(googleAuditLog, input)

async function googleRequest<T>(
  connectionId: string,
  url: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const accessToken = await accessTokenFor(connectionId)
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${accessToken}`)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const res = await googleFetch(url, { ...init, headers })
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleepBeforeRetry(res, attempt)
    return googleRequest<T>(connectionId, url, init, attempt + 1)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const err = new Error(`Google API ${res.status}: ${detail}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function refreshAccessToken(row: typeof googleConnection.$inferSelect): Promise<string> {
  const refreshToken = decryptToken(row.refreshToken)
  if (!refreshToken) throw new Error("Google connection has no refresh token")
  const c = requireConfig()
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  })
  const res = await googleFetch(GOOGLE_TOKEN_URL, { method: "POST", body })
  const data = (await res.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
    error?: string
  } | null
  if (!res.ok || !data?.access_token) {
    if (data?.error === "invalid_grant") {
      await db
        .update(googleConnection)
        .set({ status: "revoked", lastError: "invalid_grant" })
        .where(eq(googleConnection.id, row.id))
    }
    throw new Error(data?.error ?? `Google refresh failed: ${res.status}`)
  }
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000)
  await db
    .update(googleConnection)
    .set({ accessToken: encryptToken(data.access_token), accessTokenExpiresAt: expiresAt })
    .where(eq(googleConnection.id, row.id))
  await audit({
    orgId: row.orgId,
    userId: row.userId,
    connectionId: row.id,
    action: "token.refresh",
  })
  return data.access_token
}

async function accessTokenFor(connectionId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(googleConnection)
    .where(eq(googleConnection.id, connectionId))
    .limit(1)
  if (row?.status !== "connected") throw new Error("Google connection not connected")
  const expiresAt = row.accessTokenExpiresAt?.getTime() ?? 0
  if (!row.accessToken || expiresAt < Date.now() + 60_000) return refreshAccessToken(row)
  const token = decryptToken(row.accessToken)
  if (!token) return refreshAccessToken(row)
  return token
}

export async function handleGoogleConnect(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const c = requireConfig()
  const url = new URL(req.url)
  const state = randomUUID()
  const scopes = scopesForRequest(url)
  const returnTo = url.searchParams.get("returnTo") || "/settings/integrations"
  await db.insert(googleOAuthState).values({
    state,
    orgId: org.orgId,
    userId: org.actor,
    scopes: scopes.join(" "),
    returnTo,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  })
  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set("client_id", c.clientId)
  authUrl.searchParams.set("redirect_uri", c.redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("scope", scopes.join(" "))
  authUrl.searchParams.set("state", state)
  authUrl.searchParams.set("access_type", "offline")
  authUrl.searchParams.set("include_granted_scopes", "true")
  authUrl.searchParams.set("prompt", "consent")
  return redirect(authUrl.toString())
}

export async function handleGoogleCallback(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) return json({ error: "BAD_OAUTH_CALLBACK" }, 400)
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [stored] = await db
    .select()
    .from(googleOAuthState)
    .where(eq(googleOAuthState.state, state))
    .limit(1)
  if (!stored || stored.expiresAt.getTime() < Date.now()) return json({ error: "BAD_STATE" }, 400)
  if (stored.orgId !== org.orgId || stored.userId !== org.actor) {
    return json({ error: "STATE_SESSION_MISMATCH" }, 403)
  }
  await db.delete(googleOAuthState).where(eq(googleOAuthState.state, state))

  const c = requireConfig()
  const tokenRes = await googleFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  })
  const token = (await tokenRes.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
  } | null
  if (!tokenRes.ok || !token?.access_token) {
    return json({ error: token?.error ?? "TOKEN_EXCHANGE_FAILED" }, 400)
  }
  const grantedScopes = token.scope ?? stored.scopes
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000)
  const [existing] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  const values = {
    orgId: org.orgId,
    userId: org.actor,
    scopes: grantedScopes,
    accessToken: encryptToken(token.access_token),
    refreshToken: token.refresh_token ? encryptToken(token.refresh_token) : existing?.refreshToken,
    accessTokenExpiresAt: expiresAt,
    status: "connected",
    disconnectedAt: null,
    lastError: null,
  }
  const [connection] = existing
    ? await db
        .update(googleConnection)
        .set(values)
        .where(eq(googleConnection.id, existing.id))
        .returning()
    : await db.insert(googleConnection).values(values).returning()
  if (!connection) return json({ error: "CONNECTION_WRITE_FAILED" }, 500)
  await hydrateGoogleProfile(connection.id).catch(() => undefined)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "connect",
    detail: { scopes: grantedScopes },
  })
  const settings = await readIntegrationSettings(org.orgId)
  if (settings.googleSyncEnabled) {
    await syncGoogleConnection(connection.id).catch((error) =>
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
  if (settings.googleWatchEnabled) {
    await renewWatches(connection.id).catch(() => undefined)
  }
  return redirect(safeReturnTo(stored.returnTo))
}

async function hydrateGoogleProfile(connectionId: string) {
  const profile = await googleRequest<{ emailAddress?: string; historyId?: string }>(
    connectionId,
    `${GOOGLE_API}/gmail/v1/users/me/profile`,
  )
  const [row] = await db
    .select()
    .from(googleConnection)
    .where(eq(googleConnection.id, connectionId))
    .limit(1)
  if (!row) return
  await db
    .update(googleConnection)
    .set({
      email: profile.emailAddress ?? row.email,
      googleAccountId: profile.emailAddress ?? null,
    })
    .where(eq(googleConnection.id, connectionId))
  await db
    .insert(googleGmailSync)
    .values({ connectionId, historyId: profile.historyId ?? null })
    .onConflictDoUpdate({
      target: googleGmailSync.connectionId,
      set: { historyId: profile.historyId ?? null },
    })
}

export async function disconnectGoogle(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  if (!connection) return json({ ok: true })
  await stopCalendarWatch(connection.id).catch(() => undefined)
  await db
    .update(googleConnection)
    .set({
      status: "disconnected",
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      disconnectedAt: new Date(),
    })
    .where(eq(googleConnection.id, connection.id))
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "disconnect",
  })
  return json({ ok: true })
}

export async function googleStatus(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  // `configured` reflects server-side OAuth credentials: without them the
  // Connect flow can't start, so the UI shows the integration as disabled.
  const c = config()
  const configured = Boolean(c.clientId && c.clientSecret)
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  if (!connection) return json({ configured, connected: false })
  const [calendar] = await db
    .select()
    .from(googleCalendarSync)
    .where(eq(googleCalendarSync.connectionId, connection.id))
    .limit(1)
  const [gmail] = await db
    .select()
    .from(googleGmailSync)
    .where(eq(googleGmailSync.connectionId, connection.id))
    .limit(1)
  return json({
    configured,
    connected: connection.status === "connected",
    email: connection.email,
    scopes: [...toScopeList(connection.scopes)],
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
    calendarWatchExpiresAt: calendar?.watchExpiresAt ?? null,
    gmailWatchExpiresAt: gmail?.watchExpiration ?? null,
  })
}

export async function syncGoogleConnection(connectionId: string) {
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(eq(googleConnection.id, connectionId))
    .limit(1)
  if (connection?.status !== "connected") return
  if (hasScope(connection.scopes, GOOGLE_SCOPES.calendarEvents)) await syncCalendar(connection.id)
  if (hasScope(connection.scopes, GOOGLE_SCOPES.gmailMetadata)) await syncGmail(connection.id)
  await db
    .update(googleConnection)
    .set({ lastSyncAt: new Date(), lastError: null })
    .where(eq(googleConnection.id, connection.id))
}

export async function syncGoogleForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  if (!connection) return json({ error: "NO_GOOGLE_CONNECTION" }, 404)
  // The org toggle wins over a manual click: this handler is `resolveOrg`, so
  // without the check any member could sync past an admin's "sync off".
  if (!(await readIntegrationSettings(org.orgId)).googleSyncEnabled) {
    return json({ error: "SYNC_DISABLED" }, 403)
  }
  await syncGoogleConnection(connection.id)
  return json({ ok: true })
}

type CalendarEvent = {
  id: string
  etag?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  htmlLink?: string
  updated?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: unknown[]
}

/**
 * The org-local concept synced Calendar events mirror into, so the generic
 * Calendar/List widgets render them. Typed columns only — never the raw payload
 * or attendee PII. `externalId` (= Google event id) is the unique upsert key;
 * field display names are decorative (everything keys off field ids).
 */
const EVENT_CONCEPT: ProvisionConceptSpec = {
  name: "Google - Calendar Event",
  pluralName: "Google - Calendar Events",
  description: "Events synced from Google Calendar.",
  icon: "lucide:CalendarDays",
  color: "#0ea5e9",
  managedBy: "google.calendar",
  titleFieldKey: "title",
  fields: [
    { key: "externalId", name: "Event ID", kind: "text", config: { unique: true }, icon: "🔖" },
    { key: "title", name: "Title", kind: "text" },
    { key: "startsAt", name: "Starts", kind: "date", icon: "📅" },
    { key: "endsAt", name: "Ends", kind: "date" },
    { key: "location", name: "Location", kind: "text", icon: "📍" },
  ],
}

const googleScopeOf = (conn: typeof googleConnection.$inferSelect): OrgScope =>
  // A connector sync runs on no session at all — engine privilege, not a member.
  //
  // DELIBERATELY still exempt, unlike automations (which became scoped actors —
  // see `actorScope`). The actor here is `conn.userId`, the id of the PERSON who
  // connected the integration, so resolving a policy from it would make the sync
  // inherit that member's access: a connector set up by a member would silently stop
  // mirroring anything they cannot see. Scoping connectors properly needs a distinct
  // connector identity (e.g. `system:connector:<kind>`), which rewrites `events.actor`
  // for every synced row and so changes the activity feed and the one-hop automation
  // guard. That is its own change, not a rider on this one.
  systemScope(conn.orgId, conn.userId)

/** Ensure the org's Event concept exists; reuse the ids stored on the connection
 *  when present (so a later concept/field rename never re-provisions), else
 *  provision once and persist `{ conceptId, fieldMap }` back onto the row. */
async function ensureEventConcept(
  conn: typeof googleConnection.$inferSelect,
): Promise<ProvisionedConcept> {
  if (conn.conceptId && conn.fieldMap && Object.keys(conn.fieldMap).length > 0) {
    return { conceptId: conn.conceptId, fieldMap: conn.fieldMap }
  }
  const provisioned = await provisionConcept(googleScopeOf(conn), EVENT_CONCEPT)
  await db
    .update(googleConnection)
    .set({ conceptId: provisioned.conceptId, fieldMap: provisioned.fieldMap })
    .where(eq(googleConnection.id, conn.id))
  return provisioned
}

/** Map a Google event to a record version patch keyed by field id — typed columns
 *  only, never the raw payload or attendees (PII minimization). */
const eventFieldsFor = (
  event: CalendarEvent,
  fieldMap: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    const id = fieldMap[key]
    if (id && value !== undefined && value !== null && value !== "") out[id] = value
  }
  set("externalId", event.id)
  set("title", event.summary)
  set("startsAt", event.start?.dateTime ?? event.start?.date)
  set("endsAt", event.end?.dateTime ?? event.end?.date)
  set("location", event.location)
  return out
}

/** Mirror this connection's already-synced calendar events into the org's Event
 *  concept (idempotent, keyed by event id). Reads stored event rows only — the
 *  same backfill `mirrorGmailThreads` does. Projecting inline per fetched event
 *  only covered events seen during that sync; events stored before the concept
 *  projection existed (or banked behind a `syncToken`) were never re-fetched, so
 *  the concept stayed empty. Mirroring from the stored table closes that gap.
 *  Skips cancelled/deleted events, and skips events whose projected fields already
 *  match the live record version so an unchanged event doesn't append a redundant
 *  `RecordVersionUpdated` every sync (the event log would otherwise bloat at scale). */
async function mirrorCalendarEvents(
  conn: typeof googleConnection.$inferSelect,
  eventConcept: ProvisionedConcept,
) {
  const externalFieldId = eventConcept.fieldMap.externalId
  if (!externalFieldId) return
  const rows = await pool.query<{ google_event_id: string; raw: CalendarEvent }>(
    `SELECT google_event_id, raw FROM google_calendar_event
       WHERE connection_id = $1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'cancelled'`,
    [conn.id],
  )
  // Current projected state keyed by external id, so an unchanged event is skipped.
  const live = await pool.query<{ ext: string; state: Record<string, unknown> }>(
    `SELECT state->>$2 AS ext, state FROM record_versions
       WHERE org_id = $1 AND concept_id = $3 AND archived_at IS NULL
         AND version_status = 'published'`,
    [conn.orgId, externalFieldId, eventConcept.conceptId],
  )
  const stateByExt = new Map(live.rows.map((r) => [r.ext, r.state]))
  for (const row of rows.rows) {
    if (!row.google_event_id) continue
    const fields = eventFieldsFor(row.raw, eventConcept.fieldMap)
    const current = stateByExt.get(row.google_event_id)
    if (current && Object.entries(fields).every(([k, v]) => current[k] === v)) continue
    await upsertRecordVersionByExternalId(googleScopeOf(conn), {
      conceptId: eventConcept.conceptId,
      externalFieldId,
      externalValue: row.google_event_id,
      fields,
    })
  }
}

async function syncCalendar(connectionId: string, calendarId = "primary") {
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(eq(googleConnection.id, connectionId))
    .limit(1)
  if (!connection) return
  const eventConcept = await ensureEventConcept(connection)
  const [sync] = await db
    .select()
    .from(googleCalendarSync)
    .where(
      and(
        eq(googleCalendarSync.connectionId, connectionId),
        eq(googleCalendarSync.calendarId, calendarId),
      ),
    )
    .limit(1)
  let syncToken = sync?.syncToken ?? null
  const fetchPage = async (pageToken?: string) => {
    const u = new URL(
      `${GOOGLE_API}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    )
    u.searchParams.set("singleEvents", "true")
    u.searchParams.set("showDeleted", "true")
    u.searchParams.set("maxResults", "250")
    if (syncToken) u.searchParams.set("syncToken", syncToken)
    else
      u.searchParams.set("timeMin", new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())
    if (pageToken) u.searchParams.set("pageToken", pageToken)
    return googleRequest<{
      items?: CalendarEvent[]
      nextPageToken?: string
      nextSyncToken?: string
    }>(connectionId, u.toString())
  }
  let pageToken: string | undefined
  try {
    do {
      const page = await fetchPage(pageToken)
      for (const event of page.items ?? []) {
        await upsertCalendarEvent(connection, calendarId, event)
      }
      pageToken = page.nextPageToken
      if (page.nextSyncToken) syncToken = page.nextSyncToken
    } while (pageToken)
    // Project from the stored table (not just this sync's fetched delta) so a
    // valid syncToken — which never re-fetches past events — can't leave the
    // concept empty. Idempotent and skips unchanged events.
    await mirrorCalendarEvents(connection, eventConcept)
    await db
      .insert(googleCalendarSync)
      .values({ connectionId, calendarId, syncToken, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: [googleCalendarSync.connectionId, googleCalendarSync.calendarId],
        set: { syncToken, lastSyncedAt: new Date(), lastError: null },
      })
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId,
      action: "calendar.sync",
    })
  } catch (error) {
    if ((error as Error & { status?: number }).status === 410 && syncToken) {
      await db
        .update(googleCalendarSync)
        .set({ syncToken: null })
        .where(eq(googleCalendarSync.connectionId, connectionId))
      await syncCalendar(connectionId, calendarId)
      return
    }
    await db
      .insert(googleCalendarSync)
      // Sanitized: `lastError` reaches the client via `…/status`.
      .values({ connectionId, calendarId, lastError: publicConnectorError(error) })
      .onConflictDoUpdate({
        target: [googleCalendarSync.connectionId, googleCalendarSync.calendarId],
        set: { lastError: publicConnectorError(error) },
      })
    throw error
  }
}

async function upsertCalendarEvent(
  connection: typeof googleConnection.$inferSelect,
  calendarId: string,
  event: CalendarEvent,
) {
  const allDay = Boolean(event.start?.date && !event.start.dateTime)
  const startAt = event.start?.dateTime ?? event.start?.date
  const endAt = event.end?.dateTime ?? event.end?.date
  const deletedAt = event.status === "cancelled" ? new Date() : null
  await db
    .insert(googleCalendarEvent)
    .values({
      connectionId: connection.id,
      orgId: connection.orgId,
      userId: connection.userId,
      calendarId,
      googleEventId: event.id,
      etag: event.etag ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      htmlLink: event.htmlLink ?? null,
      startAt: startAt ? new Date(startAt) : null,
      endAt: endAt ? new Date(endAt) : null,
      allDay,
      attendees: event.attendees ?? [],
      raw: event,
      googleUpdatedAt: event.updated ? new Date(event.updated) : null,
      deletedAt,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        googleCalendarEvent.connectionId,
        googleCalendarEvent.calendarId,
        googleCalendarEvent.googleEventId,
      ],
      set: {
        etag: event.etag ?? null,
        status: event.status ?? null,
        summary: event.summary ?? null,
        description: event.description ?? null,
        location: event.location ?? null,
        htmlLink: event.htmlLink ?? null,
        startAt: startAt ? new Date(startAt) : null,
        endAt: endAt ? new Date(endAt) : null,
        allDay,
        attendees: event.attendees ?? [],
        raw: event,
        googleUpdatedAt: event.updated ? new Date(event.updated) : null,
        deletedAt,
        syncedAt: new Date(),
      },
    })
}

type GmailMessage = {
  id: string
  threadId: string
  historyId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
    body?: { data?: string }
    parts?: unknown[]
  }
}

const header = (msg: GmailMessage, name: string) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null

/**
 * The org-local concept synced Gmail threads mirror into, so the generic
 * List/Calendar widgets render them. METADATA ONLY — subject, sender, and last-
 * message time; never message bodies or snippets (PII minimization). `externalId`
 * (= Gmail thread id) is the unique upsert key; field names are decorative.
 */
const EMAIL_CONCEPT: ProvisionConceptSpec = {
  name: "Google - Email",
  pluralName: "Google - Emails",
  description: "Email threads synced from Gmail (metadata only).",
  icon: "lucide:Mail",
  color: "#ef4444",
  managedBy: "google.gmail",
  titleFieldKey: "subject",
  fields: [
    { key: "externalId", name: "Thread ID", kind: "text", config: { unique: true }, icon: "🔖" },
    { key: "subject", name: "Subject", kind: "text" },
    { key: "from", name: "From", kind: "text", icon: "👤" },
    { key: "lastMessageAt", name: "Last message", kind: "date", icon: "📅" },
  ],
}

/** Ensure the org's Email concept exists; reuse the ids on the connection's gmail
 *  columns when present, else provision once and persist them back. */
async function ensureEmailConcept(
  conn: typeof googleConnection.$inferSelect,
): Promise<ProvisionedConcept> {
  if (conn.gmailConceptId && conn.gmailFieldMap && Object.keys(conn.gmailFieldMap).length > 0) {
    return { conceptId: conn.gmailConceptId, fieldMap: conn.gmailFieldMap }
  }
  const provisioned = await provisionConcept(googleScopeOf(conn), EMAIL_CONCEPT)
  await db
    .update(googleConnection)
    .set({ gmailConceptId: provisioned.conceptId, gmailFieldMap: provisioned.fieldMap })
    .where(eq(googleConnection.id, conn.id))
  return provisioned
}

/** One synced Gmail thread's metadata row (from `google_gmail_thread`). */
type GmailThreadRow = {
  thread_id: string
  subject: string | null
  from_email: string | null
  last_message_at: Date | null
}

/** Map a thread's metadata to a record version patch keyed by field id — subject,
 *  sender, and last-message time only; never bodies or snippets. */
const emailFieldsFor = (
  t: GmailThreadRow,
  fieldMap: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    const id = fieldMap[key]
    if (id && value !== undefined && value !== null && value !== "") out[id] = value
  }
  set("externalId", t.thread_id)
  set("subject", t.subject)
  set("from", t.from_email)
  set("lastMessageAt", t.last_message_at ? t.last_message_at.toISOString() : null)
  return out
}

/** Mirror this connection's already-synced Gmail threads into the org's Email
 *  concept (idempotent, keyed by thread id). Reads stored thread metadata only —
 *  never re-fetches or stores message bodies. */
async function mirrorGmailThreads(conn: typeof googleConnection.$inferSelect) {
  const emailConcept = await ensureEmailConcept(conn)
  const externalFieldId = emailConcept.fieldMap.externalId
  if (!externalFieldId) return
  const rows = await pool.query<GmailThreadRow>(
    `SELECT thread_id, subject, from_email, last_message_at
       FROM google_gmail_thread
      WHERE connection_id = $1 AND deleted_at IS NULL`,
    [conn.id],
  )
  for (const t of rows.rows) {
    if (!t.thread_id) continue
    await upsertRecordVersionByExternalId(googleScopeOf(conn), {
      conceptId: emailConcept.conceptId,
      externalFieldId,
      externalValue: t.thread_id,
      fields: emailFieldsFor(t, emailConcept.fieldMap),
    })
  }
}

async function syncGmail(connectionId: string) {
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(eq(googleConnection.id, connectionId))
    .limit(1)
  if (!connection) return
  const [sync] = await db
    .select()
    .from(googleGmailSync)
    .where(eq(googleGmailSync.connectionId, connectionId))
    .limit(1)
  // Only go incremental once a full backfill has actually run. `historyId` alone
  // isn't enough: `hydrateGoogleProfile` seeds it at connect time, so without the
  // `lastFullSyncAt` guard the first sync would take the history path from "now"
  // and pull zero messages — leaving the inbox empty until something changes.
  if (sync?.historyId && sync.lastFullSyncAt) {
    try {
      await syncGmailHistory(connection, sync.historyId)
      await mirrorGmailThreads(connection)
      return
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 404) throw error
    }
  }
  await fullSyncGmail(connection)
  await mirrorGmailThreads(connection)
}

async function fullSyncGmail(connection: typeof googleConnection.$inferSelect) {
  // The `q` (search) param requires read scope — with gmail.metadata alone Gmail
  // returns 403 "Metadata scope does not support 'q' parameter". So date-filter
  // (newer_than:90d) only when we have readonly; otherwise list the most-recent
  // messages unfiltered and cap the backfill (no server-side date filter).
  const canSearch = hasScope(connection.scopes, GOOGLE_SCOPES.gmailReadonly)
  const MAX_BACKFILL = 500
  let pageToken: string | undefined
  let newestHistoryId: string | null = null
  let fetched = 0
  do {
    const u = new URL(`${GOOGLE_API}/gmail/v1/users/me/messages`)
    u.searchParams.set("maxResults", "50")
    if (canSearch) u.searchParams.set("q", "newer_than:90d")
    if (pageToken) u.searchParams.set("pageToken", pageToken)
    const page = await googleRequest<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      connection.id,
      u.toString(),
    )
    for (const record of page.messages ?? []) {
      const msg = await fetchGmailMessage(connection.id, record.id, "metadata")
      newestHistoryId = newestHistoryId ?? msg.historyId ?? null
      await upsertGmailMessage(connection, msg)
      fetched++
    }
    pageToken = page.nextPageToken
    if (!canSearch && fetched >= MAX_BACKFILL) break
  } while (pageToken)
  await db
    .insert(googleGmailSync)
    .values({
      connectionId: connection.id,
      historyId: newestHistoryId,
      lastFullSyncAt: new Date(),
      lastSyncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: googleGmailSync.connectionId,
      set: {
        historyId: newestHistoryId,
        lastFullSyncAt: new Date(),
        lastSyncedAt: new Date(),
        lastError: null,
      },
    })
  await audit({
    orgId: connection.orgId,
    userId: connection.userId,
    connectionId: connection.id,
    action: "gmail.sync.full",
  })
}

async function syncGmailHistory(
  connection: typeof googleConnection.$inferSelect,
  startHistoryId: string,
) {
  let pageToken: string | undefined
  let newestHistoryId = startHistoryId
  do {
    const u = new URL(`${GOOGLE_API}/gmail/v1/users/me/history`)
    u.searchParams.set("startHistoryId", startHistoryId)
    u.searchParams.set("historyTypes", "messageAdded")
    u.searchParams.append("historyTypes", "labelAdded")
    u.searchParams.append("historyTypes", "labelRemoved")
    if (pageToken) u.searchParams.set("pageToken", pageToken)
    const page = await googleRequest<{
      historyId?: string
      history?: Array<{
        messages?: Array<{ id: string }>
        messagesAdded?: Array<{ message: { id: string } }>
        labelsAdded?: Array<{ message: { id: string } }>
        labelsRemoved?: Array<{ message: { id: string } }>
      }>
      nextPageToken?: string
    }>(connection.id, u.toString())
    newestHistoryId = page.historyId ?? newestHistoryId
    const ids = new Set<string>()
    for (const h of page.history ?? []) {
      for (const m of h.messages ?? []) ids.add(m.id)
      for (const m of h.messagesAdded ?? []) ids.add(m.message.id)
      for (const m of h.labelsAdded ?? []) ids.add(m.message.id)
      for (const m of h.labelsRemoved ?? []) ids.add(m.message.id)
    }
    for (const id of ids) {
      const msg = await fetchGmailMessage(connection.id, id, "metadata").catch((error) => {
        if ((error as Error & { status?: number }).status === 404) return null
        throw error
      })
      if (msg) await upsertGmailMessage(connection, msg)
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  await db
    .insert(googleGmailSync)
    .values({ connectionId: connection.id, historyId: newestHistoryId, lastSyncedAt: new Date() })
    .onConflictDoUpdate({
      target: googleGmailSync.connectionId,
      set: { historyId: newestHistoryId, lastSyncedAt: new Date(), lastError: null },
    })
  await audit({
    orgId: connection.orgId,
    userId: connection.userId,
    connectionId: connection.id,
    action: "gmail.sync.incremental",
  })
}

async function fetchGmailMessage(connectionId: string, id: string, format: "metadata" | "full") {
  const u = new URL(`${GOOGLE_API}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)
  u.searchParams.set("format", format)
  if (format === "metadata") {
    for (const h of ["From", "To", "Subject", "Date"]) u.searchParams.append("metadataHeaders", h)
  }
  return googleRequest<GmailMessage>(connectionId, u.toString())
}

async function upsertGmailMessage(
  connection: typeof googleConnection.$inferSelect,
  msg: GmailMessage,
  includeBody = false,
) {
  const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)) : null
  const subject = header(msg, "Subject")
  const fromEmail = header(msg, "From")
  const toEmail = header(msg, "To")
  const bodyText = includeBody ? extractBody(msg, "text/plain") : null
  const bodyHtml = includeBody ? extractBody(msg, "text/html") : null
  await db
    .insert(googleGmailMessage)
    .values({
      connectionId: connection.id,
      orgId: connection.orgId,
      userId: connection.userId,
      messageId: msg.id,
      threadId: msg.threadId,
      historyId: msg.historyId ?? null,
      subject,
      fromEmail,
      toEmail,
      sentAt,
      snippet: msg.snippet ?? null,
      labelIds: msg.labelIds ?? [],
      payload: msg.payload ?? {},
      bodyText,
      bodyHtml,
      raw: msg,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [googleGmailMessage.connectionId, googleGmailMessage.messageId],
      set: {
        historyId: msg.historyId ?? null,
        subject,
        fromEmail,
        toEmail,
        sentAt,
        snippet: msg.snippet ?? null,
        labelIds: msg.labelIds ?? [],
        payload: msg.payload ?? {},
        bodyText,
        bodyHtml,
        raw: msg,
        syncedAt: new Date(),
      },
    })
  await db
    .insert(googleGmailThread)
    .values({
      connectionId: connection.id,
      orgId: connection.orgId,
      userId: connection.userId,
      threadId: msg.threadId,
      historyId: msg.historyId ?? null,
      subject,
      snippet: msg.snippet ?? null,
      fromEmail,
      lastMessageAt: sentAt,
      labelIds: msg.labelIds ?? [],
      raw: msg,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [googleGmailThread.connectionId, googleGmailThread.threadId],
      set: {
        historyId: msg.historyId ?? null,
        subject,
        snippet: msg.snippet ?? null,
        fromEmail,
        lastMessageAt: sentAt,
        labelIds: msg.labelIds ?? [],
        raw: msg,
        syncedAt: new Date(),
      },
    })
}

function extractBody(msg: GmailMessage, mimeType: string): string | null {
  const stack = [msg.payload, ...(((msg.payload?.parts as GmailMessage["payload"][]) ?? []) as [])]
  for (const part of stack) {
    if (!part) continue
    const p = part as GmailMessage["payload"] & { mimeType?: string; parts?: unknown[] }
    if (p.mimeType === mimeType && p.body?.data) {
      return Buffer.from(p.body.data, "base64url").toString("utf8")
    }
    if (Array.isArray(p.parts)) stack.push(...(p.parts as GmailMessage["payload"][]))
  }
  return null
}

export async function listGoogleCalendar(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const rows = await pool.query(
    `SELECT e.google_event_id AS id, e.summary, e.description, e.location, e.start_at, e.end_at,
            e.all_day, e.attendees, e.html_link, e.status, e.deleted_at
       FROM google_calendar_event e
       JOIN google_connection c ON c.id = e.connection_id
      WHERE c.org_id = $1 AND c.user_id = $2 AND c.status = 'connected' AND e.deleted_at IS NULL
      ORDER BY e.start_at NULLS LAST
      LIMIT 200`,
    [org.orgId, org.actor],
  )
  return json({ events: rows.rows })
}

export async function listGoogleThreads(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const rows = await pool.query(
    `SELECT t.thread_id AS id, t.subject, t.snippet, t.from_email, t.last_message_at, t.label_ids
       FROM google_gmail_thread t
       JOIN google_connection c ON c.id = t.connection_id
      WHERE c.org_id = $1 AND c.user_id = $2 AND c.status = 'connected' AND t.deleted_at IS NULL
      ORDER BY t.last_message_at DESC NULLS LAST
      LIMIT 100`,
    [org.orgId, org.actor],
  )
  return json({ threads: rows.rows })
}

export async function getGoogleThread(req: Request, threadId: string) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  if (!connection) return json({ error: "NO_GOOGLE_CONNECTION" }, 404)
  if (!hasScope(connection.scopes, GOOGLE_SCOPES.gmailReadonly)) {
    return json({ error: "GMAIL_READ_SCOPE_REQUIRED" }, 403)
  }
  const messages = await pool.query<{ message_id: string }>(
    `SELECT message_id FROM google_gmail_message
      WHERE connection_id = $1 AND thread_id = $2 AND deleted_at IS NULL
      ORDER BY sent_at ASC NULLS LAST`,
    [connection.id, threadId],
  )
  for (const row of messages.rows) {
    const msg = await fetchGmailMessage(connection.id, row.message_id, "full")
    await upsertGmailMessage(connection, msg, true)
  }
  const rows = await pool.query(
    `SELECT message_id AS id, subject, from_email, to_email, sent_at, snippet, body_text, body_html, label_ids
       FROM google_gmail_message
      WHERE connection_id = $1 AND thread_id = $2 AND deleted_at IS NULL
      ORDER BY sent_at ASC NULLS LAST`,
    [connection.id, threadId],
  )
  return json({ messages: rows.rows })
}

export async function sendGoogleMail(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  if (!connection) return json({ error: "NO_GOOGLE_CONNECTION" }, 404)
  if (!hasScope(connection.scopes, GOOGLE_SCOPES.gmailSend)) {
    return json({ error: "GMAIL_SEND_SCOPE_REQUIRED" }, 403)
  }
  const body = (await req.json().catch(() => null)) as {
    to?: string
    subject?: string
    text?: string
    threadId?: string
  } | null
  if (!body?.to || !body.subject || !body.text) return json({ error: "INVALID_MAIL" }, 400)
  const raw = Buffer.from(
    [
      `To: ${body.to}`,
      `Subject: ${body.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body.text,
    ].join("\r\n"),
  ).toString("base64url")
  const sent = await googleRequest<{ id: string; threadId?: string }>(
    connection.id,
    `${GOOGLE_API}/gmail/v1/users/me/messages/send`,
    {
      method: "POST",
      body: JSON.stringify({ raw, threadId: body.threadId }),
    },
  )
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "gmail.send",
    subjectKind: "gmail_message",
    subjectId: sent.id,
  })
  await syncGmail(connection.id).catch(() => undefined)
  return json({ id: sent.id, threadId: sent.threadId ?? body.threadId ?? null })
}

export async function upsertGoogleCalendarEvent(req: Request, eventId?: string) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const [connection] = await db
    .select()
    .from(googleConnection)
    .where(and(eq(googleConnection.orgId, org.orgId), eq(googleConnection.userId, org.actor)))
    .limit(1)
  if (!connection) return json({ error: "NO_GOOGLE_CONNECTION" }, 404)
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return json({ error: "INVALID_EVENT" }, 400)
  const url = eventId
    ? `${GOOGLE_API}/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`
    : `${GOOGLE_API}/calendar/v3/calendars/primary/events`
  const event = await googleRequest<CalendarEvent>(connection.id, url, {
    method: eventId ? "PATCH" : "POST",
    body: JSON.stringify(body),
  })
  await upsertCalendarEvent(connection, "primary", event)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: eventId ? "calendar.update" : "calendar.create",
    subjectKind: "calendar_event",
    subjectId: event.id,
  })
  return json({ id: event.id })
}

/**
 * Gmail push receiver (Google Pub/Sub → us). Pub/Sub POSTs carry no signature, so
 * the shared `GOOGLE_PUBSUB_VERIFICATION_TOKEN` is the ONLY authenticator: it is
 * appended to the push endpoint URL registered in Pub/Sub (`?token=…`) and
 * compared timing-safely here.
 *
 * It used to be read into `config()` and never checked, which left this endpoint
 * fully unauthenticated — any caller who knew (or guessed) a connected user's
 * address could force unbounded Gmail syncs for them. When the token is unset the
 * endpoint now refuses everything rather than falling open, because an
 * unauthenticated sync trigger is worse than a disabled one.
 */
export async function handleGmailPush(req: Request) {
  const expected = config().pubsubVerificationToken
  if (!expected) return json({ error: "PUSH_NOT_CONFIGURED" }, 503)
  const url = new URL(req.url)
  const provided = url.searchParams.get("token") ?? bearerToken(req)
  if (!provided || !secretMatches(provided, expected)) {
    return json({ error: "INVALID_TOKEN" }, 401)
  }
  const body = (await req.json().catch(() => null)) as {
    message?: { messageId?: string; data?: string }
  } | null
  const key = body?.message?.messageId ? `gmail:${body.message.messageId}` : null
  if (!key || !(await markNotification(key, "gmail"))) return json({ ok: true })
  const decoded = body?.message?.data
    ? JSON.parse(Buffer.from(body.message.data, "base64url").toString("utf8"))
    : null
  const email = decoded?.emailAddress
  if (typeof email !== "string") return json({ error: "BAD_GMAIL_PUSH" }, 400)
  const rows = await db.select().from(googleConnection).where(eq(googleConnection.email, email))
  // Per row, not once: one address can be connected in several orgs, and each
  // org's toggle is its own. KNOWN GAP — `markNotification` above burns the
  // dedupe key before any org is known, so a push arriving while an org has sync
  // off is dropped rather than replayed on re-enable. The notification is a ping,
  // not the data; the next push or a manual sync picks the mail up.
  for (const row of rows) {
    if (!(await readIntegrationSettings(row.orgId)).googleSyncEnabled) continue
    await syncGmail(row.id).catch(() => undefined)
  }
  return json({ ok: true })
}

export async function handleCalendarPush(req: Request) {
  const channelId = req.headers.get("x-goog-channel-id")
  const channelToken = req.headers.get("x-goog-channel-token")
  const messageNumber = req.headers.get("x-goog-message-number")
  const state = req.headers.get("x-goog-resource-state")
  if (!channelId || !messageNumber) return json({ error: "BAD_CALENDAR_PUSH" }, 400)
  const key = `calendar:${channelId}:${messageNumber}`
  if (!(await markNotification(key, "calendar"))) return json({ ok: true })
  const [sync] = await db
    .select()
    .from(googleCalendarSync)
    .where(eq(googleCalendarSync.watchChannelId, channelId))
    .limit(1)
  if (!sync || sync.watchToken !== channelToken) return json({ error: "BAD_CHANNEL" }, 403)
  if (state !== "sync") {
    // The sync row carries only `connectionId`, so the org costs one lookup —
    // taken after the channel-token check so a disabled org still 403s a forged
    // channel, and only on real notifications (never the initial "sync" ping).
    const [conn] = await db
      .select({ orgId: googleConnection.orgId })
      .from(googleConnection)
      .where(eq(googleConnection.id, sync.connectionId))
      .limit(1)
    if (conn && (await readIntegrationSettings(conn.orgId)).googleSyncEnabled) {
      await syncCalendar(sync.connectionId, sync.calendarId).catch(() => undefined)
    }
  }
  return json({ ok: true })
}

async function markNotification(key: string, kind: string) {
  try {
    await db.insert(googleNotification).values({
      key,
      kind,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    return true
  } catch {
    return false
  }
}

export async function renewWatches(connectionId: string) {
  await renewCalendarWatch(connectionId)
  await renewGmailWatch(connectionId)
}

async function renewCalendarWatch(connectionId: string) {
  const c = config()
  if (!c.webhookBaseUrl) return
  const channelId = randomUUID()
  const token = randomUUID()
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000
  const res = await googleRequest<{ id: string; resourceId?: string; expiration?: string }>(
    connectionId,
    `${GOOGLE_API}/calendar/v3/calendars/primary/events/watch`,
    {
      method: "POST",
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: `${c.webhookBaseUrl}/api/integrations/google/calendar/push`,
        token,
        expiration,
      }),
    },
  )
  await db
    .insert(googleCalendarSync)
    .values({
      connectionId,
      calendarId: "primary",
      watchChannelId: res.id ?? channelId,
      watchResourceId: res.resourceId ?? null,
      watchToken: token,
      watchExpiresAt: res.expiration ? new Date(Number(res.expiration)) : new Date(expiration),
    })
    .onConflictDoUpdate({
      target: [googleCalendarSync.connectionId, googleCalendarSync.calendarId],
      set: {
        watchChannelId: res.id ?? channelId,
        watchResourceId: res.resourceId ?? null,
        watchToken: token,
        watchExpiresAt: res.expiration ? new Date(Number(res.expiration)) : new Date(expiration),
      },
    })
}

async function renewGmailWatch(connectionId: string) {
  const c = config()
  if (!c.pubsubTopic) return
  const res = await googleRequest<{ historyId?: string; expiration?: string }>(
    connectionId,
    `${GOOGLE_API}/gmail/v1/users/me/watch`,
    {
      method: "POST",
      body: JSON.stringify({
        topicName: c.pubsubTopic,
        labelFilterBehavior: "include",
        labelIds: ["INBOX", "SENT"],
      }),
    },
  )
  await db
    .insert(googleGmailSync)
    .values({
      connectionId,
      historyId: res.historyId ?? null,
      watchExpiration: res.expiration ? new Date(Number(res.expiration)) : null,
    })
    .onConflictDoUpdate({
      target: googleGmailSync.connectionId,
      set: {
        historyId: res.historyId ?? null,
        watchExpiration: res.expiration ? new Date(Number(res.expiration)) : null,
      },
    })
}

async function stopCalendarWatch(connectionId: string) {
  const [sync] = await db
    .select()
    .from(googleCalendarSync)
    .where(eq(googleCalendarSync.connectionId, connectionId))
    .limit(1)
  if (!sync?.watchChannelId || !sync.watchResourceId) return
  await googleRequest(connectionId, `${GOOGLE_API}/calendar/v3/channels/stop`, {
    method: "POST",
    body: JSON.stringify({ id: sync.watchChannelId, resourceId: sync.watchResourceId }),
  })
}

/**
 * Hourly watch renewal.
 *
 * There is deliberately NO boot-time env gate any more. The old
 * `GOOGLE_WATCH_ENABLED !== "1"` check returned before `setInterval` was ever
 * scheduled, so on the deployments that never opted in — exactly the population
 * a per-org toggle exists for — no org could ever turn watches on. The env var
 * survives as the per-org DEFAULT (still opt-in, still `=== "1"`), so a
 * deployment that never set it renews exactly nothing; the cost is one indexed
 * query an hour that skips every row it finds.
 *
 * Filtering is in TS rather than the SQL because "row absent OR column true"
 * depends on which way the env default points — encoding that in a SQL string
 * would duplicate the polarity into the one place it's most likely to drift.
 */
export function startGoogleWatchRenewal() {
  const run = async () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const rows = await pool.query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM google_connection WHERE status = 'connected' AND id IN (
         SELECT connection_id FROM google_calendar_sync WHERE watch_expires_at IS NULL OR watch_expires_at < $1
         UNION
         SELECT connection_id FROM google_gmail_sync WHERE watch_expiration IS NULL OR watch_expiration < $1
       )`,
      [soon],
    )
    for (const row of rows.rows) {
      if (!(await readIntegrationSettings(row.org_id)).googleWatchEnabled) continue
      await renewWatches(row.id).catch(() => undefined)
    }
  }
  void run()
  setInterval(() => void run(), 60 * 60 * 1000).unref()
}
