import { Etag, FileSystem, HttpPlatform, Path } from "@effect/platform"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import type { PgClient } from "@effect/sql-pg"
import { Effect, Layer } from "effect"
import {
  type AccessAction,
  type AccessResource,
  type AccessResourceType,
  decide,
  type EngineServices,
  OrgContext,
  type OrgScope,
} from "#engine"
import {
  type AccessGrant,
  type AccessRole,
  type AccessRule,
  type AnnotationField,
  type Attachment,
  type Automation,
  type AutomationDryRun,
  type AutomationRun,
  type Concept,
  type ConceptGraph,
  type Dashboard,
  type DeactivatedMember,
  type EffectiveAccess,
  type Field,
  type GraphLayout,
  type Instance,
  type InstanceDetail,
  type InstancePick,
  type InstanceViewPrefs,
  type Item,
  KingsmakerRpcs,
  type Label,
  type Note,
  type Relation,
  RpcError,
  type SidebarView,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskSubjectRef,
} from "../rpc/contract"
import { auth } from "./auth"
import { pool } from "./db"
import { isAdminRole } from "./policy"
import { EngineBase, ERROR_MAP, resolvePolicy, sessionScope } from "./runtime"
import { isDeactivated, roleOf } from "./session"
import * as uc from "./use-cases"

/**
 * `listInstances` cap. The engine's `findInstances` defaults to 100 — fine for a
 * paged table, but every dashboard widget (metric/breakdown/calendar/gantt)
 * aggregates or plots over the WHOLE concept, so a 100-row cap silently drops
 * data: e.g. a Calendar over a synced source with thousands of events shows
 * almost nothing (the 100 newest by creation rarely land in the viewed month).
 * Raise it to cover realistic concepts. NOTE: a true fix for unbounded concepts
 * is date-windowed loading for the date-plotting widgets — follow-up.
 */
const LIST_INSTANCES_LIMIT = 50_000

/**
 * Per-request auth: derive OrgContext (org_id + actor) from the session cookie
 * in the request headers. Provided to every handler; fails the RPC otherwise.
 */
export class AuthMiddleware extends RpcMiddleware.Tag<AuthMiddleware>()(
  "kingsmaker/AuthMiddleware",
  {
    provides: OrgContext,
    failure: RpcError,
  },
) {}

const AuthMiddlewareLive = Layer.succeed(AuthMiddleware, (options) =>
  Effect.gen(function* () {
    const headers = new Headers(options.headers as Record<string, string>)
    const session = yield* Effect.tryPromise({
      try: () => auth.api.getSession({ headers }),
      catch: () =>
        new RpcError({ code: "INTERNAL", message: "session lookup failed", status: 500 }),
    })
    if (!session?.user) {
      return yield* Effect.fail(
        new RpcError({ code: "UNAUTHENTICATED", message: "Not signed in", status: 401 }),
      )
    }
    const orgId = session.session.activeOrganizationId
    if (!orgId) {
      return yield* Effect.fail(
        new RpcError({ code: "NO_ACTIVE_ORG", message: "No active org", status: 409 }),
      )
    }
    const role = yield* Effect.tryPromise({
      try: () => roleOf(session.user.id, orgId),
      catch: () => new RpcError({ code: "INTERNAL", message: "role lookup failed", status: 500 }),
    })
    if (!role) {
      return yield* Effect.fail(
        new RpcError({ code: "NOT_A_MEMBER", message: "Not a member", status: 403 }),
      )
    }
    const deactivated = yield* Effect.tryPromise({
      try: () => isDeactivated(session.user.id, orgId),
      catch: () =>
        new RpcError({ code: "INTERNAL", message: "deactivation lookup failed", status: 500 }),
    })
    if (deactivated) {
      return yield* Effect.fail(
        new RpcError({ code: "DEACTIVATED", message: "Member is deactivated", status: 403 }),
      )
    }
    // The caller's access rules, resolved ONCE for the request: a list read needs
    // the whole set before it can filter, and PolicyService memoizes on the org's
    // policy generation, so this is one indexed lookup on the warm path.
    //
    // Via `resolvePolicy` (which runs on AppRuntime) rather than requiring the
    // service here: this middleware is typed `R = never`, so it cannot carry an
    // engine requirement. `resolvePolicy` never fails — it falls back to the empty
    // rule set, which grants nothing beyond resource defaults.
    const policy = yield* Effect.promise(() => resolvePolicy(orgId, session.user.id))
    // The role resolved above rides along: read visibility is enforced inside the
    // engine off `OrgContext.role` (see OrgContext.ts). `sessionScope`'s signature
    // is what guarantees a request can never claim engine ("system") privilege.
    return sessionScope(orgId, session.user.id, role, policy) satisfies OrgScope
  }),
)

/** User-facing fallbacks for domain errors whose payload carries no human
 *  `message` field. Effect renders such an error's `.message` as a JSON dump of
 *  its props (e.g. `{"instanceId":"…"}`), which must never reach a user — these
 *  override it with prose. Errors that DO carry a `message` (e.g.
 *  FieldValidationError) keep their own, more specific text. */
const ERROR_MESSAGE: Record<string, string> = {
  // Deliberately prescribes no fix: whether a new draft is the only way out
  // depends on the concept's edit-reach setting.
  VersionFrozen: "This version is published and can't be edited.",
  VersionConflict: "This record was changed elsewhere. Reload and try again.",
  InstanceNotFound: "This record no longer exists.",
  ConceptNotFound: "This concept no longer exists.",
  FieldNotFound: "This field no longer exists.",
  RelationNotFound: "That link no longer exists.",
  LabelNotFound: "That label no longer exists.",
  ItemNotFound: "This record no longer exists.",
  ItemNotPublished: "This record has no published version yet.",
}

/** Effect's default `.message` for a fieldless TaggedError is a JSON dump of its
 *  props — not user-facing. Detect it so we fall back to prose instead. */
const isStructDump = (s: string): boolean => s.trimStart().startsWith("{")

/** Last-resort humanization of a tag: "VersionFrozen" → "Version frozen". */
const humanizeTag = (tag: string): string => {
  const spaced = tag.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return spaced.charAt(0) + spaced.slice(1).toLowerCase()
}

/** Map any engine failure to the single serializable RpcError (mirrors HTTP codes).
 *  Mapped (domain) errors are user-facing by construction: pass their human
 *  message through (e.g. `field "title" is required`), but fall back to prose for
 *  errors whose message is just a JSON dump of their props. Anything unmapped
 *  stays an opaque INTERNAL. */
const toRpcError = (e: unknown): RpcError => {
  const tag = typeof e === "object" && e !== null ? (e as { _tag?: string })._tag : undefined
  const mapped = tag ? ERROR_MAP[tag] : undefined
  if (!mapped || !tag)
    return new RpcError({ code: "INTERNAL", message: "Internal error", status: 500 })
  const detail = (e as { message?: unknown }).message
  const message =
    typeof detail === "string" && detail.length > 0 && !isStructDump(detail)
      ? detail
      : (ERROR_MESSAGE[tag] ?? humanizeTag(tag))
  return new RpcError({ code: mapped.code, message, status: mapped.status })
}

// R-agnostic (it only rewraps the error channel), so it also passes through the
// `PgClient` a self-transacting use-case carries — see `adminSql`.
const mapErr = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(Effect.catchAll((e) => Effect.fail(toRpcError(e))))

/**
 * THE WRITE GATE. Resolves `action` against the caller's access rules, falling back
 * to the role-derived default — so an org with no rules behaves exactly as it did
 * under `policy.ts:can()`.
 *
 * Both inputs come off the scope AuthMiddleware already resolved, so this costs no
 * lookup. `"system"` is refused outright: an engine-level caller must never arrive
 * over HTTP, and `sessionScope`'s type makes that unreachable — this is the
 * belt-and-braces check that survives a future refactor.
 */
const requireAction = (
  action: AccessAction,
  resource: AccessResource = { type: "org" },
): Effect.Effect<void, RpcError, OrgContext> =>
  Effect.gen(function* () {
    const scope = yield* OrgContext
    if (scope.role === "system") {
      return yield* Effect.fail(
        new RpcError({ code: "FORBIDDEN", message: "Admin only", status: 403 }),
      )
    }
    // The DEFAULT: exactly what `can(role, "admin")` answered before — `configure` is
    // owner/admin-only; every other action was open to any member.
    const fallback = action === "configure" || action === "delete" ? isAdminRole(scope.role) : true
    const allowed = scope.policy
      ? decide(scope.policy, action, resource, fallback, { unconditionalOnly: true })
      : fallback
    if (!allowed) {
      return yield* Effect.fail(
        new RpcError({ code: "FORBIDDEN", message: "Admin only", status: 403 }),
      )
    }
  })

/** The gate every schema-mutating RPC used before actions existed. Kept as the name
 *  ~40 handlers already read well with; `configure` is what it always meant. */
const requireAdmin: Effect.Effect<void, RpcError, OrgContext> = requireAction("configure")

/** Run an admin-only use-case behind the gate, mapping engine errors. */
const admin = <A>(eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
  requireAdmin.pipe(Effect.zipRight(as<A>(eff)))

/**
 * `admin` for a use-case that opens its OWN transaction, so it also needs
 * `PgClient` (only `deleteConcept`'s single-record cascade, so far). `EngineBase`
 * is built with `provideMerge` and therefore surfaces `PgClient` — the extra
 * requirement is satisfied by the same layer, it just can't be hidden behind
 * `as`'s narrower cast.
 */
const adminSql = <A>(
  eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices | PgClient.PgClient>,
) =>
  requireAdmin.pipe(Effect.zipRight(mapErr(eff))) as Effect.Effect<
    A,
    RpcError,
    OrgContext | EngineServices | PgClient.PgClient
  >

// Casting helper for the loosely-typed (UC<unknown>) use-cases — runtime values
// already match the wire schema; this just informs the handler's return type.
const as = <A>(eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
  mapErr(eff) as Effect.Effect<A, RpcError, OrgContext | EngineServices>

/**
 * Enforce that every `user`-kind field value is a real member of the org. The
 * engine treats a user id as an opaque logical FK (like org_id / actor) and never
 * touches the auth tables, so membership — an auth-tier concern — is validated
 * here against `bauth_member` via the shared pool (the same way auth.ts reaches
 * engine tables). Throws RpcError(422) listing any non-members.
 */
export async function assertMembers(
  orgId: string,
  conceptId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const defs = await pool.query<{ id: string }>(
    "SELECT id FROM fields WHERE org_id = $1 AND concept_id = $2 AND kind = 'user' AND archived_at IS NULL",
    [orgId, conceptId],
  )
  if (defs.rows.length === 0) return
  const ids = new Set<string>()
  for (const { id } of defs.rows) {
    const v = values[id]
    if (Array.isArray(v)) {
      for (const x of v) if (typeof x === "string") ids.add(x)
    } else if (typeof v === "string") {
      ids.add(v)
    }
  }
  if (ids.size === 0) return
  // Deactivated members are excluded: a deactivated user is blocked from the org
  // at every entry point, so assigning work to them would create a value nobody
  // can act on (and the pickers already filter them out).
  const members = await pool.query<{ user_id: string }>(
    `SELECT m.user_id FROM bauth_member m
      WHERE m.organization_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM member_deactivations d
           WHERE d.org_id = m.organization_id AND d.user_id = m.user_id
        )`,
    [orgId],
  )
  const present = new Set(members.rows.map((r) => r.user_id))
  const missing = [...ids].filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new RpcError({
      code: "VALIDATION",
      message: `not org members: ${missing.join(", ")}`,
      status: 422,
    })
  }
}

/** Resolve an instance's concept, then run the member check against the patch. */
async function assertMembersForInstance(
  orgId: string,
  instanceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const r = await pool.query<{ concept_id: string }>(
    "SELECT concept_id FROM instances WHERE id = $1 AND org_id = $2 LIMIT 1",
    [instanceId, orgId],
  )
  const conceptId = r.rows[0]?.concept_id
  if (conceptId) await assertMembers(orgId, conceptId, patch)
}

/** A task's assignee must be a real, ACTIVE org member (the engine treats it as an
 *  opaque logical FK; membership is an auth-tier concern validated here). A
 *  deactivated member is rejected — same rule as `assertMembers`. No-op when unset. */
export async function assertAssigneeMember(
  orgId: string,
  assignee: string | null | undefined,
): Promise<void> {
  if (!assignee) return
  const members = await pool.query<{ user_id: string }>(
    `SELECT m.user_id FROM bauth_member m
      WHERE m.organization_id = $1 AND m.user_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM member_deactivations d
           WHERE d.org_id = m.organization_id AND d.user_id = m.user_id
        )
      LIMIT 1`,
    [orgId, assignee],
  )
  if (members.rows.length === 0) {
    throw new RpcError({
      code: "VALIDATION",
      message: `not an active org member: ${assignee}`,
      status: 422,
    })
  }
}

/** Author/assignee/admin gate for mutating (or purging) an annotation. The engine
 *  stays permission-agnostic (org scope only), so this lives at the boundary like
 *  `requireAdmin`/`assertMembers`. A missing row is allowed through so the engine
 *  surfaces the canonical AnnotationNotFound. */
async function assertCanMutateAnnotation(orgId: string, actor: string, id: string): Promise<void> {
  const r = await pool.query<{ created_by: string | null; assignee: string | null }>(
    "SELECT created_by, assignee FROM annotations WHERE id = $1 AND org_id = $2 LIMIT 1",
    [id, orgId],
  )
  const row = r.rows[0]
  if (!row) return
  if (row.created_by === actor || row.assignee === actor) return
  const role = await roleOf(actor, orgId)
  if (role && isAdminRole(role)) return
  throw new RpcError({
    code: "FORBIDDEN",
    message: "Only the author, assignee, or an admin may modify this",
    status: 403,
  })
}

/** Uploader/admin gate for mutating (or purging) a file — the attachment
 *  analogue of `assertCanMutateAnnotation` (a missing row passes through so the
 *  engine surfaces the canonical AttachmentNotFound). */
async function assertCanMutateAttachment(orgId: string, actor: string, id: string): Promise<void> {
  const r = await pool.query<{ created_by: string | null }>(
    "SELECT created_by FROM attachments WHERE id = $1 AND org_id = $2 LIMIT 1",
    [id, orgId],
  )
  const row = r.rows[0]
  if (!row) return
  if (row.created_by === actor) return
  const role = await roleOf(actor, orgId)
  if (role && isAdminRole(role)) return
  throw new RpcError({
    code: "FORBIDDEN",
    message: "Only the uploader or an admin may modify this file",
    status: 403,
  })
}

/** Same rule as one file, applied to a whole widget bucket: you may discard it if
 *  you uploaded everything in it, otherwise it takes an admin. An empty bucket
 *  passes (the purge is then a no-op). */
async function assertCanPurgeBucket(orgId: string, actor: string, bucketId: string): Promise<void> {
  const r = await pool.query<{ created_by: string | null }>(
    "SELECT DISTINCT created_by FROM attachments WHERE bucket_id = $1 AND org_id = $2",
    [bucketId, orgId],
  )
  if (r.rows.every((row) => row.created_by === actor)) return
  const role = await roleOf(actor, orgId)
  if (role && isAdminRole(role)) return
  throw new RpcError({
    code: "FORBIDDEN",
    message: "This widget holds files uploaded by someone else — only an admin may delete them",
    status: 403,
  })
}

/** Run an async (orgId, actor) precheck, then the use-case. Generalises `checkThen`
 *  for annotation writes that gate on author/assignee/admin. */
const guarded = <A>(
  precheck: (orgId: string, actor: string) => Promise<void>,
  run: Effect.Effect<A, unknown, OrgContext | EngineServices>,
): Effect.Effect<A, RpcError, OrgContext | EngineServices> =>
  Effect.gen(function* () {
    const { orgId, actor } = yield* OrgContext
    yield* Effect.tryPromise({
      try: () => precheck(orgId, actor),
      catch: (e) =>
        e instanceof RpcError
          ? e
          : new RpcError({ code: "INTERNAL", message: "permission check failed", status: 500 }),
    })
    return yield* mapErr(run)
  })

/** Run an auth-tier pre-check (resolved against the request's scope), then the use-case. */
const checkThen = <A>(
  precheck: (orgId: string, actor: string) => Promise<void>,
  run: Effect.Effect<A, unknown, OrgContext | EngineServices>,
): Effect.Effect<A, RpcError, OrgContext | EngineServices> =>
  Effect.gen(function* () {
    const { orgId, actor } = yield* OrgContext
    yield* Effect.tryPromise({
      try: () => precheck(orgId, actor),
      catch: (e) =>
        e instanceof RpcError
          ? e
          : new RpcError({ code: "INTERNAL", message: "membership check failed", status: 500 }),
    })
    return yield* mapErr(run)
  })

/** Deactivation guards (auth-tier): no self-deactivation, the target must be a
 *  member, and an owner can never be deactivated (mirrors the settings page's
 *  last-owner lock). Admin gating happens separately via `requireAdmin`. */
async function assertDeactivatable(orgId: string, actor: string, userId: string): Promise<void> {
  if (userId === actor) {
    throw new RpcError({
      code: "VALIDATION",
      message: "You can't deactivate yourself",
      status: 422,
    })
  }
  const role = await roleOf(userId, orgId)
  if (!role) throw new RpcError({ code: "NOT_FOUND", message: "Not a member", status: 404 })
  if (role === "owner") {
    throw new RpcError({
      code: "FORBIDDEN",
      message: "An owner can't be deactivated",
      status: 403,
    })
  }
}

const ServerRpcs = KingsmakerRpcs.middleware(AuthMiddleware)

const HandlersLive = ServerRpcs.toLayer({
  listConcepts: ({ includeArchived, withCounts }) =>
    as<ReadonlyArray<Concept>>(uc.listConcepts(includeArchived, withCounts)),
  createConcept: ({ name, color }) => as<Concept>(uc.createConcept(name, color)),
  updateConcept: ({
    id,
    name,
    pluralName,
    description,
    icon,
    color,
    versioningEnabled,
    editReach,
    staticLabelIds,
    defaultLabelIds,
  }) =>
    admin<Concept>(
      uc.updateConcept(id, {
        name,
        pluralName,
        description,
        icon,
        color,
        versioningEnabled,
        editReach,
        staticLabelIds,
        defaultLabelIds,
      }),
    ),
  // Not admin-gated: any member may shape a concept's default instance layout.
  setConceptInstanceView: ({ id, instanceView }) =>
    as<Concept>(uc.setConceptInstanceView(id, instanceView)),
  setFieldVisibility: ({ id, visibility }) => admin<Field>(uc.setFieldVisibility(id, visibility)),
  setConceptVisibility: ({ id, visibility }) =>
    admin<Concept>(uc.setConceptVisibility(id, visibility)),
  setConceptTitleField: ({ id, titleFieldId }) =>
    admin<Concept>(uc.setConceptTitleField(id, titleFieldId)),
  // Admin + the member check `createInstance` does: `fields` seeds a real record,
  // so any `user`-kind value in it must be an actual org member. Without this the
  // toggle would be a hole in a rule every other write path enforces.
  setConceptSingleRecord: ({ conceptId, singleRecord, fields }) =>
    requireAdmin.pipe(
      Effect.zipRight(
        checkThen(
          (orgId) => assertMembers(orgId, conceptId, fields ?? {}),
          uc.setConceptSingleRecord(conceptId, singleRecord, fields),
        ),
      ),
    ) as Effect.Effect<Concept, RpcError, OrgContext | EngineServices>,
  archiveConcept: ({ id }) => admin<Concept>(uc.archiveConcept(id)),
  restoreConcept: ({ id }) => admin<Concept>(uc.restoreConcept(id)),
  // Not `admin`: the single-record cascade needs its own transaction, hence PgClient.
  deleteConcept: ({ id }) => adminSql<Concept>(uc.deleteConcept(id)),
  listLabels: ({ includeArchived }) => as<ReadonlyArray<Label>>(uc.listLabels(includeArchived)),
  createLabel: ({ name, color, primary }) => admin<Label>(uc.createLabel(name, color, primary)),
  renameLabel: ({ id, name, color, primary }) =>
    admin<Label>(uc.renameLabel(id, { name, color, primary })),
  archiveLabel: ({ id }) => admin<Label>(uc.archiveLabel(id)),
  restoreLabel: ({ id }) => admin<Label>(uc.restoreLabel(id)),
  deleteLabel: ({ id }) => admin<Label>(uc.deleteLabel(id)),
  listFields: ({ conceptId, includeArchived }) =>
    as<ReadonlyArray<Field>>(uc.listFields(conceptId, includeArchived)),
  getConceptGraph: () => as<ConceptGraph>(uc.getConceptGraph),
  getGraphLayout: () => as<GraphLayout>(uc.getGraphLayout),
  saveGraphLayout: ({ positions }) => as<GraphLayout>(uc.saveGraphLayout(positions)),
  getInstanceGraphLayout: ({ itemId }) => as<GraphLayout>(uc.getInstanceGraphLayout(itemId)),
  saveInstanceGraphLayout: ({ itemId, positions }) =>
    as<GraphLayout>(uc.saveInstanceGraphLayout(itemId, positions)),
  addField: ({ conceptId, name, kind, config, formula, icon }) =>
    admin<Field>(uc.addField({ conceptId, name, kind, config, formula, icon })),
  updateField: ({ id, name, config, formula, icon }) =>
    admin<Field>(uc.updateField({ id, name, config, formula, icon })),
  archiveField: ({ id }) => admin<Field>(uc.archiveField(id)),
  restoreField: ({ id }) => admin<Field>(uc.restoreField(id)),
  deleteField: ({ id }) => admin<Field>(uc.deleteField(id)),
  reorderFields: ({ conceptId, orders }) =>
    admin<ReadonlyArray<Field>>(uc.reorderFields(conceptId, orders)),
  listInstances: ({ conceptId, includeArchived }) =>
    mapErr(
      uc.listInstances(conceptId, { decorate: true, includeArchived, limit: LIST_INSTANCES_LIMIT }),
    ),
  getInstance: ({ id }) => as<InstanceDetail>(uc.getInstanceDetail(id)),
  getSingleRecord: ({ conceptId }) => as<InstanceDetail | null>(uc.getSingleRecord(conceptId)),
  getChanged: () => mapErr(uc.getChanged),
  listEvents: ({ conceptId, since, limit }) => mapErr(uc.listEvents({ conceptId, since, limit })),
  createInstance: ({ conceptId, fields }) =>
    checkThen(
      (orgId) => assertMembers(orgId, conceptId, fields),
      uc.createInstance(conceptId, fields),
    ),
  updateInstance: ({ id, expectedVersion, patch }) =>
    checkThen(
      (orgId) => assertMembersForInstance(orgId, id, patch),
      uc.updateInstance(id, expectedVersion, patch),
    ),
  transitionInstance: ({ id, expectedVersion, field, to }) =>
    mapErr(uc.transitionInstance(id, expectedVersion, field, to)),
  // Archive/restore are ordinary item writes (any member); a hard delete is
  // admin-only, mirroring the schema-mutating concept/field/label deletes.
  archiveInstance: ({ id, expectedVersion }) => mapErr(uc.archiveInstance(id, expectedVersion)),
  restoreInstance: ({ id, expectedVersion }) => mapErr(uc.restoreInstance(id, expectedVersion)),
  deleteInstance: ({ id }) => admin<Instance>(uc.deleteInstance(id)),
  // Versioning: lifecycle + relation editing are ordinary member writes (the
  // versioning *toggle* is admin, via updateConcept). Discarding a draft is a
  // member write (it only removes never-published work).
  listVersions: ({ itemId }) => mapErr(uc.listVersions(itemId)),
  newVersion: ({ itemId }) => mapErr(uc.newVersion(itemId)),
  publishVersion: ({ id, expectedVersion }) => mapErr(uc.publishVersion(id, expectedVersion)),
  discardDraft: ({ id }) => mapErr(uc.discardDraft(id)),
  archiveItem: ({ itemId }) => as<Item>(uc.archiveItem(itemId)),
  restoreItem: ({ itemId }) => as<Item>(uc.restoreItem(itemId)),
  searchInstances: ({ conceptId, query, limit }) =>
    as<ReadonlyArray<InstancePick>>(uc.searchInstances(conceptId, query, limit)),
  createRelation: ({ fieldId, fromId, toItemId, toVersionId, toId, properties }) =>
    as<Relation>(uc.createRelation({ fieldId, fromId, toItemId, toVersionId, toId, properties })),
  removeRelation: ({ relationId }) => as<Relation>(uc.removeRelation(relationId)),
  // Views: any member may create/edit/reorder/toggle (no admin gate). The engine
  // service blocks touching another user's personal view via its owner scoping.
  listViews: () => as<ReadonlyArray<SidebarView>>(uc.listViews),
  createView: ({ name, icon, scope, body }) =>
    as<SidebarView>(uc.createView({ name, icon, scope, body })),
  updateView: ({ id, name, icon, hidden, scope, body }) =>
    as<SidebarView>(uc.updateView({ id, name, icon, hidden, scope, body })),
  deleteView: ({ id }) => as<SidebarView>(uc.deleteView(id)),
  reorderViews: ({ orders }) => as<ReadonlyArray<SidebarView>>(uc.reorderViews(orders)),
  // Dashboards: same model as views — any member may create/edit/reorder/toggle
  // (no admin gate); the engine service blocks touching another user's personal one.
  listDashboards: () => as<ReadonlyArray<Dashboard>>(uc.listDashboards),
  listAllDashboards: () => as<ReadonlyArray<Dashboard>>(uc.listAllDashboards),
  listRecordDashboards: ({ conceptId }) =>
    as<ReadonlyArray<Dashboard>>(uc.listRecordDashboards(conceptId)),
  createDashboard: ({ name, icon, scope, body, kind, conceptId }) =>
    as<Dashboard>(uc.createDashboard({ name, icon, scope, body, kind, conceptId })),
  updateDashboard: ({ id, name, icon, hidden, scope, body, expectedUpdatedAt }) =>
    as<Dashboard>(uc.updateDashboard({ id, name, icon, hidden, scope, body, expectedUpdatedAt })),
  deleteDashboard: ({ id }) => as<Dashboard>(uc.deleteDashboard(id)),
  reorderDashboards: ({ orders }) => as<ReadonlyArray<Dashboard>>(uc.reorderDashboards(orders)),
  // ── annotation layer: notes ───────────────────────────────────────────────────
  // Create + read are open to any member; edits/archive/purge are author/admin
  // (the note has no assignee). The per-item activity feed is a plain read.
  listNotes: ({ subjectId, includeArchived }) =>
    as<ReadonlyArray<Note>>(uc.listNotes(subjectId, includeArchived)),
  createNote: ({ subjectId, body, customFields }) =>
    as<Note>(uc.createNote({ subjectId, body, customFields })),
  updateNote: ({ id, expectedVersion, body, customFields }) =>
    guarded<Note>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.updateNote({ id, expectedVersion, body, customFields }),
    ),
  archiveNote: ({ id, expectedVersion }) =>
    guarded<Note>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.archiveNote(id, expectedVersion),
    ),
  restoreNote: ({ id, expectedVersion }) =>
    guarded<Note>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.restoreNote(id, expectedVersion),
    ),
  deleteNote: ({ id }) =>
    guarded<Note>((orgId, actor) => assertCanMutateAnnotation(orgId, actor, id), uc.deleteNote(id)),
  // ── annotation layer: tasks ───────────────────────────────────────────────────
  // Create is open (assignee validated); edits/assign/status/archive/purge gate on
  // author/assignee/admin. Assignment also validates the new assignee's membership.
  listTasks: ({ subjectId, assignee, statusId, dueBefore, dueAfter, includeArchived, limit }) =>
    as<ReadonlyArray<Task>>(
      uc.listTasks({ subjectId, assignee, statusId, dueBefore, dueAfter, includeArchived, limit }),
    ),
  resolveTaskSubjects: ({ subjectIds }) =>
    as<ReadonlyArray<TaskSubjectRef>>(uc.resolveTaskSubjects(subjectIds)),
  createTask: ({
    subjectId,
    title,
    description,
    statusId,
    priorityId,
    labelIds,
    assignee,
    dueAt,
    customFields,
  }) =>
    checkThen(
      (orgId) => assertAssigneeMember(orgId, assignee),
      uc.createTask({
        subjectId,
        title,
        description,
        statusId,
        priorityId,
        labelIds,
        assignee,
        dueAt,
        customFields,
      }),
    ),
  updateTask: ({
    id,
    expectedVersion,
    title,
    description,
    priorityId,
    labelIds,
    dueAt,
    customFields,
  }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.updateTask({
        id,
        expectedVersion,
        title,
        description,
        priorityId,
        labelIds,
        dueAt,
        customFields,
      }),
    ),
  setTaskStatus: ({ id, expectedVersion, statusId }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.setTaskStatus(id, expectedVersion, statusId),
    ),
  assignTask: ({ id, expectedVersion, assignee }) =>
    guarded<Task>(
      async (orgId, actor) => {
        await assertCanMutateAnnotation(orgId, actor, id)
        await assertAssigneeMember(orgId, assignee)
      },
      uc.assignTask(id, expectedVersion, assignee),
    ),
  snoozeTask: ({ id, expectedVersion, until }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.snoozeTask(id, expectedVersion, until),
    ),
  setTaskBlocked: ({ id, expectedVersion, blocked }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.setTaskBlocked(id, expectedVersion, blocked),
    ),
  archiveTask: ({ id, expectedVersion }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.archiveTask(id, expectedVersion),
    ),
  restoreTask: ({ id, expectedVersion }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.restoreTask(id, expectedVersion),
    ),
  deleteTask: ({ id }) =>
    guarded<Task>((orgId, actor) => assertCanMutateAnnotation(orgId, actor, id), uc.deleteTask(id)),
  getActivity: ({ subjectId, limit }) => mapErr(uc.getActivity(subjectId, limit)),
  // ── annotation layer: files ─────────────────────────────────────────────────────
  // Reads are open to any member; archive/restore/purge gate on uploader/admin
  // (upload itself is the plain-HTTP multipart route, open like createNote).
  listFiles: ({ itemId, instanceId, bucketId, conceptId, includeArchived, limit }) =>
    as<ReadonlyArray<Attachment>>(
      uc.listFiles({ itemId, instanceId, bucketId, conceptId, includeArchived, limit }),
    ),
  archiveFile: ({ id }) =>
    guarded<Attachment>(
      (orgId, actor) => assertCanMutateAttachment(orgId, actor, id),
      uc.archiveFile(id),
    ),
  restoreFile: ({ id }) =>
    guarded<Attachment>(
      (orgId, actor) => assertCanMutateAttachment(orgId, actor, id),
      uc.restoreFile(id),
    ),
  deleteFile: ({ id }) =>
    guarded<Attachment>(
      (orgId, actor) => assertCanMutateAttachment(orgId, actor, id),
      uc.deleteFile(id),
    ),
  purgeBucket: ({ bucketId }) =>
    guarded<ReadonlyArray<Attachment>>(
      (orgId, actor) => assertCanPurgeBucket(orgId, actor, bucketId),
      uc.purgeBucket(bucketId),
    ),
  // Any member, deliberately: this only mirrors the widget's own toggle onto the
  // rows, and saving that toggle into the dashboard body is already open to any
  // member. A stricter gate here would let the body and the rows disagree — the
  // very drift this call exists to prevent. Nothing is destroyed or exposed that
  // editing the widget didn't already decide.
  setBucketShared: ({ bucketId, shared }) =>
    as<ReadonlyArray<Attachment>>(uc.setBucketShared(bucketId, shared)),
  // ── annotation layer: task statuses + custom-field defs (admin) ────────────────
  listTaskStatuses: ({ includeArchived }) =>
    as<ReadonlyArray<TaskStatus>>(uc.listTaskStatuses(includeArchived)),
  createTaskStatus: ({ name, category, color, isDefault }) =>
    admin<TaskStatus>(uc.createTaskStatus({ name, category, color, isDefault })),
  updateTaskStatus: ({ id, name, color, category, isDefault }) =>
    admin<TaskStatus>(uc.updateTaskStatus({ id, name, color, category, isDefault })),
  archiveTaskStatus: ({ id }) => admin<TaskStatus>(uc.archiveTaskStatus(id)),
  restoreTaskStatus: ({ id }) => admin<TaskStatus>(uc.restoreTaskStatus(id)),
  reorderTaskStatuses: ({ orders }) =>
    admin<ReadonlyArray<TaskStatus>>(uc.reorderTaskStatuses(orders)),
  listTaskPriorities: ({ includeArchived }) =>
    as<ReadonlyArray<TaskPriority>>(uc.listTaskPriorities(includeArchived)),
  createTaskPriority: ({ name, color }) =>
    admin<TaskPriority>(uc.createTaskPriority({ name, color })),
  updateTaskPriority: ({ id, name, color }) =>
    admin<TaskPriority>(uc.updateTaskPriority({ id, name, color })),
  archiveTaskPriority: ({ id }) => admin<TaskPriority>(uc.archiveTaskPriority(id)),
  restoreTaskPriority: ({ id }) => admin<TaskPriority>(uc.restoreTaskPriority(id)),
  reorderTaskPriorities: ({ orders }) =>
    admin<ReadonlyArray<TaskPriority>>(uc.reorderTaskPriorities(orders)),
  listAnnotationFields: ({ annotationType, includeArchived }) =>
    as<ReadonlyArray<AnnotationField>>(uc.listAnnotationFields(annotationType, includeArchived)),
  addAnnotationField: ({ annotationType, name, kind, config, icon }) =>
    admin<AnnotationField>(uc.addAnnotationField({ annotationType, name, kind, config, icon })),
  updateAnnotationField: ({ id, name, config, icon }) =>
    admin<AnnotationField>(uc.updateAnnotationField({ id, name, config, icon })),
  archiveAnnotationField: ({ id }) => admin<AnnotationField>(uc.archiveAnnotationField(id)),
  restoreAnnotationField: ({ id }) => admin<AnnotationField>(uc.restoreAnnotationField(id)),
  reorderAnnotationFields: ({ annotationType, orders }) =>
    admin<ReadonlyArray<AnnotationField>>(uc.reorderAnnotationFields(annotationType, orders)),
  // Instance-view layout prefs: both target the caller's own row.
  getInstanceViewPrefs: () => as<InstanceViewPrefs>(uc.getInstanceViewPrefs),
  updateInstanceViewPrefs: ({ body }) => as<InstanceViewPrefs>(uc.updateInstanceViewPrefs(body)),
  // Deactivation: the list is member-readable (drives picker filtering + the
  // directory toggle); the writes are admin-only with auth-tier guards. A purge
  // is the plain-HTTP DELETE /api/org/members/:userId (see router.ts).
  listDeactivatedMembers: () => as<ReadonlyArray<DeactivatedMember>>(uc.listDeactivatedMembers),
  deactivateMember: ({ userId }) =>
    requireAdmin.pipe(
      Effect.zipRight(
        checkThen(
          (orgId, actor) => assertDeactivatable(orgId, actor, userId),
          uc.deactivateMember(userId),
        ),
      ),
    ) as Effect.Effect<DeactivatedMember, RpcError, OrgContext | EngineServices>,
  reactivateMember: ({ userId }) => admin<{ userId: string }>(uc.reactivateMember(userId)),
  // Automations. Reads are member-visible (a record's activity trail names the
  // automation that touched it, so the list must be resolvable); every WRITE is
  // admin-gated, because an automation writes to everyone's records.
  listAutomations: ({ includeArchived }) =>
    as<ReadonlyArray<Automation>>(uc.listAutomations(includeArchived)),
  getAutomation: ({ id }) => as<Automation>(uc.getAutomation(id)),
  createAutomation: ({ name, trigger, conditions, match, actions, enabled }) =>
    admin<Automation>(uc.createAutomation({ name, trigger, conditions, match, actions, enabled })),
  updateAutomation: ({ id, name, trigger, conditions, match, actions, enabled }) =>
    admin<Automation>(
      uc.updateAutomation({ id, name, trigger, conditions, match, actions, enabled }),
    ),
  archiveAutomation: ({ id }) => admin<Automation>(uc.archiveAutomation(id)),
  restoreAutomation: ({ id }) => admin<Automation>(uc.restoreAutomation(id)),
  deleteAutomation: ({ id }) => admin<{ id: string }>(uc.deleteAutomation(id)),
  listAutomationRuns: ({ automationId, limit }) =>
    as<ReadonlyArray<AutomationRun>>(uc.listAutomationRuns(automationId, limit)),
  // A dry run writes nothing, but it reads every record of a concept — keep it
  // behind the same gate as the editor that launches it.
  testAutomation: ({ id, limit }) => admin<AutomationDryRun>(uc.testAutomation(id, limit)),

  // ── sharing ────────────────────────────────────────────────────────────────
  // Gated on `share` FOR THE SPECIFIC RESOURCE, not on admin: the point of the
  // feature is that a team lead hands out access to their own deals without an
  // admin in the loop. `requireAction` resolves it against their rules, falling
  // back to the role default — so today's owner/admin behaviour is unchanged.
  //
  // Reading the grant list needs `share` too: who a record is shared with is itself
  // sensitive, and anyone who may change it may see it.
  listGrants: ({ resourceType, resourceId }) =>
    requireAction("share", { type: resourceType, id: resourceId }).pipe(
      Effect.zipRight(as<ReadonlyArray<AccessGrant>>(uc.listGrants(resourceType, resourceId))),
    ),
  share: ({ resourceType, resourceId, userId, roleId, actions }) =>
    requireAction("share", { type: resourceType, id: resourceId }).pipe(
      Effect.zipRight(
        as<AccessGrant>(uc.share({ resourceType, resourceId, userId, roleId, actions })),
      ),
    ),
  // ── roles ──────────────────────────────────────────────────────────────────
  // Role NAMES are org vocabulary — any member may read them (they render as pills
  // on /members and populate the Share dialog). The RULES inside a role are the
  // sensitive half and need `configure`. See the artifact's Surfaces table.
  listRoles: () => as<ReadonlyArray<AccessRole>>(uc.listRoles()),
  rolesOf: ({ userId }) => as<ReadonlyArray<AccessRole>>(uc.rolesOfUser(userId)),
  listRules: ({ roleId }) => admin<ReadonlyArray<AccessRule>>(uc.listRules(roleId)),
  createRole: ({ name, description }) => admin<AccessRole>(uc.createRole({ name, description })),
  updateRole: ({ id, name, description }) =>
    admin<AccessRole>(uc.updateRole({ id, name, description })),
  deleteRole: ({ id }) => admin<{ readonly id: string }>(uc.deleteRole(id)),
  assignRole: ({ roleId, userId }) =>
    admin<{ readonly ok: boolean }>(uc.assignRole(roleId, userId)),
  unassignRole: ({ roleId, userId }) =>
    admin<{ readonly ok: boolean }>(uc.unassignRole(roleId, userId)),
  addRule: ({ roleId, effect, actions, resourceType, resourceId, conceptId, condition }) =>
    admin<{ readonly id: string }>(
      uc.addRule({ roleId, effect, actions, resourceType, resourceId, conceptId, condition }),
    ),
  removeRule: ({ ruleId }) => admin<{ readonly id: string }>(uc.removeRule(ruleId)),
  /**
   * Asking about YOURSELF is always allowed — that is the point of the self-serve
   * report ("why can't I see this?" answered without an admin). Asking about someone
   * else is `configure`.
   */
  effectiveAccess: ({ userId }) =>
    Effect.gen(function* () {
      const scope = yield* OrgContext
      const target = userId ?? scope.actor
      if (target !== scope.actor) yield* requireAction("configure")
      return yield* as<EffectiveAccess>(uc.effectiveAccess(target))
    }),
  revoke: ({ grantId }) =>
    Effect.gen(function* () {
      // The grant must be resolved BEFORE the gate: `share` is checked against the
      // resource the grant points at, which only the row knows. A missing grant is a
      // no-op (idempotent revoke), so it needs no gate at all.
      const existing = yield* as<{
        readonly resourceType: AccessResourceType
        readonly resourceId: string | null
      } | null>(uc.getGrant(grantId))
      if (!existing) return { id: grantId }
      yield* requireAction("share", {
        type: existing.resourceType,
        id: existing.resourceId ?? undefined,
      })
      return yield* as<{ readonly id: string }>(uc.revoke(grantId))
    }),
}).pipe(Layer.provide(EngineBase))

// HttpRouter.DefaultServices (HttpPlatform | Etag | FileSystem | Path) — pure
// layers (no-op FileSystem) since the RPC handler never touches the filesystem.
const HttpServices = Layer.mergeAll(HttpPlatform.layer, Etag.layerWeak, Path.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
)

const ServerLayer = Layer.mergeAll(
  HandlersLive,
  AuthMiddlewareLive,
  RpcSerialization.layerNdjson,
  HttpServices,
)

/** A `(Request) => Promise<Response>` for the RPC endpoint, mounted in Bun.serve. */
export const { handler: rpcHandler } = RpcServer.toWebHandler(ServerRpcs, { layer: ServerLayer })
