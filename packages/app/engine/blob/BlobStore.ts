import { Context, Data, type Effect } from "effect"

export class BlobError extends Data.TaggedError("BlobError")<{ readonly message: string }> {}

/**
 * Bytes move as STREAMS in both directions, never as one whole buffer: an upload
 * is piped from the request body straight to the backend, a download from the
 * backend straight to the response. Holding a 100 MB file in memory (twice, once
 * per copy) on a 1 GiB replica is what this shape exists to prevent — see
 * `MAX_UPLOAD_BYTES` in the contract.
 */
export interface BlobStoreApi {
  /** Consume `body` to the end and store it under `key`. Fails if the stream
   *  errors, and then leaves nothing readable under a NEW key (callers always
   *  use fresh keys; a failed overwrite is driver-defined). */
  readonly put: (
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType?: string,
  ) => Effect.Effect<void, BlobError>
  /** Open `key` for reading. A missing key FAILS here, not mid-stream. */
  readonly get: (key: string) => Effect.Effect<ReadableStream<Uint8Array>, BlobError>
  readonly del: (key: string) => Effect.Effect<void, BlobError>
}

/**
 * A narrow content-addressed byte store. Implementations: local filesystem
 * (default), S3-compatible and Azure. Provided as a layer at the boundary.
 */
export class BlobStore extends Context.Service<BlobStore, BlobStoreApi>()("engine/BlobStore") {}

/** One in-memory chunk as a stream — for callers that already hold the bytes. */
export const bytesStream = (data: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (data.length > 0) controller.enqueue(data)
      controller.close()
    },
  })

/** Drain a stream into one buffer. Tests and verify scripts only — production
 *  paths stream end to end. */
export const collectBytes = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer())
