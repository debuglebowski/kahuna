import { randomUUID } from "node:crypto"
import { Effect, type Layer } from "effect"
import { BlobStore, bytesStream, collectBytes } from "./BlobStore"

/**
 * The BlobStore contract, as executable cases — deliberately free of any test
 * framework so BOTH runners can use them:
 *
 *   - `server/blob-drivers.test.ts` wraps them in vitest (`bun run test`), which
 *     executes under NODE. Catches contract drift, but cannot touch the s3
 *     driver at all: it reaches for `Bun.S3Client`, and there is no `Bun` global.
 *   - `scripts/verify-blob-drivers.ts` runs them under BUN, the runtime the
 *     server actually boots in. This is the only place s3 can be exercised, and
 *     the only place a Bun/Node-compat break in the azure SDK would surface.
 *
 * Neither runner subsumes the other. A driver is only really covered when both
 * have run against it.
 */

const assert = (ok: boolean, detail: string) => {
  if (!ok) throw new Error(detail)
}

const bytes = (s: string) => new TextEncoder().encode(s)

/**
 * Every real key is `${orgId}/${uuid}` — the slash is part of the contract, and
 * each backend reads it differently (a real directory, a virtual one, or just a
 * character in the key).
 */
const freshKey = () => `${randomUUID()}/${randomUUID()}`

export interface BlobConformanceCase {
  readonly name: string
  readonly run: (layer: Layer.Layer<BlobStore>) => Promise<void>
}

/** `put` takes a stream; every case below starts from bytes. */
const putBytes = (blob: BlobStore["Service"], key: string, data: Uint8Array, type?: string) =>
  blob.put(key, bytesStream(data), type)

/** `get` hands back a stream; drain it to compare. */
const getBytes = (blob: BlobStore["Service"], key: string) =>
  Effect.flatMap(blob.get(key), (stream) => Effect.promise(() => collectBytes(stream)))

/** A body delivered in many chunks, then failing — a client that disconnects
 *  partway through an upload. */
const failingStream = (chunks: number) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks-- > 0) controller.enqueue(bytes("partial "))
      else controller.error(new Error("client went away"))
    },
  })

const withStore = (
  layer: Layer.Layer<BlobStore>,
  body: (blob: BlobStore["Service"]) => Effect.Effect<void, unknown>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const blob = yield* BlobStore
        yield* body(blob)
      }),
      layer,
    ) as Effect.Effect<void, never>,
  )

export const BLOB_CONFORMANCE_CASES: ReadonlyArray<BlobConformanceCase> = [
  {
    name: "round-trips the exact bytes",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          const payload = bytes(`hello ${randomUUID()}`)
          yield* putBytes(blob, key, payload, "text/plain")
          const got = yield* getBytes(blob, key)
          assert(got.length === payload.length, `length ${got.length} != ${payload.length}`)
          assert(
            got.every((b, i) => b === payload[i]),
            "bytes differ after round-trip",
          )
        }),
      ),
  },
  {
    name: "stores a zero-byte payload",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          yield* putBytes(blob, key, new Uint8Array(0))
          const got = yield* getBytes(blob, key)
          assert(got.length === 0, `expected 0 bytes, got ${got.length}`)
        }),
      ),
  },
  {
    name: "overwrites an existing key",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          yield* putBytes(blob, key, bytes("first"))
          yield* putBytes(blob, key, bytes("second"))
          const got = new TextDecoder().decode(yield* getBytes(blob, key))
          assert(got === "second", `expected "second", got "${got}"`)
        }),
      ),
  },
  {
    name: "fails, rather than throws, on a missing key",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(blob.get(freshKey()))
          assert(result._tag === "Failure", "missing key should fail, not succeed")
        }),
      ),
  },
  {
    name: "del removes the blob",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          yield* putBytes(blob, key, bytes("doomed"))
          yield* blob.del(key)
          const result = yield* Effect.result(getBytes(blob, key))
          assert(result._tag === "Failure", "blob still readable after del")
        }),
      ),
  },
  {
    name: "del is idempotent",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          yield* putBytes(blob, key, bytes("doomed"))
          yield* blob.del(key)
          // Reachable in normal operation (a purge racing an owner cascade), and
          // "already gone" is the postcondition, not an error. The local driver
          // failed this until the ENOENT swallow in local.ts.
          const again = yield* Effect.result(blob.del(key))
          assert(again._tag === "Success", "second del failed")
        }),
      ),
  },
  {
    name: "streams a multi-chunk body larger than one buffer",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          // 9 MiB in 64 KiB chunks: crosses the s3 part size (8 MiB) and the
          // azure block size (4 MiB), so the multi-part paths actually run.
          const chunk = 64 * 1024
          const total = 9 * 1024 * 1024
          let sent = 0
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= total) return controller.close()
              const part = new Uint8Array(chunk).fill((sent / chunk) % 251)
              sent += chunk
              controller.enqueue(part)
            },
          })
          const key = freshKey()
          yield* blob.put(key, body, "application/octet-stream")
          const got = yield* getBytes(blob, key)
          assert(got.length === total, `length ${got.length} != ${total}`)
          for (let i = 0; i < total; i += chunk)
            assert(got[i] === (i / chunk) % 251, `chunk at ${i} differs`)
        }),
      ),
  },
  {
    // Every real key is a fresh uuid, so the contract is about a NEW key. What a
    // failed put does to an EXISTING key is deliberately unspecified: local and
    // azure keep the old bytes, s3 cannot (Bun's writer has no abort).
    name: "a body that fails mid-stream fails the put and leaves nothing readable",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          const put = yield* Effect.result(blob.put(key, failingStream(3)))
          assert(put._tag === "Failure", "put of a failing stream succeeded")
          const got = yield* Effect.result(getBytes(blob, key))
          assert(got._tag === "Failure", "a partial blob is readable after a failed put")
        }),
      ),
  },
]
