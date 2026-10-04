import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { linearAuditLog, linearConnection, linearIssue, linearWebhookEvent } from "#db"
import type { OrgScope } from "#engine"
import { db, pool } from "./db"
import { readIntegrationSettings } from "./integrationSettings"
import { type AuditEntry, writeAuditLog } from "./integrations/audit"
import { decryptToken, encryptToken, webhookTokenFrom } from "./integrations/crypto"
import { connectorFailure, publicConnectorError } from "./integrations/errors"
import { sleepBeforeRetry } from "./integrations/http"
import {
  type ProvisionConceptSpec,
  type ProvisionedConcept,
  provisionConcept,
  upsertRecordVersionByExternalId,
} from "./integrations/records"
import { connectionForOrgIn } from "./integrations/rows"
import { systemScope } from "./runtime"
import { resolveAdmin, resolveOrg } from "./session"

/**
 * Linear connector — a key-based integration built on the PostHog template.
 * Auth is a Linear personal API key stored ENCRYPTED at the org level (one
 * connection per org). Unlike PostHog/Google's REST APIs, Linear is a single
 * GraphQL endpoint (`https://api.linear.app/graphql`): every call is a POST of
 * a query string + variables. `linearGraphQL` mirrors `posthogRequest` — 429/5xx
 * retry+backoff plus GraphQL-level error surfacing. Handlers: connect/status/
 * disconnect/sync (paginated issues → `linear_issue`), an HMAC-verified inbound
 * webhook, and write-back mutations. KM concept/task-substrate mapping is
 * DEFERRED — this layer only mirrors issues into a synced table.
 */

const LINEAR_API_URL = "https://api.linear.app/graphql"

const json = (body: unknown, status = 200) => Response.json(body, { status })

type LinearFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>
let linearFetch: LinearFetch = fetch

export const setLinearFetchForTest = (next: LinearFetch) => {
  linearFetch = next
}

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message?: string }> }

/**
 * Authenticated Linear GraphQL call. Linear personal API keys go in the raw
 * `Authorization` header (no `Bearer` prefix — that's OAuth only). Retries
 * 429/5xx up to 3× with backoff honoring `Retry-After`, just like
 * `posthogRequest`. A 200 carrying a GraphQL `errors` array is still an error.
 */
export async function linearGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 0,
): Promise<T> {
  const res = await linearFetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  })
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleepBeforeRetry(res, attempt)
    return linearGraphQL<T>(token, query, variables, attempt + 1)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const err = new Error(`Linear API ${res.status}: ${detail}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  const payload = (await res.json()) as GraphQLResponse<T>
  if (payload.errors?.length) {
    throw new Error(`Linear GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`)
  }
  return payload.data as T
}

/** Write one row to this connector's audit log. */
const audit = (input: AuditEntry) => writeAuditLog(linearAuditLog, input)

const connectionForOrg = (orgId: string) => connectionForOrgIn(linearConnection, orgId)

/**
 * The org's Linear connection, only when usable (connected + has a key).
 *
 * Exists for callers outside a request — the automation runner has an org id but
 * no `Request` to authenticate. Mirrors `posthogConnectionForOrg`, INCLUDING the
 * status filter: `connectionForOrgIn` has no status predicate, so without this a
 * disconnected row would reach `tokenFor` and throw instead of reading as "not
 * connected". Returning null (never throwing) is what lets an action record a
 * missing integration as an outcome rather than failing the whole run.
 */
export const linearConnectionForOrg = async (orgId: string) => {
  const row = await connectionForOrg(orgId)
  return row?.status === "connected" ? row : null
}

const tokenFor = (conn: typeof linearConnection.$inferSelect): string => {
  const token = decryptToken(conn.token)
  if (!token) throw new Error("Linear connection has no API key")
  return token
}

// ── GraphQL documents ─────────────────────────────────────────────────────────

const VIEWER_QUERY = "query { viewer { id name } }"

const ISSUES_QUERY = `query Issues($after: String) {
  issues(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title url priority updatedAt
      state { name type }
      assignee { id name }
      team { id key }
    }
  }
}`

const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id identifier title url priority updatedAt
      state { name type }
      assignee { id name }
      team { id key }
    }
  }
}`

// Resolves the issue's team and the completed-type workflow state to "close"
// into, generically (no hardcoded state names).
const ISSUE_CLOSE_QUERY = `query IssueClose($id: String!) {
  issue(id: $id) {
    id
    team {
      id
      states(filter: { type: { eq: "completed" } }, first: 1) {
        nodes { id name type }
      }
    }
  }
}`

// The node selection every write-back must return, so its result can feed
// straight into `upsertIssue` without a second round trip.
const ISSUE_NODE_FIELDS = `id identifier title url priority updatedAt
  state { name type }
  assignee { id name }
  team { id key }`

const ISSUE_CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { ${ISSUE_NODE_FIELDS} }
  }
}`

// Comments have no mirror table and no place in TICKET_CONCEPT, so the created
// comment is deliberately not re-mirrored — only its id comes back.
const COMMENT_CREATE_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`

/**
 * Resolve a Linear user id from an email.
 *
 * Assigning by email is what lets `linear.assign` work with no KM-member →
 * Linear-user mapping table: both sides already know the address
 * (`bauth_user.email` is notNull + unique). `includeDisabled` is left at its
 * default false ON PURPOSE — assigning to a deactivated account should miss and
 * be recorded, not silently succeed.
 */
const USER_BY_EMAIL_QUERY = `query UserByEmail($email: String!) {
  users(filter: { email: { eq: $email } }, first: 1) {
    nodes { id name email }
  }
}`

// Fallback for the above: if `UserFilter.email`'s comparator shape ever differs
// from what we assume, one unfiltered page + an in-memory match still resolves.
const USERS_PAGE_QUERY = `query Users($after: String) {
  users(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id name email }
  }
}`

const TEAMS_QUERY = `query Teams {
  teams(first: 250) { nodes { id key name } }
}`

type LinearIssueNode = {
  id: string
  identifier?: string | null
  title?: string | null
  url?: string | null
  priority?: number | null
  updatedAt?: string | null
  state?: { name?: string | null; type?: string | null } | null
  assignee?: { id?: string | null; name?: string | null } | null
  team?: { id?: string | null; key?: string | null } | null
}

const asDate = (value: string | null | undefined): Date | null => {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Map a Linear issue node (from sync or a webhook payload) to a row upsert. */
async function upsertIssue(conn: typeof linearConnection.$inferSelect, node: LinearIssueNode) {
  if (!node?.id) return
  const values = {
    connectionId: conn.id,
    orgId: conn.orgId,
    linearId: node.id,
    identifier: node.identifier ?? null,
    title: node.title ?? null,
    state: node.state?.name ?? null,
    stateType: node.state?.type ?? null,
    assigneeId: node.assignee?.id ?? null,
    assigneeName: node.assignee?.name ?? null,
    teamId: node.team?.id ?? null,
    teamKey: node.team?.key ?? null,
    priority: typeof node.priority === "number" ? node.priority : null,
    url: node.url ?? null,
    updatedAt: asDate(node.updatedAt),
    raw: node as Record<string, unknown>,
    syncedAt: new Date(),
  }
  await db
    .insert(linearIssue)
    .values(values)
    .onConflictDoUpdate({
      target: [linearIssue.orgId, linearIssue.linearId],
      set: {
        connectionId: values.connectionId,
        identifier: values.identifier,
        title: values.title,
        state: values.state,
        stateType: values.stateType,
        assigneeId: values.assigneeId,
        assigneeName: values.assigneeName,
        teamId: values.teamId,
        teamKey: values.teamKey,
        priority: values.priority,
        url: values.url,
        updatedAt: values.updatedAt,
        raw: values.raw,
        syncedAt: values.syncedAt,
      },
    })
}

// ── connect / disconnect / status ───────────────────────────────────────────

export async function connectLinear(req: Request) {
  // Admin-only: one org-wide API key + webhook secret drives the Ticket mirror
  // for every member.
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const body = (await req.json().catch(() => null)) as {
    apiKey?: string
    webhookSecret?: string
  } | null
  const token = body?.apiKey?.trim()
  if (!token) return json({ error: "API_KEY_REQUIRED" }, 400)

  let viewer: { id?: string; name?: string }
  try {
    const data = await linearGraphQL<{ viewer?: { id?: string; name?: string } }>(
      token,
      VIEWER_QUERY,
    )
    if (!data?.viewer?.id) throw new Error("viewer query returned no user")
    viewer = data.viewer
  } catch (error) {
    // Bad key / unreachable host → surface as an auth failure, not a 500. The
    // upstream body goes to the log, not the client (see integrations/errors.ts).
    return json(
      { error: "INVALID_API_KEY", detail: connectorFailure("linear", "connect", error) },
      400,
    )
  }

  const existing = await connectionForOrg(org.orgId)
  const webhookSecret = body?.webhookSecret?.trim()
  const values = {
    orgId: org.orgId,
    userId: org.actor,
    token: encryptToken(token),
    webhookToken: existing?.webhookToken ?? randomUUID(),
    webhookSecret: webhookSecret ? encryptToken(webhookSecret) : (existing?.webhookSecret ?? null),
    viewerId: viewer.id ?? null,
    viewerName: viewer.name ?? null,
    status: "connected",
    disconnectedAt: null,
    lastError: null,
  }
  const [connection] = existing
    ? await db
        .update(linearConnection)
        .set(values)
        .where(eq(linearConnection.id, existing.id))
        .returning()
    : await db.insert(linearConnection).values(values).returning()
  if (!connection) return json({ error: "CONNECTION_WRITE_FAILED" }, 500)
  await audit({
    orgId: org.orgId,
    userId: org.actor,
    connectionId: connection.id,
    action: "connect",
    detail: { viewerId: viewer.id },
  })
  if ((await readIntegrationSettings(org.orgId)).linearSyncEnabled) {
    await syncLinearConnection(connection.id).catch((error) =>
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

export async function disconnectLinear(req: Request) {
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ ok: true })
  await db
    .update(linearConnection)
    .set({ status: "disconnected", token: null, disconnectedAt: new Date() })
    .where(eq(linearConnection.id, connection.id))
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
  const base = process.env.LINEAR_WEBHOOK_BASE_URL ?? process.env.BETTER_AUTH_URL ?? ""
  const path = `/api/integrations/linear/webhook?token=${encodeURIComponent(token)}`
  return base ? `${base.replace(/\/+$/, "")}${path}` : path
}

async function statusPayload(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  // Linear auth is a per-org key (no server-side OAuth creds), so it is never
  // "disabled" the way Google is — `configured` is always true.
  if (connection?.status !== "connected") {
    return json({ configured: true, connected: false })
  }
  return json({
    configured: true,
    connected: true,
    viewerId: connection.viewerId,
    viewerName: connection.viewerName,
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
    webhookUrl: webhookUrlFor(connection.webhookToken),
    webhookConfigured: Boolean(connection.webhookSecret),
  })
}

export const linearStatus = (req: Request) => statusPayload(req)

// ── Kahuna concept mirror (Phase 1) ────────────────────────────────────────

/** Linear's stable workflow-state taxonomy — a closed set, so it maps cleanly
 *  onto a KM `enum` field (which a Kanban widget groups into columns). Issue
 *  state NAMES are team-defined and open-ended, so we mirror the `type`. */
const LINEAR_STATE_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"] as const
const KNOWN_STATE_TYPES = new Set<string>(LINEAR_STATE_TYPES)

/**
 * The org-local concept synced issues mirror into, so the generic List/Kanban/
 * Calendar widgets can render them. Generic data fields only — never the raw
 * payload (PII minimization). `identifier` is the unique external key the upsert
 * dedupes on. Field display names are decorative; everything keys off field ids.
 */
const TICKET_CONCEPT: ProvisionConceptSpec = {
  name: "Linear - Ticket",
  pluralName: "Linear - Tickets",
  description: "Issues synced from Linear.",
  icon: "lucide:Triangle",
  color: "#8b5cf6",
  managedBy: "linear",
  titleFieldKey: "title",
  fields: [
    { key: "identifier", name: "Identifier", kind: "text", config: { unique: true }, icon: "🔖" },
    { key: "title", name: "Title", kind: "text" },
    { key: "status", name: "Status", kind: "enum", config: { options: [...LINEAR_STATE_TYPES] } },
    { key: "assignee", name: "Assignee", kind: "text", icon: "👤" },
    { key: "team", name: "Team", kind: "text" },
    { key: "priority", name: "Priority", kind: "number" },
    { key: "url", name: "URL", kind: "text" },
    { key: "updatedAt", name: "Updated", kind: "date", icon: "📅" },
  ],
}

const scopeOf = (conn: typeof linearConnection.$inferSelect): OrgScope =>
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

/**
 * Ensure the org's Ticket concept exists and return `{ conceptId, fieldMap }`.
 * Reuses the ids already stored on the connection when present (so a later
 * concept/field rename never re-provisions); otherwise provisions once and
 * persists the ids back onto the connection row.
 */
async function ensureTicketConcept(
  conn: typeof linearConnection.$inferSelect,
): Promise<ProvisionedConcept> {
  if (conn.conceptId && conn.fieldMap && Object.keys(conn.fieldMap).length > 0) {
    return { conceptId: conn.conceptId, fieldMap: conn.fieldMap }
  }
  const provisioned = await provisionConcept(scopeOf(conn), TICKET_CONCEPT)
  await db
    .update(linearConnection)
    .set({ conceptId: provisioned.conceptId, fieldMap: provisioned.fieldMap })
    .where(eq(linearConnection.id, conn.id))
  return provisioned
}

/** Map a Linear issue node to a KM record version patch keyed by field id, via the
 *  stored field map. Only typed columns — never the raw payload. */
const ticketFieldsFor = (
  node: LinearIssueNode,
  fieldMap: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    const id = fieldMap[key]
    if (id && value !== undefined && value !== null && value !== "") out[id] = value
  }
  set("identifier", node.identifier)
  set("title", node.title)
  const stateType = node.state?.type
  if (stateType && KNOWN_STATE_TYPES.has(stateType)) set("status", stateType)
  set("assignee", node.assignee?.name)
  set("team", node.team?.key)
  if (typeof node.priority === "number") set("priority", node.priority)
  set("url", node.url)
  set("updatedAt", node.updatedAt)
  return out
}

/** Mirror one issue into the org's Ticket concept (idempotent, keyed by
 *  `identifier`). No-ops if the issue has no identifier to key on. */
async function upsertTicketRecordVersion(
  conn: typeof linearConnection.$inferSelect,
  ticket: ProvisionedConcept,
  node: LinearIssueNode,
) {
  const identifierFieldId = ticket.fieldMap.identifier
  const identifier = node.identifier
  if (!identifierFieldId || !identifier) return
  await upsertRecordVersionByExternalId(scopeOf(conn), {
    conceptId: ticket.conceptId,
    externalFieldId: identifierFieldId,
    externalValue: identifier,
    fields: ticketFieldsFor(node, ticket.fieldMap),
  })
}

// ── sync ──────────────────────────────────────────────────────────────────────

export async function syncLinearForRequest(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (!connection) return json({ error: "NO_LINEAR_CONNECTION" }, 404)
  if (!(await readIntegrationSettings(org.orgId)).linearSyncEnabled) {
    return json({ error: "SYNC_DISABLED" }, 403)
  }
  await syncLinearConnection(connection.id)
  return json({ ok: true })
}

export async function syncLinearConnection(connectionId: string) {
  const [connection] = await db
    .select()
    .from(linearConnection)
    .where(eq(linearConnection.id, connectionId))
    .limit(1)
  if (connection?.status !== "connected") return
  const token = tokenFor(connection)
  try {
    // Provision (or reuse) the org's Ticket concept BEFORE the first upsert, so
    // synced issues land as record versions the generic widgets can render.
    const ticket = await ensureTicketConcept(connection)
    let after: string | null = null
    let pages = 0
    do {
      const data: {
        issues?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: LinearIssueNode[]
        }
      } = await linearGraphQL(token, ISSUES_QUERY, { after })
      for (const node of data.issues?.nodes ?? []) {
        await upsertIssue(connection, node)
        await upsertTicketRecordVersion(connection, ticket, node)
      }
      after = data.issues?.pageInfo?.hasNextPage ? (data.issues.pageInfo.endCursor ?? null) : null
      pages += 1
    } while (after && pages < 100)
    await db
      .update(linearConnection)
      .set({ lastSyncAt: new Date(), lastError: null })
      .where(eq(linearConnection.id, connection.id))
    await audit({
      orgId: connection.orgId,
      userId: connection.userId,
      connectionId: connection.id,
      action: "sync",
    })
  } catch (error) {
    await db
      .update(linearConnection)
      // Sanitized: this is served to every member via `…/status`.
      .set({ lastError: publicConnectorError(error) })
      .where(eq(linearConnection.id, connection.id))
    throw error
  }
}

/** Synced issues for the active org — surfaceable on record versions/widgets later. */
export async function listLinearIssues(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const rows = await pool.query(
    `SELECT linear_id, identifier, title, state, state_type, assignee_name, team_key, priority, url, updated_at, synced_at
       FROM linear_issue
      WHERE org_id = $1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 500`,
    [org.orgId],
  )
  return json({ issues: rows.rows })
}

// ── webhook ─────────────────────────────────────────────────────────────────

type LinearWebhookBody = {
  action?: string
  type?: string
  data?: (LinearIssueNode & Record<string, unknown>) | null
}

/**
 * Inbound webhook receiver. The org is resolved from a per-connection `?token=`
 * (Linear's payload carries no org reference). Deliveries are then verified by
 * recomputing the HMAC-SHA256 of the raw body with the stored webhook secret and
 * timing-safe-comparing it to the `linear-signature` header. Deduped by a body
 * hash; Issue events upsert (or, on `remove`, delete) the mirrored row.
 */
export async function handleLinearWebhook(req: Request) {
  const url = new URL(req.url)
  // Header preferred, `?token=` still accepted for already-wired webhooks. This
  // token only ROUTES to the connection; the HMAC below is the authenticator.
  const token = webhookTokenFrom(req, url)
  if (!token) return json({ error: "MISSING_TOKEN" }, 401)
  const [connection] = await db
    .select()
    .from(linearConnection)
    .where(and(eq(linearConnection.webhookToken, token), eq(linearConnection.status, "connected")))
    .limit(1)
  if (!connection) return json({ error: "BAD_TOKEN" }, 403)

  const rawText = await req.text().catch(() => "")
  const secret = decryptToken(connection.webhookSecret)
  if (!secret) return json({ error: "WEBHOOK_SECRET_NOT_CONFIGURED" }, 400)
  const signature = req.headers.get("linear-signature") ?? ""
  const expected = createHmac("sha256", secret).update(rawText).digest("hex")
  const valid =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  if (!valid) return json({ error: "INVALID_SIGNATURE" }, 401)

  // AFTER the HMAC, not after the token lookup: the signature is the
  // authenticator here (the token only routes), so it must run for a disabled
  // org too. 200 so Linear doesn't disable the webhook; before the dedupe insert
  // so a redelivery after re-enabling isn't swallowed as a duplicate.
  if (!(await readIntegrationSettings(connection.orgId)).linearSyncEnabled) {
    return json({ ok: true })
  }

  let body: LinearWebhookBody = {}
  try {
    body = rawText ? (JSON.parse(rawText) as LinearWebhookBody) : {}
  } catch {
    body = {}
  }
  const action = typeof body.action === "string" ? body.action : null
  const entityType = typeof body.type === "string" ? body.type : null
  const entityId = typeof body.data?.id === "string" ? body.data.id : null
  const dedupeKey = `sha:${connection.id}:${createHash("sha256").update(rawText).digest("base64url")}`

  try {
    await db.insert(linearWebhookEvent).values({
      orgId: connection.orgId,
      connectionId: connection.id,
      dedupeKey,
      action,
      entityType,
      entityId,
      payload: body as Record<string, unknown>,
    })
  } catch {
    // Unique-violation on dedupeKey → already processed; ack idempotently.
    return json({ ok: true, deduped: true })
  }

  if (entityType === "Issue" && body.data?.id) {
    if (action === "remove") {
      await db
        .delete(linearIssue)
        .where(and(eq(linearIssue.orgId, connection.orgId), eq(linearIssue.linearId, body.data.id)))
    } else {
      await upsertIssue(connection, body.data)
    }
  }
  await audit({
    orgId: connection.orgId,
    userId: connection.userId,
    connectionId: connection.id,
    action: "webhook",
    subjectKind: entityType,
    subjectId: entityId,
    detail: { action },
  })
  return json({ ok: true })
}

// ── write-back ──────────────────────────────────────────────────────────────

type IssueUpdateResult = { issueUpdate?: { success?: boolean; issue?: LinearIssueNode | null } }

/**
 * Push a field change back to Linear via `issueUpdate`. Generic input (stateId,
 * assigneeId, title, priority, …) — the caller decides what to set. On success
 * the returned issue node is re-mirrored so the local row stays consistent.
 */
export async function updateLinearIssue(
  conn: typeof linearConnection.$inferSelect,
  issueId: string,
  input: Record<string, unknown>,
): Promise<LinearIssueNode | null> {
  const token = tokenFor(conn)
  const data = await linearGraphQL<IssueUpdateResult>(token, ISSUE_UPDATE_MUTATION, {
    id: issueId,
    input,
  })
  const issue = data.issueUpdate?.issue ?? null
  if (issue) await upsertIssue(conn, issue)
  return issue
}

/**
 * Move an issue into its team's first `completed`-type workflow state — the
 * Linear equivalent of "closing". Resolves the target state generically rather
 * than hardcoding a state name, then delegates to `updateLinearIssue`.
 */
export async function closeLinearIssue(
  conn: typeof linearConnection.$inferSelect,
  issueId: string,
): Promise<LinearIssueNode | null> {
  const token = tokenFor(conn)
  const data = await linearGraphQL<{
    issue?: { team?: { states?: { nodes?: Array<{ id: string }> } } }
  }>(token, ISSUE_CLOSE_QUERY, { id: issueId })
  const stateId = data.issue?.team?.states?.nodes?.[0]?.id
  if (!stateId) {
    const err = new Error("No completed workflow state found for issue's team")
    ;(err as Error & { code?: string }).code = "NO_COMPLETED_STATE"
    throw err
  }
  return updateLinearIssue(conn, issueId, { stateId })
}

/**
 * Add a comment to an issue. The cheapest write-back: `issueId` + `body`, no id
 * resolution. Deliberately NOT re-mirrored — comments have no local table and no
 * place in `TICKET_CONCEPT`, so the only trace is the audit row.
 */
export async function commentOnLinearIssue(
  conn: typeof linearConnection.$inferSelect,
  issueId: string,
  body: string,
): Promise<{ id: string; url?: string | null } | null> {
  const data = await linearGraphQL<{
    commentCreate?: { success?: boolean; comment?: { id: string; url?: string | null } | null }
  }>(tokenFor(conn), COMMENT_CREATE_MUTATION, { input: { issueId, body } })
  return data.commentCreate?.comment ?? null
}

/** Create an issue. `teamId` is mandatory in Linear's schema — there is no
 *  workspace default — so the caller must resolve one (see `listLinearTeams`). */
export async function createLinearIssue(
  conn: typeof linearConnection.$inferSelect,
  input: { teamId: string; title: string; description?: string },
): Promise<LinearIssueNode | null> {
  const data = await linearGraphQL<{
    issueCreate?: { success?: boolean; issue?: LinearIssueNode | null }
  }>(tokenFor(conn), ISSUE_CREATE_MUTATION, { input })
  const issue = data.issueCreate?.issue ?? null
  if (issue) await upsertIssue(conn, issue)
  return issue
}

/** The workspace's teams, for a `createIssue` team picker. Not cached in a table:
 *  teams are few and change rarely, and a cache would be one more thing to sync. */
export async function listLinearTeams(
  conn: typeof linearConnection.$inferSelect,
): Promise<Array<{ id: string; key: string; name: string }>> {
  const data = await linearGraphQL<{
    teams?: { nodes?: Array<{ id: string; key: string; name: string }> }
  }>(tokenFor(conn), TEAMS_QUERY)
  return data.teams?.nodes ?? []
}

type LinearUserNode = { id: string; name?: string | null; email?: string | null }

/**
 * Linear user id for an email, or null when nobody matches.
 *
 * Tries the server-side filter first, then falls back to paging the member list
 * and matching in memory. The fallback is not paranoia: `UserFilter`'s comparator
 * shape is the one part of this we could not confirm from the published schema,
 * and a wrong guess would otherwise turn every assign into a silent miss.
 * Comparison is case-insensitive — addresses are, and KM does not normalize.
 */
export async function linearUserIdForEmail(
  conn: typeof linearConnection.$inferSelect,
  email: string,
): Promise<string | null> {
  const token = tokenFor(conn)
  const wanted = email.trim().toLowerCase()
  if (!wanted) return null
  try {
    const data = await linearGraphQL<{ users?: { nodes?: LinearUserNode[] } }>(
      token,
      USER_BY_EMAIL_QUERY,
      { email: email.trim() },
    )
    const hit = data.users?.nodes?.[0]
    if (hit?.id) return hit.id
  } catch {
    // Fall through to the page-and-match path below.
  }
  let after: string | null = null
  for (let page = 0; page < 8; page += 1) {
    const data: {
      users?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: LinearUserNode[] }
    } = await linearGraphQL(token, USERS_PAGE_QUERY, { after })
    const hit = data.users?.nodes?.find((u) => u.email?.trim().toLowerCase() === wanted)
    if (hit?.id) return hit.id
    if (!data.users?.pageInfo?.hasNextPage) break
    after = data.users.pageInfo.endCursor ?? null
    if (!after) break
  }
  return null
}

/**
 * Linear's global issue uuid for a KM record, or null when the record isn't a
 * mirrored ticket.
 *
 * TWO HOPS, because the mirror and the API disagree about identity: the Ticket
 * concept keys record versions on the human `identifier` ("ENG-123"), while every
 * GraphQL mutation wants the uuid. `linear_issue` is the only place both live
 * side by side, and `linear_issue_org_identifier_idx` covers the lookup.
 */
export async function linearIssueIdForRecordVersion(
  conn: typeof linearConnection.$inferSelect,
  recordVersion: { readonly conceptId: string; readonly state: Record<string, unknown> },
): Promise<string | null> {
  // Guard first: an automation can be pointed at any concept, and a non-ticket
  // record must read as "not applicable", not as a failed lookup.
  if (!conn.conceptId || recordVersion.conceptId !== conn.conceptId) return null
  const identifierFieldId = conn.fieldMap.identifier
  if (!identifierFieldId) return null
  const identifier = recordVersion.state[identifierFieldId]
  if (typeof identifier !== "string" || !identifier) return null
  const { rows } = await pool.query<{ linear_id: string }>(
    `SELECT linear_id FROM linear_issue WHERE org_id = $1 AND identifier = $2 LIMIT 1`,
    [conn.orgId, identifier],
  )
  return rows[0]?.linear_id ?? null
}

export async function updateLinearIssueForRequest(req: Request, issueId: string) {
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_LINEAR_CONNECTION" }, 404)
  const body = (await req.json().catch(() => null)) as { input?: Record<string, unknown> } | null
  const input = body?.input
  if (!input || typeof input !== "object") return json({ error: "INPUT_REQUIRED" }, 400)
  try {
    const issue = await updateLinearIssue(connection, issueId, input)
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "writeback.update",
      subjectKind: "Issue",
      subjectId: issueId,
    })
    return json({ ok: true, issue })
  } catch (error) {
    return json(
      { error: "WRITE_BACK_FAILED", detail: connectorFailure("linear", "writeback.update", error) },
      502,
    )
  }
}

export async function closeLinearIssueForRequest(req: Request, issueId: string) {
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const connection = await connectionForOrg(org.orgId)
  if (connection?.status !== "connected") return json({ error: "NO_LINEAR_CONNECTION" }, 404)
  try {
    const issue = await closeLinearIssue(connection, issueId)
    await audit({
      orgId: org.orgId,
      userId: org.actor,
      connectionId: connection.id,
      action: "writeback.close",
      subjectKind: "Issue",
      subjectId: issueId,
    })
    return json({ ok: true, issue })
  } catch (error) {
    const code = (error as Error & { code?: string }).code
    if (code === "NO_COMPLETED_STATE") return json({ error: code }, 400)
    return json(
      { error: "WRITE_BACK_FAILED", detail: connectorFailure("linear", "writeback.close", error) },
      502,
    )
  }
}
