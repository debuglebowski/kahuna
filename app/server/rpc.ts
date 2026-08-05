import { Etag, FileSystem, HttpPlatform, Path } from "@effect/platform"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import type { PgClient } from "@effect/sql-pg"
import { Effect, Layer } from "effect"
import {
  type AccessAction,
  type AccessResource,
  decide,
  type EngineServices,
  OrgContext,
  type OrgScope,
} from "#engine"
import {
  type AccessRole,
  type AccessRule,
  type AnnotationField,
  type Attachment,
  type Automation,
  type AutomationDryRun,
  type AutomationRun,
  type BacklinkRef,
  type Concept,
  type ConceptGraph,
  type Dashboard,
  type DeactivatedMember,
  type EffectiveAccess,
  type ExplainAccess,
  type Field,
  type GraphLayout,
  KingsmakerRpcs,
  type KmRecord,
  type Label,
  type MentionRef,
  type Note,
  type RecordDetail,
  type RecordPick,
  type RecordVersion,
  type RecordViewPrefs,
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
import { canConfigure } from "./policy"
import { EngineBase, ERROR_MAP, resolvePolicy, sessionScope } from "./runtime"
import { isDeactivated, roleOf } from "./session"
import * as uc from "./use-cases"

/**
 * `listRecords` cap. The engine's `findRecords` defaults to 100 — fine for a
 * paged table, but every dashboard widget (metric/breakdown/calendar/gantt)
 * aggregates or plots over the WHOLE concept, so a 100-row cap silently drops
 * data: e.g. a Calendar over a synced source with thousands of events shows
 * almost nothing (the 100 newest by creation rarely land in the viewed month).
 * Raise it to cover realistic concepts. NOTE: a true fix for unbounded concepts
 * is date-windowed loading for the date-plotting widgets — follow-up.
 */
const LIST_RECORDS_LIMIT = 50_000

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
 *  its props (e.g. `{"recordVersionId":"…"}`), which must never reach a user — these
 *  override it with prose. Errors that DO carry a `message` (e.g.
 *  FieldValidationError) keep their own, more specific text. */
const ERROR_MESSAGE: Record<string, string> = {
  // Deliberately prescribes no fix: whether a new draft is the only way out
  // depends on the concept's edit-reach setting.
  VersionFrozen: "This version is published and can't be edited.",
  VersionConflict: "This record was changed elsewhere. Reload and try again.",
  RecordVersionNotFound: "This record no longer exists.",
  ConceptNotFound: "This concept no longer exists.",
  FieldNotFound: "This field no longer exists.",
  RelationNotFound: "That link no longer exists.",
  LabelNotFound: "That label no longer exists.",
  RecordNotFound: "This record no longer exists.",
  RecordNotPublished: "This record has no published version yet.",
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
// `PgClient` a self-transacting use-case carries — see `adminSqlOn`.
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
    // ── THE LAST ROLE-DERIVED FALLBACK, NOW CLOSED ──────────────────────────
    //
    // `configure` and `delete` used to fall back to `isAdminRole(membership role)`.
    // They now fall back to NOTHING: an admin passes because they hold the Admin
    // role, whose rules grant `*`, and an owner passes because their session is
    // unrestricted. Deciding it from the tier would ignore an org that granted
    // org-configuration to a role of its own making — which is the whole point of
    // Admin becoming an ordinary role.
    //
    // This is a fail-closed flip, so it depends on every actor actually HOLDING a
    // role: `scripts/backfill-auto-roles.ts` is what guarantees that, and the
    // failure mode if it did not run is silent (buttons quietly stop working for
    // people who should have them).
    //
    // The other actions stay open — they were open to any member before, and the
    // per-resource rules are what narrow them.
    const fallback = action !== "configure" && action !== "delete"
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
 * `admin`, but decided against ONE resource instead of the org.
 *
 * This is what makes a per-record permission grid mean anything. `admin` resolves
 * `configure` on `{type:"org"}`, so a rule naming a single concept could only ever
 * be consulted AFTER the org-wide gate had already answered — a grid cell granting
 * a member `configure` on Deals would be dead, and one denying an admin would never
 * be reached. Deciding on the resource itself makes the cell work in both
 * directions: an allow WIDENS (this role may configure Deals and nothing else), a
 * deny NARROWS (admins, but not this concept).
 *
 * The fallback is whatever `requireAction` computes — closed for `configure`/
 * `delete`, open otherwise. See the long note there.
 */
const adminOn = <A>(
  action: AccessAction,
  resource: AccessResource,
  eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>,
) => requireAction(action, resource).pipe(Effect.zipRight(as<A>(eff)))

/**
 * `adminOn` for a handler that names a FIELD but must be governed by the field's
 * CONCEPT — "may configure Deals" has to cover adding and editing Deals' fields, or
 * a deny would leave the schema editable through a side door. Costs one indexed
 * lookup, on admin-rare paths only.
 */
const adminOnFieldConcept = <A>(
  action: AccessAction,
  fieldId: string,
  eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>,
) =>
  as<{ readonly conceptId: string }>(uc.getField(fieldId)).pipe(
    Effect.flatMap((f) => requireAction(action, { type: "concept", id: f.conceptId })),
    Effect.zipRight(as<A>(eff)),
  )

/**
 * `adminOn` for a use-case that opens its OWN transaction, so it also needs
 * `PgClient` (only `deleteConcept`'s single-record cascade, so far). `EngineBase`
 * is built with `provideMerge` and therefore surfaces `PgClient` — the extra
 * requirement is satisfied by the same layer, it just can't be hidden behind
 * `as`'s narrower cast.
 */
const adminSqlOn = <A>(
  action: AccessAction,
  resource: AccessResource,
  eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices | PgClient.PgClient>,
) =>
  requireAction(action, resource).pipe(Effect.zipRight(mapErr(eff))) as Effect.Effect<
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

/**
 * Resolve `person` mentions to member names. Auth-tier, so it lives here rather
 * than in a use-case: the engine treats a user id as an opaque logical FK and
 * never touches `bauth_*`.
 *
 * DEACTIVATED members resolve normally, unlike in `assertMembers`. The rules
 * differ on purpose: that one governs ASSIGNING work, where a deactivated user
 * would create a value nobody can act on. This one governs displaying a name
 * someone already wrote — the person is still real and still has a profile page,
 * and blanking the mention would rewrite history to hide that they were here.
 *
 * A user id with no member row (purged, or from another org) resolves to a null
 * href, which the chip renders as an inert "former member"-style pill.
 */
async function resolvePeopleMentions(
  orgId: string,
  userIds: ReadonlyArray<string>,
): Promise<Map<string, { label: string; href: string; icon: null }>> {
  const out = new Map<string, { label: string; href: string; icon: null }>()
  if (userIds.length === 0) return out
  const rows = await pool.query<{ user_id: string; name: string | null; email: string | null }>(
    `SELECT m.user_id, u.name, u.email FROM bauth_member m
       JOIN bauth_user u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.user_id = ANY($2::text[])`,
    [orgId, [...new Set(userIds)]],
  )
  for (const r of rows.rows) {
    // Mirrors the client's `memberLabel`: name, else email, else the raw id.
    const label = r.name?.trim() || r.email || r.user_id
    out.set(r.user_id, { label, href: `/members/${r.user_id}`, icon: null })
  }
  return out
}

/** Resolve a record version's concept, then run the member check against the patch. */
async function assertMembersForRecordVersion(
  orgId: string,
  recordVersionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const r = await pool.query<{ concept_id: string }>(
    "SELECT concept_id FROM record_versions WHERE id = $1 AND org_id = $2 LIMIT 1",
    [recordVersionId, orgId],
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
  if (await canConfigure(orgId, actor, role)) return
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
  if (await canConfigure(orgId, actor, role)) return
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
  if (await canConfigure(orgId, actor, role)) return
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
  createConcept: ({ name, color, access }) => as<Concept>(uc.createConcept(name, color, access)),
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
    adminOn<Concept>(
      "configure",
      { type: "concept", id },
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
  // Not admin-gated: any member may shape a concept's default record version layout.
  setConceptRecordView: ({ id, recordView }) =>
    as<Concept>(uc.setConceptRecordView(id, recordView)),
  setFieldVisibility: ({ id, visibility }) =>
    adminOnFieldConcept<Field>("configure", id, uc.setFieldVisibility(id, visibility)),
  setConceptVisibility: ({ id, visibility }) =>
    adminOn<Concept>("configure", { type: "concept", id }, uc.setConceptVisibility(id, visibility)),
  setConceptTitleField: ({ id, titleFieldId }) =>
    adminOn<Concept>(
      "configure",
      { type: "concept", id },
      uc.setConceptTitleField(id, titleFieldId),
    ),
  // Admin + the member check `createRecord` does: `fields` seeds a real record,
  // so any `user`-kind value in it must be an actual org member. Without this the
  // toggle would be a hole in a rule every other write path enforces.
  setConceptSingleRecord: ({ conceptId, singleRecord, fields }) =>
    requireAction("configure", { type: "concept", id: conceptId }).pipe(
      Effect.zipRight(
        checkThen(
          (orgId) => assertMembers(orgId, conceptId, fields ?? {}),
          uc.setConceptSingleRecord(conceptId, singleRecord, fields),
        ),
      ),
    ) as Effect.Effect<Concept, RpcError, OrgContext | EngineServices>,
  archiveConcept: ({ id }) =>
    adminOn<Concept>("archive", { type: "concept", id }, uc.archiveConcept(id)),
  restoreConcept: ({ id }) =>
    adminOn<Concept>("archive", { type: "concept", id }, uc.restoreConcept(id)),
  // Not `admin`: the single-record cascade needs its own transaction, hence PgClient.
  deleteConcept: ({ id }) =>
    adminSqlOn<Concept>("delete", { type: "concept", id }, uc.deleteConcept(id)),
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
  getRecordGraphLayout: ({ recordId }) => as<GraphLayout>(uc.getRecordGraphLayout(recordId)),
  saveRecordGraphLayout: ({ recordId, positions }) =>
    as<GraphLayout>(uc.saveRecordGraphLayout(recordId, positions)),
  addField: ({ conceptId, name, kind, config, formula, icon }) =>
    adminOn<Field>(
      "configure",
      { type: "concept", id: conceptId },
      uc.addField({ conceptId, name, kind, config, formula, icon }),
    ),
  updateField: ({ id, name, config, formula, icon }) =>
    adminOnFieldConcept<Field>(
      "configure",
      id,
      uc.updateField({ id, name, config, formula, icon }),
    ),
  archiveField: ({ id }) => adminOnFieldConcept<Field>("configure", id, uc.archiveField(id)),
  restoreField: ({ id }) => adminOnFieldConcept<Field>("configure", id, uc.restoreField(id)),
  deleteField: ({ id }) => adminOnFieldConcept<Field>("configure", id, uc.deleteField(id)),
  reorderFields: ({ conceptId, orders }) =>
    adminOn<ReadonlyArray<Field>>(
      "configure",
      { type: "concept", id: conceptId },
      uc.reorderFields(conceptId, orders),
    ),
  listRecords: ({ conceptId, includeArchived }) =>
    mapErr(
      uc.listRecords(conceptId, { decorate: true, includeArchived, limit: LIST_RECORDS_LIMIT }),
    ),
  getRecord: ({ id }) => as<RecordDetail>(uc.getRecordDetail(id)),
  getSingleRecord: ({ conceptId }) => as<RecordDetail | null>(uc.getSingleRecord(conceptId)),
  getChanged: () => mapErr(uc.getChanged),
  listEvents: ({ conceptId, since, limit }) => mapErr(uc.listEvents({ conceptId, since, limit })),
  createRecord: ({ conceptId, fields }) =>
    checkThen(
      (orgId) => assertMembers(orgId, conceptId, fields),
      uc.createRecord(conceptId, fields),
    ),
  updateRecord: ({ id, expectedVersion, patch }) =>
    checkThen(
      (orgId) => assertMembersForRecordVersion(orgId, id, patch),
      uc.updateRecord(id, expectedVersion, patch),
    ),
  transitionRecord: ({ id, expectedVersion, field, to }) =>
    mapErr(uc.transitionRecord(id, expectedVersion, field, to)),
  // Archive/restore are ordinary record writes (any member); a hard delete is
  // admin-only, mirroring the schema-mutating concept/field/label deletes.
  archiveRecordVersion: ({ id, expectedVersion }) =>
    mapErr(uc.archiveRecordVersion(id, expectedVersion)),
  restoreRecordVersion: ({ id, expectedVersion }) =>
    mapErr(uc.restoreRecordVersion(id, expectedVersion)),
  deleteRecordVersion: ({ id }) => admin<RecordVersion>(uc.deleteRecordVersion(id)),
  // Versioning: lifecycle + relation editing are ordinary member writes (the
  // versioning *toggle* is admin, via updateConcept). Discarding a draft is a
  // member write (it only removes never-published work).
  listVersions: ({ recordId }) => mapErr(uc.listVersions(recordId)),
  newVersion: ({ recordId }) => mapErr(uc.newVersion(recordId)),
  publishVersion: ({ id, expectedVersion }) => mapErr(uc.publishVersion(id, expectedVersion)),
  discardDraft: ({ id }) => mapErr(uc.discardDraft(id)),
  archiveRecord: ({ recordId }) => as<KmRecord>(uc.archiveRecord(recordId)),
  restoreRecord: ({ recordId }) => as<KmRecord>(uc.restoreRecord(recordId)),
  searchRecords: ({ conceptId, query, limit }) =>
    as<ReadonlyArray<RecordPick>>(uc.searchRecords(conceptId, query, limit)),
  createRelation: ({ fieldId, fromId, toRecordId, toVersionId, toId, properties }) =>
    as<Relation>(uc.createRelation({ fieldId, fromId, toRecordId, toVersionId, toId, properties })),
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
  // (the note has no assignee). The per-record activity feed is a plain read.
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
  // The engine resolves every kind it can gate itself; `person` is auth-tier and
  // is overlaid here (see `resolvePeopleMentions`). `page` stays null by design —
  // it is resolved client-side from the static nav table.
  searchMentionableRecords: ({ query, limit }) =>
    as<ReadonlyArray<MentionRef>>(uc.searchMentionableRecords(query, limit)),
  listBacklinks: ({ recordId }) => as<ReadonlyArray<BacklinkRef>>(uc.listBacklinks(recordId)),
  resolveMentions: ({ refs }) =>
    Effect.gen(function* () {
      const { orgId } = yield* OrgContext
      const resolved = yield* as<ReadonlyArray<MentionRef>>(uc.resolveMentions(refs))
      const personIds = refs.filter((r) => r.kind === "person").map((r) => r.targetId)
      if (personIds.length === 0) return resolved
      const people = yield* Effect.tryPromise({
        try: () => resolvePeopleMentions(orgId, personIds),
        catch: toRpcError,
      })
      return resolved.map((r) => {
        if (r.kind !== "person") return r
        const hit = people.get(r.targetId)
        return hit ? { ...r, href: hit.href, label: hit.label, icon: hit.icon } : r
      })
    }),
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
  listFiles: ({ recordId, recordVersionId, bucketId, conceptId, includeArchived, limit }) =>
    as<ReadonlyArray<Attachment>>(
      uc.listFiles({ recordId, recordVersionId, bucketId, conceptId, includeArchived, limit }),
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
  // Record version-view layout prefs: both target the caller's own row.
  getRecordViewPrefs: () => as<RecordViewPrefs>(uc.getRecordViewPrefs),
  updateRecordViewPrefs: ({ body }) => as<RecordViewPrefs>(uc.updateRecordViewPrefs(body)),
  // Deactivation: the list is member-readable (drives picker filtering + the
  // directory toggle); the writes are admin-only with auth-tier guards. A purge
  // is the plain-HTTP DELETE /api/org/members/:userId (see router.ts).
  listDeactivatedMembers: () => as<ReadonlyArray<DeactivatedMember>>(uc.listDeactivatedMembers),
  deactivateMember: ({ userId }) =>
    requireAction("configure", { type: "member" }).pipe(
      Effect.zipRight(
        checkThen(
          (orgId, actor) => assertDeactivatable(orgId, actor, userId),
          uc.deactivateMember(userId),
        ),
      ),
    ) as Effect.Effect<DeactivatedMember, RpcError, OrgContext | EngineServices>,
  reactivateMember: ({ userId }) =>
    adminOn<{ userId: string }>("configure", { type: "member" }, uc.reactivateMember(userId)),
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

  // ── roles ──────────────────────────────────────────────────────────────────
  // Role NAMES are org vocabulary — any member may read them (they render as pills
  // on /members). The RULES inside a role are the sensitive half and need
  // `configure` on `role` — its OWN resource type, not blanket org-configure, so
  // "may manage permissions" is grantable without also handing out schema/settings
  // administration. See the artifact's Surfaces table.
  listRoles: () => as<ReadonlyArray<AccessRole>>(uc.listRoles()),
  rolesOf: ({ userId }) => as<ReadonlyArray<AccessRole>>(uc.rolesOfUser(userId)),
  listRules: ({ roleId }) =>
    adminOn<ReadonlyArray<AccessRule>>("configure", { type: "role" }, uc.listRules(roleId)),
  // Not `admin`-gated, deliberately: this is how a client finds out whether it is an
  // admin, so gating it on being one makes it useless. It reveals only the caller's
  // own answer.
  //
  // `canConfigure` no longer short-circuits on `role === "owner"` — that was the
  // pre-Layer-0 bypass, and it drove the Settings nav's admin affordances, so
  // leaving it in would have shown an owner with no admin role a UI whose actual
  // writes all 403. `scope.policy` already carries the Layer 0 floor for an owner
  // (`sessionScope`), which does not cover `org` — same decision `requireAction`
  // makes underneath every one of those routes.
  myAccess: () =>
    Effect.gen(function* () {
      const scope = yield* OrgContext
      const has = (type: "org" | "role") =>
        scope.policy !== undefined &&
        decide(scope.policy, "configure", { type }, false, { unconditionalOnly: true })
      return {
        isOwner: scope.role === "owner",
        canConfigure: has("org"),
        canConfigureRoles: has("role"),
      }
    }),
  roleHolders: ({ roleId }) =>
    adminOn<{ readonly actors: ReadonlyArray<string> }>(
      "configure",
      { type: "role" },
      uc.roleHolders(roleId),
    ),
  reassignRoleHolders: ({ fromRoleId, toRoleId }) =>
    adminOn<{ readonly moved: number }>(
      "configure",
      { type: "role" },
      uc.reassignRoleHolders({ fromRoleId, toRoleId }),
    ),
  createRole: ({ name, description, kind, startFrom }) =>
    adminOn<AccessRole>(
      "configure",
      { type: "role" },
      uc.createRole({ name, description, kind, startFrom }),
    ),
  updateRole: ({ id, name, description, autoAssign, active }) =>
    adminOn<AccessRole>(
      "configure",
      { type: "role" },
      uc.updateRole({ id, name, description, autoAssign, active }),
    ),
  deleteRole: ({ id }) =>
    adminOn<{ readonly id: string }>("configure", { type: "role" }, uc.deleteRole(id)),
  assignRole: ({ roleId, userId }) =>
    adminOn<{ readonly ok: boolean }>("configure", { type: "role" }, uc.assignRole(roleId, userId)),
  unassignRole: ({ roleId, userId }) =>
    adminOn<{ readonly ok: boolean }>(
      "configure",
      { type: "role" },
      uc.unassignRole(roleId, userId),
    ),
  reorderMemberRoles: ({ userId, roleIds }) =>
    adminOn<{ readonly ok: boolean }>(
      "configure",
      { type: "role" },
      uc.reorderMemberRoles(userId, roleIds),
    ),
  ensurePersonalRole: ({ userId }) =>
    adminOn<AccessRole>("configure", { type: "role" }, uc.ensurePersonalRole(userId)),
  addRule: ({ roleId, effect, actions, resourceType, resourceId, conceptId, condition }) =>
    adminOn<{ readonly id: string }>(
      "configure",
      { type: "role" },
      uc.addRule({ roleId, effect, actions, resourceType, resourceId, conceptId, condition }),
    ),
  updateRule: ({ ruleId, effect, actions, resourceType, resourceId, conceptId, condition }) =>
    adminOn<{ readonly id: string }>(
      "configure",
      { type: "role" },
      uc.updateRule({ ruleId, effect, actions, resourceType, resourceId, conceptId, condition }),
    ),
  setScopedRules: ({ roleId, resourceType, scopeBy, entries }) =>
    adminOn<{ readonly ok: boolean }>(
      "configure",
      { type: "role" },
      uc.setScopedRules({ roleId, resourceType, scopeBy, entries }),
    ),
  listAccessDefaults: () =>
    as<ReadonlyArray<{ roleId: string; resourceType: string; actions: ReadonlyArray<string> }>>(
      uc.listAccessDefaults,
    ),
  setAccessDefault: ({ roleId, resourceType, actions }) =>
    adminOn<{ readonly ok: boolean }>(
      "configure",
      { type: "role" },
      uc.setAccessDefault({ roleId, resourceType, actions }),
    ),
  removeRule: ({ ruleId }) =>
    adminOn<{ readonly id: string }>("configure", { type: "role" }, uc.removeRule(ruleId)),
  /**
   * Asking about YOURSELF is always allowed — that is the point of the self-serve
   * report ("why can't I see this?" answered without an admin). Asking about
   * someone else needs `configure` on `role` — this section lives on the member
   * ACCESS page (P5), which the same permission gates end to end: seeing why a
   * decision came out the way it did is "may manage permissions", same as
   * assigning the role that made it.
   *
   * The target's membership role decides whether their trace carries the Layer 0
   * floor — a fact `PolicyService.resolve` doesn't know (it only reads
   * `access_rules`), the same reason `assertDeactivatable` looks it up here rather
   * than trusting the resolved policy alone.
   */
  effectiveAccess: ({ userId }) =>
    Effect.gen(function* () {
      const scope = yield* OrgContext
      const target = userId ?? scope.actor
      if (target !== scope.actor) yield* requireAction("configure", { type: "role" })
      const targetRole = yield* Effect.tryPromise({
        try: () => roleOf(target, scope.orgId),
        catch: () => new RpcError({ code: "INTERNAL", message: "role lookup failed", status: 500 }),
      })
      return yield* as<EffectiveAccess>(uc.effectiveAccess(target, targetRole === "owner"))
    }),
  /** The targeted twin of `effectiveAccess` — same self-vs-others gate, same
   *  Layer-0 lookup, one specific (resource, action) traced instead of every rule
   *  listed. */
  explainAccess: ({ userId, resourceType, resourceId, conceptId, action }) =>
    Effect.gen(function* () {
      const scope = yield* OrgContext
      const target = userId ?? scope.actor
      if (target !== scope.actor) yield* requireAction("configure", { type: "role" })
      const targetRole = yield* Effect.tryPromise({
        try: () => roleOf(target, scope.orgId),
        catch: () => new RpcError({ code: "INTERNAL", message: "role lookup failed", status: 500 }),
      })
      return yield* as<ExplainAccess>(
        uc.explainAccess(
          target,
          targetRole === "owner",
          resourceType,
          resourceId ?? null,
          conceptId ?? null,
          action,
        ),
      )
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
