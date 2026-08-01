import { and, eq, gt } from "drizzle-orm"
import { apolloAuditLog, apolloConnection, apolloEnrichmentCache } from "#db"
import { db } from "./db"
import { type AuditEntry, writeAuditLog } from "./integrations/audit"
import { decryptToken, encryptToken } from "./integrations/crypto"
import { sleepBeforeRetry } from "./integrations/http"
import { connectionForOrgIn } from "./integrations/rows"
import { runEngine } from "./runtime"
import { resolveAdmin, resolveOrg } from "./session"
import { createInstance, getInstance, updateInstance } from "./use-cases"

/**
 * Apollo.io connector — a key-based integration built on the PostHog/Linear
 * template. Auth is an Apollo API key stored ENCRYPTED at the ORG level (one
 * connection per org). Unlike PostHog/Linear this connector does not mirror a
 * remote object set into a synced table; it is on-demand: enrich an existing KM
 * instance, run a people search, and bulk-import search results as new
 * instances. `apolloRequest` mirrors `posthogRequest` — 429/5xx retry+backoff
 * honoring Apollo's `Retry-After`.
 *
 * GENERIC BY DESIGN: enrichment writes onto an instance's fields via a
 * caller-supplied {apolloFieldKey → KM field id} mapping. There is NO hardcoded
 * concept ("Person"/"Company") or KM-field-name special-casing — the repo keys
 * everything by field id (see field-relation uid-keying), and this connector
 * works against ANY concept whose fields the caller chooses to map.
 *
 * Compliance: Apollo data is contact PII. We store only the encrypted API key
 * plus an OPTIONAL, org-scoped, TTL'd enrichment cache (to conserve Apollo
 * credits on repeat lookups). The cache is purged on disconnect and can be
 * disabled with APOLLO_ENRICH_CACHE_ENABLED=0. Enrichment results otherwise live
 * only on the KM instance fields the operator explicitly mapped.
 *
 * DEFERRED (follow-ups, not built here): auto-enrich on instance create, Apollo
 * sequence-action writes, and a per-instance "Enrich with Apollo" Details-tile
 * UI affordance (the enrich ROUTE + client method land here; the in-page button
 * + field-mapping picker is a later UI task).
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

const DEFAULT_BASE = "https://api.apollo.io/api/v1"
/** Apollo REST base; overridable for self-host/test. Trailing slashes trimmed. */
const apiBase = () => (process.env.APOLLO_API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "")

const MAX_RETRIES = 3

type ApolloFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>
let apolloFetch: ApolloFetch = fetch

export const setApolloFetchForTest = (next: ApolloFetch) => {
  apolloFetch = next
}

export type RequestCtx = { base: string; apiKey: string }

/**
 * Authenticated Apollo REST call. The API key rides the `X-Api-Key` header (the
 * documented Apollo scheme — NOT a Bearer token). `pathOrUrl` may be a path
 * (`/people/match`) prefixed with the connection base, or an absolute URL.
 * Retries 429/5xx up to 3× with backoff, honoring `Retry-After` (Apollo's rate
 * limits are per-minute/hour, so we respect its header when present).
 */
export async function apolloRequest<T>(
  ctx: RequestCtx,
  pathOrUrl: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${ctx.base}${pathOrUrl}`
  const headers = new Headers(init.headers)
  headers.set("x-api-key", ctx.apiKey)
  headers.set("cache-control", "no-cache")
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const res = await apolloFetch(url, { ...init, headers })
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    await sleepBeforeRetry(res, attempt, 500)
    return apolloRequest<T>(ctx, pathOrUrl, init, attempt + 1)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const err = new Error(`Apollo API ${res.status}: ${detail}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ── normalization ─────────────────────────────────────────────────────────────

/**
 * The stable, flat set of enrichment keys this connector exposes. The operator
 * maps each key to a KM field id; the UI can render this catalog as a picker.
 * Keys never change shape regardless of which concept they're written onto.
 */
export const APOLLO_ENRICHMENT_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "apolloId", label: "Apollo person ID" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "name", label: "Full name" },
  { key: "title", label: "Job title" },
  { key: "headline", label: "Headline" },
  { key: "email", label: "Email" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "photoUrl", label: "Photo URL" },
  { key: "city", label: "City" },
  { key: "state", label: "State / region" },
  { key: "country", label: "Country" },
  { key: "organizationName", label: "Company name" },
  { key: "organizationDomain", label: "Company domain" },
  { key: "organizationWebsite", label: "Company website" },
  { key: "organizationIndustry", label: "Company industry" },
  { key: "organizationSize", label: "Company size (employees)" },
  { key: "organizationLinkedinUrl", label: "Company LinkedIn URL" },
  { key: "phone", label: "Phone" },
]

export type NormalizedPerson = Record<string, string | number | null>

type ApolloOrg = {
  name?: string | null
  website_url?: string | null
  primary_domain?: string | null
  domain?: string | null
  industry?: string | null
  estimated_num_employees?: number | null
  linkedin_url?: string | null
  phone?: string | null
}
type ApolloPerson = {
  id?: string | null
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  title?: string | null
  headline?: string | null
  email?: string | null
  linkedin_url?: string | null
  photo_url?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  phone?: string | null
  organization_name?: string | null
  organization?: ApolloOrg | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Map a raw Apollo person (from /people/match or search) to the flat catalog. */
export function normalizePerson(p: ApolloPerson): NormalizedPerson {
  const org = p.organization ?? {}
  const fullName =
    str(p.name) ?? ([p.first_name, p.last_name].filter(Boolean).join(" ").trim() || null)
  return {
    apolloId: str(p.id),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    name: fullName,
    title: str(p.title),
    headline: str(p.headline),
    email: str(p.email),
    linkedinUrl: str(p.linkedin_url),
    photoUrl: str(p.photo_url),
    city: str(p.city),
    state: str(p.state),
    country: str(p.country),
    organizationName: str(org.name) ?? str(p.organization_name),
    organizationDomain: str(org.primary_domain) ?? str(org.domain),
    organizationWebsite: str(org.website_url),
    organizationIndustry: str(org.industry),
    organizationSize: num(org.estimated_num_employees),
    organizationLinkedinUrl: str(org.linkedin_url),
    phone: str(org.phone) ?? str(p.phone),
  }
}

// ── enrichment + search ─────────────────────────────────────────────────────

export type EnrichQuery = {
  email?: string
  name?: string
  firstName?: string
  lastName?: string
  organizationName?: string
  domain?: string
  linkedinUrl?: string
  id?: string
}

/** True when `q` carries at least one identifier Apollo can match against. */
const hasLookup = (q: EnrichQuery): boolean =>
  Boolean(q.email || q.name || q.firstName || q.lastName || q.domain || q.linkedinUrl || q.id)

/**
 * Enrich a single person via Apollo's People Match (POST /people/match). Returns
 * the normalized person, or null when Apollo finds no match.
 */
export async function enrichPerson(
  ctx: RequestCtx,
  query: EnrichQuery,
): Promise<NormalizedPerson | null> {
  const body: Record<string, unknown> = {}
  if (query.email) body.email = query.email
  if (query.name) body.name = query.name
  if (query.firstName) body.first_name = query.firstName
  if (query.lastName) body.last_name = query.lastName
  if (query.organizationName) body.organization_name = query.organizationName
  if (query.domain) body.domain = query.domain
  if (query.linkedinUrl) body.linkedin_url = query.linkedinUrl
  if (query.id) body.id = query.id
  const data = await apolloRequest<{ person?: ApolloPerson | null }>(ctx, "/people/match", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return data.person ? normalizePerson(data.person) : null
}

export type SearchParams = {
  q?: string
  titles?: ReadonlyArray<string>
  domains?: ReadonlyArray<string>
  locations?: ReadonlyArray<string>
  page?: number
  perPage?: number
}

export type SearchResult = {
  people: ReadonlyArray<NormalizedPerson>
  pagination: { page?: number; perPage?: number; totalEntries?: number; totalPages?: number } | null
}

/**
 * People search via Apollo's People Search (POST /mixed_people/search). Param
 * names track Apollo's current search schema. Note: search results carry NO
 * email/phone — those come from enrichment — so imported leads typically need a
 * follow-up enrich to fill contact fields.
 */
export async function search(ctx: RequestCtx, params: SearchParams): Promise<SearchResult> {
  const body: Record<string, unknown> = {
    page: params.page && params.page > 0 ? params.page : 1,
    per_page: Math.min(Math.max(params.perPage ?? 25, 1), 100),
  }
  if (params.q) body.q_keywords = params.q
  if (params.titles?.length) body.person_titles = params.titles
  if (params.domains?.length) body.q_organization_domains_list = params.domains
  if (params.locations?.length) body.person_locations = params.locations
  const data = await apolloRequest<{
    people?: ApolloPerson[]
    pagination?: {
      page?: number
      per_page?: number
      total_entries?: number
      total_pages?: number
    } | null
  }>(ctx, "/mixed_people/search", { method: "POST", body: JSON.stringify(body) })
  const pg = data.pagination ?? null
  return {
    people: (data.people ?? []).map(normalizePerson),
    pagination: pg
      ? {
          page: pg.page,
          perPage: pg.per_page,
          totalEntries: pg.total_entries,
          totalPages: pg.total_pages,
        }
      : null,
  }
}

const isEmpty = (v: unknown): boolean =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0)

/**
 * Project a normalized person onto KM field values via the {apolloKey → fieldId}
 * mapping. Only non-empty enrichment values are included. Pure/generic — no
 * field-name knowledge.
 */
const fieldsFromMapping = (
  person: NormalizedPerson,
  mapping: Record<string, string>,
): Record<string, unknown> => {
  const fields: Record<string, unknown> = {}
  for (const [apolloKey, fieldId] of Object.entries(mapping)) {
    const value = person[apolloKey]
    if (value == null || value === "") continue
    fields[fieldId] = value
  }
  return fields
}

/**
 * Create new KM instances from search results onto `conceptId`, mapping Apollo
 * fields → KM field ids. Returns per-result outcomes. Each create runs through
 * the engine (field validation applies); a result that maps to no non-empty
 * fields is skipped.
 */
export async function bulkImport(
  scope: { orgId: string; actor: string },
  people: ReadonlyArray<NormalizedPerson>,
  conceptId: string,
  mapping: Record<string, string>,
): Promise<{
  created: string[]
  skipped: number
  errors: Array<{ index: number; code: string }>
}> {
  const created: string[] = []
  const errors: Array<{ index: number; code: string }> = []
  let skipped = 0
  for (let i = 0; i < people.length; i += 1) {
    const fields = fieldsFromMapping(people[i]!, mapping)
    if (Object.keys(fields).length === 0) {
      skipped += 1
      continue
    }
    const res = await runEngine(scope, createInstance(conceptId, fields))
    if (res.ok) created.push(res.data.id)
    else errors.push({ index: i, code: res.code })
  }
  return { created, skipped, errors }
}

// ── persistence helpers ───────────────────────────────────────────────────────

/** Write one row to this connector's audit log. */
const audit = (input: AuditEntry) => writeAuditLog(apolloAuditLog, input)

const connectionForOrg = (orgId: string) => connectionForOrgIn(apolloConnection, orgId)

const ctxFor = (conn: typeof apolloConnection.$inferSelect): RequestCtx => {
  const apiKey = decryptToken(conn.apiKey)
  if (!apiKey) throw new Error("Apollo connection has no API key")
  return { base: apiBase(), apiKey }
}

// ── enrichment cache (credit-conserving, opt-out) ─────────────────────────────

const cacheEnabled = () => process.env.APOLLO_ENRICH_CACHE_ENABLED !== "0"
const cacheTtlMs = () => {
  const days = Number(process.env.APOLLO_ENRICH_CACHE_TTL_DAYS)
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000
}

/** Deterministic cache key for a lookup (order-independent, lowercased). */
const lookupKeyFor = (query: EnrichQuery): string =>
  Object.entries(query)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([k, v]) => [k, String(v).trim().toLowerCase()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")

/**
 * Enrich with a read-through cache. A fresh org-scoped row short-circuits the
 * Apollo call (saving credits); a miss calls Apollo and caches a successful
 * match. Misses (no match) are NOT cached so they can be retried later.
 */
async function enrichWithCache(
  orgId: string,
  ctx: RequestCtx,
  query: EnrichQuery,
): Promise<{ person: NormalizedPerson | null; cached: boolean }> {
  const key = lookupKeyFor(query)
  if (cacheEnabled() && key) {
    const cutoff = new Date(Date.now() - cacheTtlMs())
    const [hit] = await db
      .select()
      .from(apolloEnrichmentCache)
      .where(
        and(
          eq(apolloEnrichmentCache.orgId, orgId),
          eq(apolloEnrichmentCache.lookupKey, key),
          gt(apolloEnrichmentCache.fetchedAt, cutoff),
        ),
      )
      .limit(1)
    if (hit) return { person: hit.person as NormalizedPerson, cached: true }
  }
  const person = await enrichPerson(ctx, query)
  if (person && cacheEnabled() && key) {
    await db
      .insert(apolloEnrichmentCache)
      .values({ orgId, lookupKey: key, person })
      .onConflictDoUpdate({
        target: [apolloEnrichmentCache.orgId, apolloEnrichmentCache.lookupKey],
        set: { person, fetchedAt: new Date() },
      })
  }
  return { person, cached: false }
}

// ── connect / disconnect / status ────────────────────────────────────────────

/** Validate a key with the lightweight authed health check. */
async function validateKey(ctx: RequestCtx): Promise<void> {
  const data = await apolloRequest<{ is_logged_in?: boolean }>(ctx, "/auth/health")
  if (data && data.is_logged_in === false) throw new Error("Apollo health reports not logged in")
}

export async function connectApollo(req: Request) {
  // Admin-only: org-wide enrichment key (and the billing it draws on).
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const body = (await req.json().catch(() => null)) as { apiKey?: string } | null
  const apiKey = body?.apiKey?.trim()
  if (!apiKey) return json({ error: "API_KEY_REQUIRED" }, 400)

  try {
    await validateKey({ base: apiBase(), apiKey })
  } catch (error) {
    // Bad key / unreachable host → surface as an auth failure, not a 500.
    return json({ error: "INVALID_API_KEY", detail: String(error) }, 400)
  }

  const existing = await connectionForOrg(org.orgId)
  const values = {
    orgId: org.orgId,
    userId: org.actor,
    apiKey: encryptToken(apiKey),
    status: "connected",
    disconnectedAt: null,
    lastError: null,
    lastValidatedAt: new Date(),
  }
  const [connection] = existing
    ? await db
        .update(apolloConnection)
        .set(values)
        .where(eq(apolloConnection.id, existing.id))
        .returning()
    : await db.insert(apolloConnection).values(values).returning()
  if (!connection) return json({ error: "CONNECTION_WRITE_FAILED" }, 500)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "connect",
  })
  return statusPayload(req)
}

export async function disconnectApollo(req: Request) {
  // Admin-only — and this one also DROPS the org's cached enrichment PII below.
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ ok: true })
  await db
    .update(apolloConnection)
    .set({ status: "disconnected", apiKey: null, disconnectedAt: new Date() })
    .where(eq(apolloConnection.id, connection.id))
  // Data minimization: drop cached enrichment PII for this org on disconnect.
  await db.delete(apolloEnrichmentCache).where(eq(apolloEnrichmentCache.orgId, org.orgId))
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
  // Apollo auth is a per-org key (no server-side OAuth creds), so it is never
  // "disabled" the way Google is — `configured` is always true.
  if (connection?.status !== "connected") {
    return json({ configured: true, connected: false, enrichmentFields: APOLLO_ENRICHMENT_FIELDS })
  }
  return json({
    configured: true,
    connected: true,
    lastValidatedAt: connection.lastValidatedAt,
    lastError: connection.lastError,
    enrichmentFields: APOLLO_ENRICHMENT_FIELDS,
  })
}

export const apolloStatus = (req: Request) => statusPayload(req)

// ── routes: enrich / search / import ──────────────────────────────────────────

/** Apollo enrichment key → People-Match query param, for derived lookups. */
const IDENTIFIER_KEYS: Record<string, keyof EnrichQuery> = {
  email: "email",
  name: "name",
  firstName: "firstName",
  lastName: "lastName",
  organizationName: "organizationName",
  organizationDomain: "domain",
  linkedinUrl: "linkedinUrl",
  apolloId: "id",
}

/**
 * Enrich a single instance's empty (or all, when `overwrite`) fields from
 * Apollo. The caller supplies `instanceId`, a {apolloKey → fieldId} `mapping`,
 * and optionally an explicit `query`. When no query is given, the lookup is
 * DERIVED from the instance's current field values via the mapping (e.g. the
 * field mapped to `email` provides the match email) — fully generic, no concept
 * or field-name assumptions.
 */
export async function enrichInstanceForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_APOLLO_CONNECTION" }, 404)

  const body = (await req.json().catch(() => null)) as {
    instanceId?: string
    mapping?: Record<string, string>
    query?: EnrichQuery
    overwrite?: boolean
  } | null
  const instanceId = body?.instanceId?.trim()
  const mapping = body?.mapping
  if (!instanceId) return json({ error: "INSTANCE_ID_REQUIRED" }, 400)
  if (!mapping || typeof mapping !== "object" || Object.keys(mapping).length === 0)
    return json({ error: "MAPPING_REQUIRED" }, 400)

  const scope = { orgId: org.orgId, actor: org.actor }
  const instRes = await runEngine(scope, getInstance(instanceId))
  if (!instRes.ok) return json({ error: instRes.code, detail: instRes.detail }, instRes.status)
  const state = instRes.data.state as Record<string, unknown>

  // Derive the lookup from instance state via the mapping, unless the caller
  // passed an explicit query (which takes precedence per key).
  const derived: EnrichQuery = {}
  for (const [apolloKey, fieldId] of Object.entries(mapping)) {
    const queryKey = IDENTIFIER_KEYS[apolloKey]
    if (!queryKey) continue
    const value = state[fieldId]
    if (typeof value === "string" && value.trim().length > 0) derived[queryKey] = value.trim()
  }
  const query: EnrichQuery = { ...derived, ...(body?.query ?? {}) }
  if (!hasLookup(query)) return json({ error: "NO_LOOKUP_AVAILABLE" }, 400)

  let person: NormalizedPerson | null
  let cached = false
  try {
    const out = await enrichWithCache(org.orgId, ctxFor(connection), query)
    person = out.person
    cached = out.cached
  } catch (error) {
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "enrich",
      status: "error",
      subjectKind: "instance",
      subjectId: instanceId,
      detail: { error: String(error) },
    })
    return json({ error: "ENRICH_FAILED", detail: String(error) }, 502)
  }
  if (!person) return json({ ok: true, matched: false, updated: false, fields: [] })

  // Build the patch: only fill empty fields unless overwrite is requested.
  const overwrite = body?.overwrite === true
  const patch: Record<string, unknown> = {}
  const fields: string[] = []
  for (const [apolloKey, fieldId] of Object.entries(mapping)) {
    const value = person[apolloKey]
    if (value == null || value === "") continue
    if (!overwrite && !isEmpty(state[fieldId])) continue
    patch[fieldId] = value
    fields.push(fieldId)
  }
  if (fields.length === 0)
    return json({ ok: true, matched: true, updated: false, cached, fields: [], enrichment: person })

  const updRes = await runEngine(scope, updateInstance(instanceId, instRes.data.version, patch))
  if (!updRes.ok) return json({ error: updRes.code, detail: updRes.detail }, updRes.status)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "enrich",
    subjectKind: "instance",
    subjectId: instanceId,
    detail: { fields, cached },
  })
  return json({ ok: true, matched: true, updated: true, cached, fields, enrichment: person })
}

export async function searchForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_APOLLO_CONNECTION" }, 404)
  const params = (await req.json().catch(() => null)) as SearchParams | null
  try {
    const result = await search(ctxFor(connection), params ?? {})
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "search",
      detail: { count: result.people.length },
    })
    return json(result)
  } catch (error) {
    return json({ error: "SEARCH_FAILED", detail: String(error) }, 502)
  }
}

export async function importForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_APOLLO_CONNECTION" }, 404)
  const body = (await req.json().catch(() => null)) as {
    conceptId?: string
    mapping?: Record<string, string>
    people?: NormalizedPerson[]
  } | null
  const conceptId = body?.conceptId?.trim()
  const mapping = body?.mapping
  const people = body?.people
  if (!conceptId) return json({ error: "CONCEPT_ID_REQUIRED" }, 400)
  if (!mapping || typeof mapping !== "object" || Object.keys(mapping).length === 0)
    return json({ error: "MAPPING_REQUIRED" }, 400)
  if (!Array.isArray(people)) return json({ error: "PEOPLE_REQUIRED" }, 400)

  const result = await bulkImport(
    { orgId: org.orgId, actor: org.actor },
    people,
    conceptId,
    mapping,
  )
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "import",
    subjectKind: "concept",
    subjectId: conceptId,
    detail: {
      created: result.created.length,
      skipped: result.skipped,
      errors: result.errors.length,
    },
  })
  return json({ ok: true, ...result })
}
