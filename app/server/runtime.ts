import type { PgClient } from "@effect/sql-pg"
import { Cause, Effect, type Exit, Layer, ManagedRuntime, Option } from "effect"
import {
  EngineLive,
  type EngineServices,
  LocalFsBlobStore,
  OrgContext,
  type OrgScope,
  PgLive,
  PolicyService,
  type PolicySet,
  unrestrictedPolicy,
} from "#engine"
import { AzureBlobStore } from "./blob-azure"
import { S3BlobStore } from "./blob-s3"
import type { Role } from "./policy"

const BlobLive = (() => {
  switch (process.env.BLOB_DRIVER) {
    case "s3":
      return S3BlobStore({
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
        bucket: process.env.S3_BUCKET ?? "",
        region: process.env.S3_REGION,
        endpoint: process.env.S3_ENDPOINT,
      })
    // Azure speaks no S3, so it is its own driver rather than an S3_ENDPOINT.
    case "azure":
      return AzureBlobStore({
        container: process.env.AZURE_STORAGE_CONTAINER ?? "",
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
        account: process.env.AZURE_STORAGE_ACCOUNT,
        accountKey: process.env.AZURE_STORAGE_KEY,
        endpoint: process.env.AZURE_STORAGE_ENDPOINT,
      })
    default:
      return LocalFsBlobStore(process.env.BLOB_LOCAL_DIR ?? "./.blobstore")
  }
})()

/**
 * Engine services + Postgres pool + BlobStore, built once (no OrgContext).
 * `provideMerge` (not `provide`) so the runtime ALSO surfaces `PgClient` — the
 * SSE stream's LISTEN + replay run directly on it. Mirrors the test harness.
 */
export const EngineBase = Layer.provideMerge(EngineLive, Layer.merge(PgLive, BlobLive))

/**
 * The base runtime, built ONCE for the process. Per-request OrgContext is
 * provided at call time (cheap).
 */
export const AppRuntime = ManagedRuntime.make(EngineBase)

export type UseCaseResult<A> =
  | { readonly ok: true; readonly status: number; readonly data: A }
  | {
      readonly ok: false
      readonly status: number
      readonly code: string
      readonly detail?: unknown
    }

export const ERROR_MAP: Record<string, { status: number; code: string }> = {
  ManagedConceptReadonly: { status: 403, code: "MANAGED_READONLY" },
  FieldValidationError: { status: 422, code: "VALIDATION" },
  IllegalTransition: { status: 422, code: "ILLEGAL_TRANSITION" },
  RelationTargetMismatch: { status: 422, code: "RELATION_TARGET_MISMATCH" },
  FieldConfigInvalid: { status: 422, code: "FIELD_CONFIG_INVALID" },
  VersionConflict: { status: 409, code: "VERSION_CONFLICT" },
  ConceptNameConflict: { status: 409, code: "CONFLICT" },
  FieldNameConflict: { status: 409, code: "CONFLICT" },
  LabelNameConflict: { status: 409, code: "CONFLICT" },
  ConceptInUse: { status: 409, code: "CONCEPT_IN_USE" },
  FieldInUse: { status: 409, code: "FIELD_IN_USE" },
  InstanceInUse: { status: 409, code: "INSTANCE_IN_USE" },
  InstanceNotFound: { status: 404, code: "NOT_FOUND" },
  ConceptNotFound: { status: 404, code: "NOT_FOUND" },
  FieldNotFound: { status: 404, code: "NOT_FOUND" },
  LabelNotFound: { status: 404, code: "NOT_FOUND" },
  RelationNotFound: { status: 404, code: "NOT_FOUND" },
  ItemNotFound: { status: 404, code: "NOT_FOUND" },
  VersionFrozen: { status: 409, code: "VERSION_FROZEN" },
  DraftAlreadyExists: { status: 409, code: "DRAFT_EXISTS" },
  RelationPinToDraft: { status: 422, code: "RELATION_PIN_TO_DRAFT" },
  ItemNotPublished: { status: 422, code: "ITEM_NOT_PUBLISHED" },
  VersioningInUse: { status: 409, code: "VERSIONING_IN_USE" },
  SingleRecordConflict: { status: 409, code: "SINGLE_RECORD_CONFLICT" },
  SingleRecordProtected: { status: 409, code: "SINGLE_RECORD_PROTECTED" },
  SidebarViewNotFound: { status: 404, code: "NOT_FOUND" },
  SidebarViewProtected: { status: 409, code: "SIDEBAR_VIEW_PROTECTED" },
  DashboardNotFound: { status: 404, code: "NOT_FOUND" },
  DashboardProtected: { status: 409, code: "DASHBOARD_PROTECTED" },
  DashboardConflict: { status: 409, code: "DASHBOARD_CONFLICT" },
  AnnotationNotFound: { status: 404, code: "NOT_FOUND" },
  AttachmentNotFound: { status: 404, code: "NOT_FOUND" },
  AttachmentTooLarge: { status: 413, code: "ATTACHMENT_TOO_LARGE" },
  BlobError: { status: 500, code: "BLOB_ERROR" },
  TaskStatusNotFound: { status: 404, code: "NOT_FOUND" },
  TaskStatusNameConflict: { status: 409, code: "CONFLICT" },
  TaskStatusInUse: { status: 409, code: "TASK_STATUS_IN_USE" },
  TaskPriorityNotFound: { status: 404, code: "NOT_FOUND" },
  TaskPriorityNameConflict: { status: 409, code: "CONFLICT" },
  TaskPriorityInUse: { status: 409, code: "TASK_PRIORITY_IN_USE" },
  AnnotationFieldNotFound: { status: 404, code: "NOT_FOUND" },
  AnnotationFieldNameConflict: { status: 409, code: "CONFLICT" },
  AnnotationFieldConfigInvalid: { status: 422, code: "FIELD_CONFIG_INVALID" },
  OrgScopeViolation: { status: 403, code: "FORBIDDEN" },
  // Carries its own prose (see errors/index.ts) — 422, not 403: the rule is
  // malformed for this model, not forbidden to this caller.
  BlanketRuleRefused: { status: 422, code: "BLANKET_RULE_REFUSED" },
  // Also prose-carrying, also 422: an automation role offered to a person is a
  // category error, not an access decision about the caller.
  RoleKindMismatch: { status: 422, code: "ROLE_KIND_MISMATCH" },
  EventCorruption: { status: 500, code: "INTERNAL" },
  // Unmapped until now, so every rejected automation reached the editor as
  // "Internal error" and `validateActions`' prose never arrived.
  AutomationInvalid: { status: 422, code: "AUTOMATION_INVALID" },
  AutomationNotFound: { status: 404, code: "NOT_FOUND" },
}

/** Map an engine effect's Exit to a stable, framework-agnostic result. */
export const toResult = <A, E>(exit: Exit.Exit<A, E>): UseCaseResult<A> => {
  if (exit._tag === "Success") return { ok: true, status: 200, data: exit.value }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) {
    const tag = (failure.value as { _tag?: string })._tag
    const mapped = tag ? ERROR_MAP[tag] : undefined
    if (mapped)
      return { ok: false, status: mapped.status, code: mapped.code, detail: failure.value }
  }
  return { ok: false, status: 500, code: "INTERNAL" }
}

/** What a runnable engine effect may require. `PgClient` is in here because
 *  `EngineBase` uses `provideMerge` and so surfaces it — a use-case that owns its
 *  own transaction (see `deleteConcept`) needs it, and the runtime already has it. */
type Runnable<A, E> = Effect.Effect<A, E, OrgContext | EngineServices | PgClient.PgClient>

/**
 * Build a scope for a REAL request. `role` is typed as the server's `Role`, which
 * does not include `"system"` — so a user request cannot be given engine-level
 * privilege even by mistake. Session-resolved callers must use this.
 *
 * `policy` is the caller's resolved access rules (see `resolvePolicy`). Optional
 * during the migration onto the access model: absent means "no rules", so every
 * decision falls through to the resource defaults — today's behaviour exactly.
 */
export const sessionScope = (
  orgId: string,
  actor: string,
  role: Role,
  policy?: PolicySet,
): OrgScope => ({
  orgId,
  actor,
  role,
  policy,
})

/**
 * Build a scope for a caller that is not a person: the automations runner, the
 * decay tick, integration syncs (webhooks/pushes with no session), seeds and
 * backfills. Sees everything, so it must never be reachable from a user request —
 * `grep 'role: "system"'` should only ever match this function.
 */
export const systemScope = (orgId: string, actor: string): OrgScope => ({
  orgId,
  actor,
  role: "system",
  // Explicit rather than absent: this caller is exempt from the access model, not
  // merely un-resolved. The two mean different things to `decide()`.
  policy: unrestrictedPolicy(actor),
})

/**
 * Resolve an actor's access rules, memoized inside `PolicyService` on the org's
 * policy generation — so this is a single indexed lookup on the warm path.
 *
 * Never fails: `PolicyService.resolve` falls back to the empty set, which grants
 * nothing beyond resource defaults.
 */
export const resolvePolicy = (orgId: string, actor: string): Promise<PolicySet> =>
  AppRuntime.runPromise(Effect.flatMap(PolicyService, (p) => p.resolve(orgId, actor)))

/**
 * Build a scope for a NON-PERSON actor that is nonetheless governed: an automation,
 * or an integration connector.
 *
 * The distinction from `systemScope` is the whole point. `systemScope` is exempt
 * (migrations, seeds, the decay tick — operator work outside the app). An automation
 * is an ACTOR WITH ITS OWN ROLE, so:
 *
 *  - it behaves identically no matter who tripped it (never the trigger-er's access),
 *  - it can be scoped ("may edit Deals and nothing else"),
 *  - and a run that exceeds its role fails VISIBLY in the run log rather than
 *    silently doing less than the author intended.
 *
 * `role` is `"member"`, not `"system"`: the role only supplies the DEFAULT that rules
 * layer over, and an automation must not inherit admin-by-default. Existing
 * automations are assigned the `automation_full` preset by the backfill, which grants
 * `*` — so behaviour is preserved on rollout and narrowing is an opt-in.
 */
export const actorScope = async (orgId: string, actor: string): Promise<OrgScope> => ({
  orgId,
  actor,
  role: "member",
  policy: await resolvePolicy(orgId, actor),
})

/** Run an engine effect with a given org scope, mapping typed errors to a result. */
export const runEngine = <A, E>(
  scope: OrgScope,
  effect: Runnable<A, E>,
): Promise<UseCaseResult<A>> =>
  AppRuntime.runPromiseExit(effect.pipe(Effect.provideService(OrgContext, scope))).then(toResult)

/** Run an engine effect raw (throws on failure) — for scripts/seeds. */
export const runEngineOrThrow = <A, E>(scope: OrgScope, effect: Runnable<A, E>): Promise<A> =>
  AppRuntime.runPromise(effect.pipe(Effect.provideService(OrgContext, scope)))
