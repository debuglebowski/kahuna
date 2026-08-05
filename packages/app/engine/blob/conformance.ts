import { randomUUID } from "node:crypto"
import { Effect, type Layer } from "effect"
import { BlobStore } from "./BlobStore"

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

const withStore = (
  layer: Layer.Layer<BlobStore>,
  body: (blob: Effect.Effect.Success<typeof BlobStore>) => Effect.Effect<void, unknown>,
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
          yield* blob.put(key, payload, "text/plain")
          const got = yield* blob.get(key)
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
          yield* blob.put(key, new Uint8Array(0))
          const got = yield* blob.get(key)
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
          yield* blob.put(key, bytes("first"))
          yield* blob.put(key, bytes("second"))
          const got = new TextDecoder().decode(yield* blob.get(key))
          assert(got === "second", `expected "second", got "${got}"`)
        }),
      ),
  },
  {
    name: "fails, rather than throws, on a missing key",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const result = yield* Effect.either(blob.get(freshKey()))
          assert(result._tag === "Left", "missing key should fail, not succeed")
        }),
      ),
  },
  {
    name: "del removes the blob",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          yield* blob.put(key, bytes("doomed"))
          yield* blob.del(key)
          const result = yield* Effect.either(blob.get(key))
          assert(result._tag === "Left", "blob still readable after del")
        }),
      ),
  },
  {
    name: "del is idempotent",
    run: (layer) =>
      withStore(layer, (blob) =>
        Effect.gen(function* () {
          const key = freshKey()
          yield* blob.put(key, bytes("doomed"))
          yield* blob.del(key)
          // Reachable in normal operation (a purge racing an owner cascade), and
          // "already gone" is the postcondition, not an error. The local driver
          // failed this until the ENOENT swallow in local.ts.
          const again = yield* Effect.either(blob.del(key))
          assert(again._tag === "Right", "second del failed")
        }),
      ),
  },
]
