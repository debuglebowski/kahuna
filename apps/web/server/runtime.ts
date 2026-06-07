import {
  EngineLive,
  type EngineServices,
  LocalFsBlobStore,
  OrgContext,
  type OrgScope,
  PgLive,
} from "@kingsmaker/engine"
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

/** Engine services + Postgres pool + BlobStore, built once (no OrgContext). */
export const EngineBase = Layer.provide(EngineLive, Layer.merge(PgLive, BlobLive))

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
  FieldValidationError: { status: 422, code: "VALIDATION" },
  IllegalTransition: { status: 422, code: "ILLEGAL_TRANSITION" },
  RelationTargetMismatch: { status: 422, code: "RELATION_TARGET_MISMATCH" },
  FieldConfigInvalid: { status: 422, code: "FIELD_CONFIG_INVALID" },
  VersionConflict: { status: 409, code: "VERSION_CONFLICT" },
  ConceptNameConflict: { status: 409, code: "CONFLICT" },
  FieldNameConflict: { status: 409, code: "CONFLICT" },
  InstanceNotFound: { status: 404, code: "NOT_FOUND" },
  ConceptNotFound: { status: 404, code: "NOT_FOUND" },
  RelationNotFound: { status: 404, code: "NOT_FOUND" },
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

/** Run an engine effect with a given org scope, mapping typed errors to a result. */
export const runEngine = <A, E>(
  scope: OrgScope,
  effect: Effect.Effect<A, E, OrgContext | EngineServices>,
): Promise<UseCaseResult<A>> =>
  AppRuntime.runPromiseExit(effect.pipe(Effect.provideService(OrgContext, scope))).then(toResult)

/** Run an engine effect raw (throws on failure) — for scripts/seeds. */
export const runEngineOrThrow = <A, E>(
  scope: OrgScope,
  effect: Effect.Effect<A, E, OrgContext | EngineServices>,
): Promise<A> => AppRuntime.runPromise(effect.pipe(Effect.provideService(OrgContext, scope)))
