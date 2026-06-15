import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { OrgScope } from "@kingsmaker/engine"
import { and, eq } from "drizzle-orm"
import { linearAuditLog, linearConnection, linearIssue, linearWebhookEvent } from "./auth-schema"
import { db, pool } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import {
  type ProvisionConceptSpec,
  type ProvisionedConcept,
  provisionConcept,
  upsertInstanceByExternalId,
} from "./integrations/instances"
import { resolveOrg } from "./session"

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
    const retryAfter = Number(res.headers.get("retry-after"))
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 300 * 2 ** attempt
    await new Promise((resolve) => setTimeout(resolve, delay))
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
  await db.insert(linearAuditLog).values({
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
    .from(linearConnection)
    .where(eq(linearConnection.orgId, orgId))
    .limit(1)
  return row ?? null
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
  const org = await resolveOrg(req)
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
    // Bad key / unreachable host → surface as an auth failure, not a 500.
    return json({ error: "INVALID_API_KEY", detail: String(error) }, 400)
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
  if (process.env.LINEAR_SYNC_ENABLED !== "0") {
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
  const org = await resolveOrg(req)
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

// ── Kingsmaker concept mirror (Phase 1) ────────────────────────────────────────

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

const scopeOf = (conn: typeof linearConnection.$inferSelect): OrgScope => ({
  orgId: conn.orgId,
  actor: conn.userId,
})

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

/** Map a Linear issue node to a KM instance patch keyed by field id, via the
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
async function upsertTicketInstance(
  conn: typeof linearConnection.$inferSelect,
  ticket: ProvisionedConcept,
  node: LinearIssueNode,
) {
  const identifierFieldId = ticket.fieldMap.identifier
  const identifier = node.identifier
  if (!identifierFieldId || !identifier) return
  await upsertInstanceByExternalId(scopeOf(conn), {
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
    // synced issues land as instances the generic widgets can render.
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
        await upsertTicketInstance(connection, ticket, node)
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
      .set({ lastError: String(error) })
      .where(eq(linearConnection.id, connection.id))
    throw error
  }
}

/** Synced issues for the active org — surfaceable on instances/widgets later. */
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
  const token = url.searchParams.get("token")
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

export async function updateLinearIssueForRequest(req: Request, issueId: string) {
  const org = await resolveOrg(req)
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
    return json({ error: "WRITE_BACK_FAILED", detail: String(error) }, 502)
  }
}

export async function closeLinearIssueForRequest(req: Request, issueId: string) {
  const org = await resolveOrg(req)
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
    return json({ error: "WRITE_BACK_FAILED", detail: String(error) }, 502)
  }
}
