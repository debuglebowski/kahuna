import { Etag, FileSystem, HttpPlatform, Path } from "@effect/platform"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import { type EngineServices, OrgContext, type OrgScope } from "@kingsmaker/engine"
import { Effect, Layer } from "effect"
import {
  type AnnotationField,
  type Concept,
  type ConceptGraph,
  type Dashboard,
  type Field,
  type GraphLayout,
  type Instance,
  type InstanceDetail,
  type InstancePick,
  type Item,
  KingsmakerRpcs,
  type Label,
  type Note,
  type Relation,
  RpcError,
  type SidebarView,
  type Task,
  type TaskStatus,
} from "../rpc/contract"
import { auth } from "./auth"
import { pool } from "./db"
import { can } from "./policy"
import { EngineBase, ERROR_MAP } from "./runtime"
import { roleOf } from "./session"
import * as uc from "./use-cases"

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
    return { orgId, actor: session.user.id } satisfies OrgScope
  }),
)

/** Map any engine failure to the single serializable RpcError (mirrors HTTP codes).
 *  Mapped (domain) errors pass their human message through (e.g. `field "title"
 *  is required`) — they're user-facing by construction; anything unmapped stays
 *  an opaque INTERNAL. */
const toRpcError = (e: unknown): RpcError => {
  const tag = typeof e === "object" && e !== null ? (e as { _tag?: string })._tag : undefined
  const mapped = tag ? ERROR_MAP[tag] : undefined
  if (!mapped) return new RpcError({ code: "INTERNAL", message: "Internal error", status: 500 })
  const detail = (e as { message?: unknown }).message
  const message = typeof detail === "string" && detail.length > 0 ? detail : (tag ?? "error")
  return new RpcError({ code: mapped.code, message, status: mapped.status })
}

const mapErr = <A, E>(eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  eff.pipe(Effect.catchAll((e) => Effect.fail(toRpcError(e))))

/**
 * Admin gate for schema-mutating RPCs (concept configuration). Reuses the
 * OrgContext already provided by AuthMiddleware plus the BetterAuth member role
 * — one indexed lookup, only on the handlers that need it.
 */
const requireAdmin: Effect.Effect<void, RpcError, OrgContext> = Effect.gen(function* () {
  const { orgId, actor } = yield* OrgContext
  const role = yield* Effect.tryPromise({
    try: () => roleOf(actor, orgId),
    catch: () => new RpcError({ code: "INTERNAL", message: "role lookup failed", status: 500 }),
  })
  if (!role || !can(role, "admin")) {
    return yield* Effect.fail(
      new RpcError({ code: "FORBIDDEN", message: "Admin only", status: 403 }),
    )
  }
})

/** Run an admin-only use-case behind the gate, mapping engine errors. */
const admin = <A>(eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
  requireAdmin.pipe(Effect.zipRight(as<A>(eff)))

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
async function assertMembers(
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
  const members = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM bauth_member WHERE organization_id = $1",
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

/** A task's assignee must be a real org member (the engine treats it as an opaque
 *  logical FK; membership is an auth-tier concern validated here). No-op when unset. */
async function assertAssigneeMember(
  orgId: string,
  assignee: string | null | undefined,
): Promise<void> {
  if (!assignee) return
  const members = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM bauth_member WHERE organization_id = $1 AND user_id = $2 LIMIT 1",
    [orgId, assignee],
  )
  if (members.rows.length === 0) {
    throw new RpcError({
      code: "VALIDATION",
      message: `not an org member: ${assignee}`,
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
  if (role && can(role, "admin")) return
  throw new RpcError({
    code: "FORBIDDEN",
    message: "Only the author, assignee, or an admin may modify this",
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

/** Run a member pre-check (resolved against the request's org), then the use-case. */
const checkThen = <A>(
  precheck: (orgId: string) => Promise<void>,
  run: Effect.Effect<A, unknown, OrgContext | EngineServices>,
): Effect.Effect<A, RpcError, OrgContext | EngineServices> =>
  Effect.gen(function* () {
    const { orgId } = yield* OrgContext
    yield* Effect.tryPromise({
      try: () => precheck(orgId),
      catch: (e) =>
        e instanceof RpcError
          ? e
          : new RpcError({ code: "INTERNAL", message: "membership check failed", status: 500 }),
    })
    return yield* mapErr(run)
  })

const ServerRpcs = KingsmakerRpcs.middleware(AuthMiddleware)

const HandlersLive = ServerRpcs.toLayer({
  listConcepts: ({ includeArchived, withCounts }) =>
    as<ReadonlyArray<Concept>>(uc.listConcepts(includeArchived, withCounts)),
  createConcept: ({ name }) => as<Concept>(uc.createConcept(name)),
  updateConcept: ({
    id,
    name,
    pluralName,
    description,
    icon,
    versioningEnabled,
    staticLabelIds,
    defaultLabelIds,
  }) =>
    admin<Concept>(
      uc.updateConcept(id, {
        name,
        pluralName,
        description,
        icon,
        versioningEnabled,
        staticLabelIds,
        defaultLabelIds,
      }),
    ),
  archiveConcept: ({ id }) => admin<Concept>(uc.archiveConcept(id)),
  restoreConcept: ({ id }) => admin<Concept>(uc.restoreConcept(id)),
  deleteConcept: ({ id }) => admin<Concept>(uc.deleteConcept(id)),
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
    mapErr(uc.listInstances(conceptId, { decorate: true, includeArchived })),
  getInstance: ({ id }) => as<InstanceDetail>(uc.getInstanceDetail(id)),
  getChanged: () => mapErr(uc.getChanged),
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
  createDashboard: ({ name, icon, scope, body }) =>
    as<Dashboard>(uc.createDashboard({ name, icon, scope, body })),
  updateDashboard: ({ id, name, icon, hidden, scope, body }) =>
    as<Dashboard>(uc.updateDashboard({ id, name, icon, hidden, scope, body })),
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
  createTask: ({ subjectId, title, statusId, assignee, dueAt, customFields }) =>
    checkThen(
      (orgId) => assertAssigneeMember(orgId, assignee),
      uc.createTask({ subjectId, title, statusId, assignee, dueAt, customFields }),
    ),
  updateTask: ({ id, expectedVersion, title, dueAt, customFields }) =>
    guarded<Task>(
      (orgId, actor) => assertCanMutateAnnotation(orgId, actor, id),
      uc.updateTask({ id, expectedVersion, title, dueAt, customFields }),
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
