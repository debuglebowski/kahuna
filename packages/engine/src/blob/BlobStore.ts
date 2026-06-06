import { Context, Data, type Effect } from "effect"

export class BlobError extends Data.TaggedError("BlobError")<{ readonly message: string }> {}

export interface BlobStoreApi {
  readonly put: (
    key: string,
    data: Uint8Array,
    contentType?: string,
  ) => Effect.Effect<void, BlobError>
  readonly get: (key: string) => Effect.Effect<Uint8Array, BlobError>
  readonly del: (key: string) => Effect.Effect<void, BlobError>
}

/**
 * A narrow content-addressed byte store. Implementations: local filesystem
 * (default) and S3-compatible. Provided as a layer at the boundary.
 */
export class BlobStore extends Context.Tag("engine/BlobStore")<BlobStore, BlobStoreApi>() {}
