import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { clayAuditLog, clayConnection, clayJob, clayNotification } from "#db"
import { db } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import { sleepBeforeRetry } from "./integrations/http"
import { runEngine } from "./runtime"
import { resolveOrg } from "./session"
import { createInstance, getInstance, updateInstance } from "./use-cases"

/**
 * Clay connector — the ASYNC, webhook/table-centric integration (the distinctive
 * one of the five). Clay is NOT request/response: KM pushes a row into a Clay
 * table via an inbound webhook URL, Clay enriches it on its own schedule, then
 * Clay POSTs the enriched result back to a KM callback endpoint. The round-trip
 * is correlated by an id KM embeds in the pushed row and Clay echoes on callback.
 *
 * ⚠️ SPIKE — ASSUMED CONTRACT (reconcile with Clay's real API later):
 *  - OUTBOUND (KM → Clay): POST JSON to the connection's `tableWebhookUrl`. The
 *    body is the projected row keyed by Clay column names, PLUS reserved keys:
 *      `_km_correlation_id` — the clayJob id; KM assumes Clay stores it as a
 *        column and echoes it back unchanged on the enriched callback.
 *      `_km_callback_url`   — where Clay should POST results (informational; the
 *        operator normally wires the callback in Clay's UI).
 *  - INBOUND (Clay → KM): POST to `/api/integrations/clay/callback?cid=<connId>`
 *    (cid routes to the connection — non-secret). The shared secret arrives via
 *    the `x-clay-secret` header OR a `?token=` query param OR body
 *    `_km_callback_secret`; it is compared TIMING-SAFE to the connection's
 *    stored callbackSecret. Body shape:
 *      { _km_correlation_id?, _km_delivery_id?, fields?: {clayColumn: value} }
 *    Enriched columns may be nested under `fields` or sit at the top level
 *    (reserved `_km_*` keys excluded). `_km_delivery_id` (else a body hash) keys
 *    dedup. A matching job → write-back to its instance (or create on its
 *    concept); no match → net-new row (auto-create when configured, else logged).
 *
 * GENERIC BY DESIGN: every mapping is {clayColumn → KM field id}. There is NO
 * concept or field-name hardcoding (the repo keys everything by field id).
 *
 * DEFERRED (follow-ups, not built here): the per-instance "Send to Clay"
 * Details-tile button + mapping picker (the enrich ROUTE + client method land
 * here), auto-trigger-on-create flows, and Clay REST pull/list via `apiKey`.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

const MAX_RETRIES = 3

type ClayFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>
let clayFetch: ClayFetch = fetch

export const setClayFetchForTest = (next: ClayFetch) => {
  clayFetch = next
}

/** Reserved body keys that are NOT enrichment columns. */
const RESERVED_KEYS = new Set([
  "_km_correlation_id",
  "correlationId",
  "_km_delivery_id",
  "_km_callback_secret",
  "_km_callback_url",
  "fields",
])

/**
 * POST a JSON body to a Clay-hosted URL (the inbound table webhook). Retries
 * 429/5xx up to 3× with backoff, honoring `Retry-After` when present. The URL is
 * itself the credential, so no auth header is added.
 */
export async function clayPost(url: string, body: unknown, attempt = 0): Promise<Response> {
  const res = await clayFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    await sleepBeforeRetry(res, attempt, 500)
    return clayPost(url, body, attempt + 1)
  }
  return res
}

// ── persistence helpers ───────────────────────────────────────────────────────

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
  await db.insert(clayAuditLog).values({
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
    .from(clayConnection)
    .where(eq(clayConnection.orgId, orgId))
    .limit(1)
  return row ?? null
}

const connectionById = async (id: string) => {
  const [row] = await db.select().from(clayConnection).where(eq(clayConnection.id, id)).limit(1)
  return row ?? null
}

// ── callback URL ──────────────────────────────────────────────────────────────

/**
 * The URL the operator pastes into Clay's "send result back" action. Routing id
 * (`cid`) is non-secret; the secret rides the `token` query param (or, preferred
 * in production, the `x-clay-secret` header — both are accepted on callback).
 */
const callbackUrlFor = (connectionId: string, secret: string | null): string => {
  const base = process.env.CLAY_CALLBACK_BASE_URL ?? process.env.BETTER_AUTH_URL ?? ""
  const q = secret
    ? `?cid=${connectionId}&token=${encodeURIComponent(secret)}`
    : `?cid=${connectionId}`
  const path = `/api/integrations/clay/callback${q}`
  return base ? `${base.replace(/\/+$/, "")}${path}` : path
}

// ── connect / disconnect / status ──────────────────────────────────────────────

export async function connectClay(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const body = (await req.json().catch(() => null)) as {
    tableWebhookUrl?: string
    apiKey?: string
    newRowConceptId?: string
    newRowMapping?: Record<string, string>
  } | null
  const tableWebhookUrl = body?.tableWebhookUrl?.trim()
  if (!tableWebhookUrl) return json({ error: "TABLE_WEBHOOK_URL_REQUIRED" }, 400)
  try {
    const u = new URL(tableWebhookUrl)
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return json({ error: "INVALID_WEBHOOK_URL" }, 400)
  } catch {
    return json({ error: "INVALID_WEBHOOK_URL" }, 400)
  }

  const existing = await connectionForOrg(org.orgId)
  // Reuse an existing callback secret so a reconnect doesn't invalidate the URL
  // already wired into Clay; mint one on first connect.
  const secret = (existing && decryptToken(existing.callbackSecret)) || randomUUID()
  const values = {
    orgId: org.orgId,
    userId: org.actor,
    tableWebhookUrl: encryptToken(tableWebhookUrl),
    apiKey: body?.apiKey?.trim() ? encryptToken(body.apiKey.trim()) : null,
    callbackSecret: encryptToken(secret),
    newRowConceptId: body?.newRowConceptId?.trim() || null,
    newRowMapping:
      body?.newRowMapping && typeof body.newRowMapping === "object" ? body.newRowMapping : {},
    status: "connected",
    disconnectedAt: null,
    lastError: null,
    lastValidatedAt: new Date(),
  }
  const [connection] = existing
    ? await db
        .update(clayConnection)
        .set(values)
        .where(eq(clayConnection.id, existing.id))
        .returning()
    : await db.insert(clayConnection).values(values).returning()
  if (!connection) return json({ error: "CONNECTION_WRITE_FAILED" }, 500)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "connect",
  })
  return statusPayload(req)
}

export async function disconnectClay(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ ok: true })
  // Data minimization: drop the encrypted URL/key/secret on disconnect. Jobs are
  // kept (they reference instance ids, not PII) for round-trip history.
  await db
    .update(clayConnection)
    .set({
      status: "disconnected",
      tableWebhookUrl: null,
      apiKey: null,
      callbackSecret: null,
      disconnectedAt: new Date(),
    })
    .where(eq(clayConnection.id, connection.id))
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "disconnect",
  })
  return json({ ok: true })
}

async function statusPayload(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  // Clay auth is webhook/key based (no server-side OAuth creds), so it is never
  // "disabled" the way Google is — `configured` is always true.
  if (connection?.status !== "connected") {
    return json({ configured: true, connected: false })
  }
  return json({
    configured: true,
    connected: true,
    callbackUrl: callbackUrlFor(connection.id, decryptToken(connection.callbackSecret)),
    hasTableWebhook: Boolean(connection.tableWebhookUrl),
    hasApiKey: Boolean(connection.apiKey),
    newRowConceptId: connection.newRowConceptId,
    newRowAutoCreate: Boolean(connection.newRowConceptId),
    lastValidatedAt: connection.lastValidatedAt,
    lastError: connection.lastError,
  })
}

export const clayStatus = (req: Request) => statusPayload(req)

// ── outbound: push a row (enrich) ──────────────────────────────────────────────

const isEmpty = (v: unknown): boolean =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0)

/**
 * Project an instance's state onto a Clay row via {clayColumn → fieldId}: the
 * row is keyed by Clay column names carrying the instance's current field values.
 * Empty values are omitted. Pure/generic — no field-name knowledge.
 */
const rowFromMapping = (
  state: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> => {
  const row: Record<string, unknown> = {}
  for (const [clayKey, fieldId] of Object.entries(mapping)) {
    const value = state[fieldId]
    if (isEmpty(value)) continue
    row[clayKey] = value
  }
  return row
}

/**
 * Push an existing instance's mapped fields into the Clay table as a row, tagged
 * with a fresh correlation id, and record a pending `clayJob` for the eventual
 * enriched callback. Returns the job id (the correlation id). Generic: the caller
 * supplies the {clayColumn → fieldId} mapping; no concept assumptions.
 */
export async function pushRow(
  scope: { orgId: string; actor: string },
  connection: typeof clayConnection.$inferSelect,
  input: { instanceId: string; mapping: Record<string, string>; extra?: Record<string, unknown> },
): Promise<
  { ok: true; jobId: string } | { ok: false; status: number; code: string; detail?: unknown }
> {
  const webhookUrl = decryptToken(connection.tableWebhookUrl)
  if (!webhookUrl) return { ok: false, status: 400, code: "NO_TABLE_WEBHOOK" }

  const instRes = await runEngine(scope, getInstance(input.instanceId))
  if (!instRes.ok)
    return { ok: false, status: instRes.status, code: instRes.code, detail: instRes.detail }
  const state = instRes.data.state as Record<string, unknown>

  // Record the correlation job first so a callback that races the POST response
  // still finds its job.
  const [job] = await db
    .insert(clayJob)
    .values({
      orgId: scope.orgId,
      connectionId: connection.id,
      instanceId: input.instanceId,
      conceptId: instRes.data.conceptId,
      mapping: input.mapping,
      direction: "enrich",
      status: "pending",
    })
    .returning()
  if (!job) return { ok: false, status: 500, code: "JOB_WRITE_FAILED" }

  const row = {
    ...rowFromMapping(state, input.mapping),
    ...(input.extra ?? {}),
    _km_correlation_id: job.id,
    _km_callback_url: callbackUrlFor(connection.id, decryptToken(connection.callbackSecret)),
  }
  try {
    const res = await clayPost(webhookUrl, row)
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      await db
        .update(clayJob)
        .set({ status: "error", lastError: `Clay webhook ${res.status}: ${detail}`.slice(0, 1000) })
        .where(eq(clayJob.id, job.id))
      return { ok: false, status: 502, code: "CLAY_PUSH_FAILED", detail }
    }
  } catch (error) {
    await db
      .update(clayJob)
      .set({ status: "error", lastError: String(error).slice(0, 1000) })
      .where(eq(clayJob.id, job.id))
    return { ok: false, status: 502, code: "CLAY_PUSH_FAILED", detail: String(error) }
  }
  return { ok: true, jobId: job.id }
}

/** Route: push a single instance to Clay (`POST .../enrich`). */
export async function enrichForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_CLAY_CONNECTION" }, 404)

  const body = (await req.json().catch(() => null)) as {
    instanceId?: string
    mapping?: Record<string, string>
    extra?: Record<string, unknown>
  } | null
  const instanceId = body?.instanceId?.trim()
  const mapping = body?.mapping
  if (!instanceId) return json({ error: "INSTANCE_ID_REQUIRED" }, 400)
  if (!mapping || typeof mapping !== "object" || Object.keys(mapping).length === 0)
    return json({ error: "MAPPING_REQUIRED" }, 400)

  const result = await pushRow({ orgId: org.orgId, actor: org.actor }, connection, {
    instanceId,
    mapping,
    extra: body?.extra,
  })
  if (!result.ok) {
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "enrich",
      status: "error",
      subjectKind: "instance",
      subjectId: instanceId,
      detail: { code: result.code, detail: result.detail },
    })
    return json({ error: result.code, detail: result.detail }, result.status)
  }
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "enrich",
    subjectKind: "instance",
    subjectId: instanceId,
    detail: { jobId: result.jobId },
  })
  return json({ ok: true, jobId: result.jobId })
}

// ── inbound: Clay → KM callback ────────────────────────────────────────────────

/** Constant-time string compare guarding against length-leak + timing attacks. */
const secretMatches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Extract enriched columns from a callback body (nested `fields` or top-level). */
const fieldsFromBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields))
    return body.fields as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (RESERVED_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

/** Project enriched Clay columns onto KM field values via {clayColumn → fieldId}. */
const patchFromMapping = (
  fields: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {}
  for (const [clayKey, fieldId] of Object.entries(mapping)) {
    const value = fields[clayKey]
    if (isEmpty(value)) continue
    patch[fieldId] = value
  }
  return patch
}

/**
 * Receive an enriched row from Clay. Session-less: routed by `?cid=` and
 * authenticated by the shared callback secret (timing-safe). Dedups by delivery
 * id (or body hash), matches the correlation id to a `clayJob`, and writes the
 * enriched columns back onto the job's instance (or creates one on its concept).
 * Unmatched rows are net-new: auto-created onto the connection's configured
 * `newRowConceptId`/`newRowMapping`, or logged for review when unconfigured.
 */
export async function handleClayCallback(req: Request) {
  const url = new URL(req.url)
  const cid = url.searchParams.get("cid")
  if (!cid) return json({ error: "MISSING_CID" }, 401)
  const connection = await connectionById(cid)
  if (connection?.status !== "connected") return json({ error: "BAD_CID" }, 403)

  const rawText = await req.text().catch(() => "")
  let body: Record<string, unknown> = {}
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }

  const expected = decryptToken(connection.callbackSecret)
  const provided =
    req.headers.get("x-clay-secret") ??
    url.searchParams.get("token") ??
    (typeof body._km_callback_secret === "string" ? body._km_callback_secret : "")
  if (!expected || !provided || !secretMatches(provided, expected))
    return json({ error: "INVALID_SECRET" }, 401)

  const scope = { orgId: connection.orgId, actor: connection.userId }
  const correlationId =
    (typeof body._km_correlation_id === "string" && body._km_correlation_id) ||
    (typeof body.correlationId === "string" && body.correlationId) ||
    null
  const deliveryId =
    typeof body._km_delivery_id === "string" && body._km_delivery_id ? body._km_delivery_id : null
  const dedupeKey = deliveryId
    ? `del:${connection.id}:${deliveryId}`
    : `sha:${connection.id}:${createHash("sha256").update(rawText).digest("base64url")}`

  // Dedup: a unique-violation means we already processed this delivery.
  try {
    await db.insert(clayNotification).values({
      orgId: connection.orgId,
      connectionId: connection.id,
      dedupeKey,
      jobId: correlationId,
      kind: "callback",
      payload: body,
    })
  } catch {
    return json({ ok: true, deduped: true })
  }

  const fields = fieldsFromBody(body)

  // 1) Correlated callback → write back to the job's instance (or create on its concept).
  if (correlationId) {
    const [job] = await db
      .select()
      .from(clayJob)
      .where(and(eq(clayJob.id, correlationId), eq(clayJob.orgId, connection.orgId)))
      .limit(1)
    if (job) {
      const mapping = (job.mapping ?? {}) as Record<string, string>
      const patch = patchFromMapping(fields, mapping)
      if (Object.keys(patch).length === 0) {
        await db
          .update(clayJob)
          .set({ status: "done", completedAt: new Date() })
          .where(eq(clayJob.id, job.id))
        await audit({
          orgId: connection.orgId,
          userId: connection.userId,
          connectionId: connection.id,
          action: "callback",
          subjectKind: "job",
          subjectId: job.id,
          detail: { matched: true, updated: false },
        })
        return json({ ok: true, matched: true, updated: false })
      }
      const outcome = job.instanceId
        ? await writeBack(scope, job.instanceId, patch)
        : job.conceptId
          ? await createNew(scope, job.conceptId, patch)
          : { ok: false as const, status: 422, code: "JOB_HAS_NO_TARGET" }
      await db
        .update(clayJob)
        .set({
          status: outcome.ok ? "done" : "error",
          lastError: outcome.ok ? null : `${outcome.code}`,
          completedAt: new Date(),
        })
        .where(eq(clayJob.id, job.id))
      await audit({
        orgId: connection.orgId,
        userId: connection.userId,
        connectionId: connection.id,
        action: "callback",
        status: outcome.ok ? "ok" : "error",
        subjectKind: "instance",
        subjectId: outcome.ok ? outcome.instanceId : job.instanceId,
        detail: outcome.ok
          ? { matched: true, created: !job.instanceId, fields: Object.keys(patch) }
          : { matched: true, code: outcome.code },
      })
      if (!outcome.ok) return json({ error: outcome.code }, outcome.status)
      return json({
        ok: true,
        matched: true,
        updated: Boolean(job.instanceId),
        created: !job.instanceId,
        instanceId: outcome.instanceId,
      })
    }
    // correlationId present but no job (expired/foreign) → fall through to net-new.
  }

  // 2) Net-new row → auto-create onto the configured concept, else log for review.
  if (connection.newRowConceptId) {
    const mapping = (connection.newRowMapping ?? {}) as Record<string, string>
    const patch = patchFromMapping(fields, mapping)
    if (Object.keys(patch).length === 0)
      return json({ ok: true, matched: false, created: false, reason: "NO_MAPPED_FIELDS" })
    const outcome = await createNew(scope, connection.newRowConceptId, patch)
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "callback",
      status: outcome.ok ? "ok" : "error",
      subjectKind: "concept",
      subjectId: connection.newRowConceptId,
      detail: outcome.ok ? { created: true, fields: Object.keys(patch) } : { code: outcome.code },
    })
    if (!outcome.ok) return json({ error: outcome.code }, outcome.status)
    return json({ ok: true, matched: false, created: true, instanceId: outcome.instanceId })
  }

  // Unconfigured net-new → logged (in clay_notification) for review only.
  await audit({
    orgId: connection.orgId,
    userId: connection.userId,
    connectionId: connection.id,
    action: "callback",
    subjectKind: "review",
    detail: { matched: false, created: false, queued: true },
  })
  return json({ ok: true, matched: false, created: false, queued: true })
}

type WriteOutcome = { ok: true; instanceId: string } | { ok: false; status: number; code: string }

/** Overwrite-write the enriched patch onto an existing instance via the engine. */
async function writeBack(
  scope: { orgId: string; actor: string },
  instanceId: string,
  patch: Record<string, unknown>,
): Promise<WriteOutcome> {
  const instRes = await runEngine(scope, getInstance(instanceId))
  if (!instRes.ok) return { ok: false, status: instRes.status, code: instRes.code }
  const updRes = await runEngine(scope, updateInstance(instanceId, instRes.data.version, patch))
  if (!updRes.ok) return { ok: false, status: updRes.status, code: updRes.code }
  return { ok: true, instanceId }
}

/** Create a net-new instance on `conceptId` from the enriched patch. */
async function createNew(
  scope: { orgId: string; actor: string },
  conceptId: string,
  patch: Record<string, unknown>,
): Promise<WriteOutcome> {
  const res = await runEngine(scope, createInstance(conceptId, patch))
  if (!res.ok) return { ok: false, status: res.status, code: res.code }
  return { ok: true, instanceId: res.data.id }
}
