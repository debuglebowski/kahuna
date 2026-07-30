import { createHash, randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import {
  posthogAuditLog,
  posthogConnection,
  posthogPersonMetric,
  posthogWebhookEvent,
} from "#db"
import { db, pool } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import { resolveOrg } from "./session"

/**
 * PostHog connector — the first key-based (non-OAuth) integration, and the
 * template the later ones reuse. Auth is a project/personal API key stored
 * ENCRYPTED at the org level (one connection per org). Mirrors `google.ts`:
 * a region-aware request helper with 429/5xx retry+backoff, connect/status/
 * disconnect/sync handlers, an audit log, and a fetch-injection test seam.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** Region preset → REST API base URL. `custom` keeps the host the caller sent. */
const REGION_HOSTS: Record<string, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
}

/** Resolve a region + optional explicit host into a validated https base URL. */
const resolveHost = (region: string | undefined, rawHost: string | undefined): string | null => {
  const preset = region && REGION_HOSTS[region]
  const candidate = (preset || rawHost || "").trim().replace(/\/+$/, "")
  if (!candidate) return null
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== "https:") return null
  return url.origin
}

type PosthogFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>
let posthogFetch: PosthogFetch = fetch

export const setPosthogFetchForTest = (next: PosthogFetch) => {
  posthogFetch = next
}

type RequestCtx = { host: string; apiKey: string }

/**
 * Authenticated PostHog REST call. `pathOrUrl` may be a path (`/api/projects/`)
 * — prefixed with the connection host — or an absolute URL (e.g. the `next`
 * cursor link the persons API returns). Retries 429/5xx up to 3× with backoff,
 * honoring `Retry-After`, just like `googleRequest`.
 */
export async function posthogRequest<T>(
  ctx: RequestCtx,
  pathOrUrl: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${ctx.host}${pathOrUrl}`
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${ctx.apiKey}`)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const res = await posthogFetch(url, { ...init, headers })
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after"))
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 300 * 2 ** attempt
    await new Promise((resolve) => setTimeout(resolve, delay))
    return posthogRequest<T>(ctx, pathOrUrl, init, attempt + 1)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const err = new Error(`PostHog API ${res.status}: ${detail}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function audit(input: {
  orgId: string
  userId: string
  connectionId?: string | null
  action: string
  status?: "ok" | "error"
  subjectKind?: string | null
  subjectId?: string | null
  detail?: unknown
}) {
  await db.insert(posthogAuditLog).values({
    orgId: input.orgId,
    userId: input.userId,
    connectionId: input.connectionId ?? null,
    action: input.action,
    status: input.status ?? "ok",
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    detail: input.detail ?? {},
  })
}

const connectionForOrg = async (orgId: string) => {
  const [row] = await db
    .select()
    .from(posthogConnection)
    .where(eq(posthogConnection.orgId, orgId))
    .limit(1)
  return row ?? null
}

const ctxFor = (conn: typeof posthogConnection.$inferSelect): RequestCtx => {
  const apiKey = decryptToken(conn.apiKey)
  if (!apiKey) throw new Error("PostHog connection has no API key")
  return { host: conn.host, apiKey }
}

/** The org's PostHog connection, only when usable (connected + has a key).
 *  Shared with the analytics query surface (`analytics.ts`). */
export const posthogConnectionForOrg = async (orgId: string) => {
  const row = await connectionForOrg(orgId)
  return row?.status === "connected" ? row : null
}

/** Build an authenticated request ctx from a connection row. */
export const posthogCtxFor = (conn: typeof posthogConnection.$inferSelect): RequestCtx =>
  ctxFor(conn)

type PosthogProject = { id: number | string; name?: string }

/**
 * Validate a key by listing the projects it can access, then resolve the
 * project to bind: the one the caller named, or the first available.
 */
async function resolveProject(
  ctx: RequestCtx,
  projectId: string | undefined,
): Promise<{ id: string; name: string | null }> {
  const data = await posthogRequest<{ results?: PosthogProject[] }>(ctx, "/api/projects/")
  const projects = data.results ?? []
  if (projects.length === 0) {
    const err = new Error("PostHog key has no accessible projects")
    ;(err as Error & { code?: string }).code = "NO_PROJECTS"
    throw err
  }
  if (projectId) {
    const match = projects.find((p) => String(p.id) === String(projectId))
    if (!match) {
      const err = new Error(`PostHog project ${projectId} not found`)
      ;(err as Error & { code?: string }).code = "PROJECT_NOT_FOUND"
      throw err
    }
    return { id: String(match.id), name: match.name ?? null }
  }
  const first = projects[0]!
  return { id: String(first.id), name: first.name ?? null }
}

export async function connectPosthog(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const body = (await req.json().catch(() => null)) as {
    apiKey?: string
    host?: string
    region?: string
    projectId?: string
  } | null
  const apiKey = body?.apiKey?.trim()
  if (!apiKey) return json({ error: "API_KEY_REQUIRED" }, 400)
  const region = body?.region === "eu" ? "eu" : body?.region === "custom" ? "custom" : "us"
  const host = resolveHost(region === "custom" ? "custom" : region, body?.host)
  if (!host) return json({ error: "INVALID_HOST" }, 400)

  let project: { id: string; name: string | null }
  try {
    project = await resolveProject({ host, apiKey }, body?.projectId?.trim() || undefined)
  } catch (error) {
    const code = (error as Error & { code?: string; status?: number }).code
    if (code === "NO_PROJECTS" || code === "PROJECT_NOT_FOUND") return json({ error: code }, 400)
    // Bad key / unreachable host → surface as an auth failure, not a 500.
    return json({ error: "INVALID_API_KEY", detail: String(error) }, 400)
  }

  const existing = await connectionForOrg(org.orgId)
  const values = {
    orgId: org.orgId,
    userId: org.actor,
    host,
    region,
    projectId: project.id,
    projectName: project.name,
    apiKey: encryptToken(apiKey),
    webhookToken: existing?.webhookToken ?? randomUUID(),
    status: "connected",
    disconnectedAt: null,
    lastError: null,
  }
  const [connection] = existing
    ? await db
        .update(posthogConnection)
        .set(values)
        .where(eq(posthogConnection.id, existing.id))
        .returning()
    : await db.insert(posthogConnection).values(values).returning()
  if (!connection) return json({ error: "CONNECTION_WRITE_FAILED" }, 500)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "connect",
    detail: { projectId: project.id, region },
  })
  if (process.env.POSTHOG_SYNC_ENABLED !== "0") {
    await syncPosthogConnection(connection.id).catch((error) =>
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
  return statusPayload(req)
}

export async function disconnectPosthog(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ ok: true })
  await db
    .update(posthogConnection)
    .set({ status: "disconnected", apiKey: null, disconnectedAt: new Date() })
    .where(eq(posthogConnection.id, connection.id))
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "disconnect",
  })
  return json({ ok: true })
}

const webhookUrlFor = (token: string | null | undefined): string | null => {
  if (!token) return null
  const base = process.env.POSTHOG_WEBHOOK_BASE_URL ?? process.env.BETTER_AUTH_URL ?? ""
  const path = `/api/integrations/posthog/webhook?token=${encodeURIComponent(token)}`
  return base ? `${base.replace(/\/+$/, "")}${path}` : path
}

async function statusPayload(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  // PostHog auth is a per-org key (no server-side OAuth creds), so it is never
  // "disabled" the way Google is — `configured` is always true.
  if (connection?.status !== "connected") {
    return json({ configured: true, connected: false })
  }
  return json({
    configured: true,
    connected: true,
    host: connection.host,
    region: connection.region,
    projectId: connection.projectId,
    projectName: connection.projectName,
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
    webhookUrl: webhookUrlFor(connection.webhookToken),
  })
}

export const posthogStatus = (req: Request) => statusPayload(req)

export async function syncPosthogForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ error: "NO_POSTHOG_CONNECTION" }, 404)
  await syncPosthogConnection(connection.id)
  return json({ ok: true })
}

type PosthogPerson = {
  id?: number | string
  uuid?: string
  name?: string
  distinct_ids?: string[]
  properties?: Record<string, unknown> | null
  created_at?: string
  last_seen_at?: string
}

type EventAgg = { eventCount: number; firstSeen: string | null; lastSeen: string | null }

/** Per-distinct_id event aggregates via the HogQL query API. */
async function fetchEventAggregates(
  ctx: RequestCtx,
  projectId: string,
): Promise<Map<string, EventAgg>> {
  const out = new Map<string, EventAgg>()
  const query =
    "SELECT distinct_id, count() AS event_count, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events GROUP BY distinct_id LIMIT 10000"
  const data = await posthogRequest<{ results?: unknown[][]; columns?: string[] }>(
    ctx,
    `/api/projects/${encodeURIComponent(projectId)}/query/`,
    { method: "POST", body: JSON.stringify({ query: { kind: "HogQLQuery", query } }) },
  )
  const cols = data.columns ?? ["distinct_id", "event_count", "first_seen", "last_seen"]
  const idx = (name: string, fallback: number) => {
    const i = cols.indexOf(name)
    return i === -1 ? fallback : i
  }
  const di = idx("distinct_id", 0)
  const ci = idx("event_count", 1)
  const fi = idx("first_seen", 2)
  const li = idx("last_seen", 3)
  for (const row of data.results ?? []) {
    const distinctId = row[di]
    if (typeof distinctId !== "string") continue
    out.set(distinctId, {
      eventCount: Number(row[ci]) || 0,
      firstSeen: typeof row[fi] === "string" ? (row[fi] as string) : null,
      lastSeen: typeof row[li] === "string" ? (row[li] as string) : null,
    })
  }
  return out
}

const asDate = (value: string | null | undefined): Date | null => {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

const maxDate = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (a > b ? a : b) : (a ?? b)
const minDate = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (a < b ? a : b) : (a ?? b)

export async function syncPosthogConnection(connectionId: string) {
  const [connection] = await db
    .select()
    .from(posthogConnection)
    .where(eq(posthogConnection.id, connectionId))
    .limit(1)
  if (connection?.status !== "connected") return
  const ctx = ctxFor(connection)
  try {
    const aggregates = await fetchEventAggregates(ctx, connection.projectId).catch(() => new Map())
    let next: string | null = `/api/projects/${encodeURIComponent(connection.projectId)}/persons/`
    let pages = 0
    while (next && pages < 100) {
      const page: { results?: PosthogPerson[]; next?: string | null } = await posthogRequest(
        ctx,
        next,
      )
      for (const person of page.results ?? []) {
        await upsertPersonMetric(connection, person, aggregates.get(person.distinct_ids?.[0] ?? ""))
      }
      next = page.next ?? null
      pages += 1
    }
    await db
      .update(posthogConnection)
      .set({ lastSyncAt: new Date(), lastError: null })
      .where(eq(posthogConnection.id, connection.id))
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "sync",
    })
  } catch (error) {
    await db
      .update(posthogConnection)
      .set({ lastError: String(error) })
      .where(eq(posthogConnection.id, connection.id))
    throw error
  }
}

async function upsertPersonMetric(
  connection: typeof posthogConnection.$inferSelect,
  person: PosthogPerson,
  agg: EventAgg | undefined,
) {
  const distinctId = person.distinct_ids?.[0]
  if (!distinctId) return
  const properties = person.properties ?? {}
  const email = typeof properties.email === "string" ? properties.email : null
  const firstSeen = minDate(asDate(person.created_at), asDate(agg?.firstSeen))
  const lastSeen = maxDate(asDate(person.last_seen_at), asDate(agg?.lastSeen))
  const values = {
    connectionId: connection.id,
    orgId: connection.orgId,
    distinctId,
    personId: person.uuid ?? (person.id != null ? String(person.id) : null),
    email,
    name: person.name ?? null,
    properties,
    eventCount: agg?.eventCount ?? 0,
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    raw: person,
    syncedAt: new Date(),
  }
  await db
    .insert(posthogPersonMetric)
    .values(values)
    .onConflictDoUpdate({
      target: [posthogPersonMetric.orgId, posthogPersonMetric.distinctId],
      set: {
        connectionId: values.connectionId,
        personId: values.personId,
        email: values.email,
        name: values.name,
        properties: values.properties,
        eventCount: values.eventCount,
        firstSeenAt: values.firstSeenAt,
        lastSeenAt: values.lastSeenAt,
        raw: values.raw,
        syncedAt: values.syncedAt,
      },
    })
}

/** Synced per-person metrics for the active org — surfaceable on instances/widgets. */
export async function listPosthogPersons(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const rows = await pool.query(
    `SELECT distinct_id, person_id, email, name, event_count, first_seen_at, last_seen_at, synced_at
       FROM posthog_person_metric
      WHERE org_id = $1
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT 500`,
    [org.orgId],
  )
  return json({ persons: rows.rows })
}

/**
 * Inbound webhook receiver. PostHog's destination POSTs are unauthenticated, so
 * the org is resolved from a per-connection `?token=`. Events are deduped by
 * uuid (or a body hash) and recorded; a matching person metric is nudged.
 */
export async function handlePosthogWebhook(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get("token")
  if (!token) return json({ error: "MISSING_TOKEN" }, 401)
  const [connection] = await db
    .select()
    .from(posthogConnection)
    .where(
      and(eq(posthogConnection.webhookToken, token), eq(posthogConnection.status, "connected")),
    )
    .limit(1)
  if (!connection) return json({ error: "BAD_TOKEN" }, 403)

  const rawText = await req.text().catch(() => "")
  let body: Record<string, unknown> = {}
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  const event = (body.event && typeof body.event === "object" ? body.event : body) as Record<
    string,
    unknown
  >
  const eventName = typeof event.event === "string" ? event.event : null
  const distinctId = typeof event.distinct_id === "string" ? event.distinct_id : null
  const uuid = typeof event.uuid === "string" ? event.uuid : null
  const dedupeKey = uuid
    ? `evt:${uuid}`
    : `sha:${connection.id}:${createHash("sha256").update(rawText).digest("base64url")}`

  try {
    await db.insert(posthogWebhookEvent).values({
      orgId: connection.orgId,
      connectionId: connection.id,
      dedupeKey,
      eventName,
      distinctId,
      payload: body,
    })
  } catch {
    // Unique-violation on dedupeKey → already processed; ack idempotently.
    return json({ ok: true, deduped: true })
  }
  if (distinctId) {
    await pool.query(
      `UPDATE posthog_person_metric
          SET event_count = event_count + 1,
              last_seen_at = GREATEST(last_seen_at, now())
        WHERE org_id = $1 AND distinct_id = $2`,
      [connection.orgId, distinctId],
    )
  }
  await audit({
    orgId: connection.orgId,
    userId: connection.userId,
    connectionId: connection.id,
    action: "webhook",
    subjectKind: "event",
    subjectId: uuid,
    detail: { eventName },
  })
  return json({ ok: true })
}
