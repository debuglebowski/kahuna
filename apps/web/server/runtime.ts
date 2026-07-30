import type { PgClient } from "@effect/sql-pg"
import {
  EngineLive,
  type EngineServices,
  LocalFsBlobStore,
  OrgContext,
  type OrgScope,
  PgLive,
} from "#engine"
import { Cause, Effect, type Exit, Layer, ManagedRuntime, Option } from "effect"
import { S3BlobStore } from "./blob-s3"

const BlobLive =
  process.env.BLOB_DRIVER === "s3"
    ? S3BlobStore({
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
        bucket: process.env.S3_BUCKET ?? "",
        region: process.env.S3_REGION,
        endpoint: process.env.S3_ENDPOINT,
      })
    : LocalFsBlobStore(process.env.BLOB_LOCAL_DIR ?? "./.blobstore")

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
  EventCorruption: { status: 500, code: "INTERNAL" },
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

/** Run an engine effect with a given org scope, mapping typed errors to a result. */
export const runEngine = <A, E>(
  scope: OrgScope,
  effect: Runnable<A, E>,
): Promise<UseCaseResult<A>> =>
  AppRuntime.runPromiseExit(effect.pipe(Effect.provideService(OrgContext, scope))).then(toResult)

/** Run an engine effect raw (throws on failure) — for scripts/seeds. */
export const runEngineOrThrow = <A, E>(scope: OrgScope, effect: Runnable<A, E>): Promise<A> =>
  AppRuntime.runPromise(effect.pipe(Effect.provideService(OrgContext, scope)))
