import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { Effect, Layer } from "effect"
import { BlobError, BlobStore } from "./BlobStore"

const unlinkIfPresent = async (file: string) => {
  try {
    await unlink(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
}

/** A local-filesystem BlobStore rooted at `dir` (the default driver). */
export const LocalFsBlobStore = (dir: string) =>
  Layer.succeed(BlobStore, {
    put: (key, body) =>
      Effect.tryPromise({
        // Written beside the target under a temp name, then renamed: a stream
        // that fails halfway (client gone, over the cap) leaves no partial file
        // under the real key, and an overwrite is atomic.
        try: async () => {
          const file = path.join(dir, key)
          const part = `${file}.${randomUUID()}.part`
          await mkdir(path.dirname(file), { recursive: true })
          // A plain reader loop, NOT `pipeline(Readable.fromWeb(body), …)`: under
          // Bun that pipeline never settles when the web stream errors, so a
          // dropped upload hung its request forever (conformance caught it).
          const out = await open(part, "w")
          const reader = body.getReader()
          try {
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                await out.write(value)
              }
            } finally {
              reader.releaseLock()
              await out.close()
            }
            await rename(part, file)
          } catch (e) {
            await unlinkIfPresent(part).catch(() => {})
            throw e
          }
        },
        catch: (e) => new BlobError({ message: `put ${key}: ${String(e)}` }),
      }),
    get: (key) =>
      Effect.tryPromise({
        // `stat` first so a missing key fails HERE — `createReadStream` would
        // only error once the response is already streaming.
        try: async () => {
          const file = path.join(dir, key)
          await stat(file)
          return Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>
        },
        catch: (e) => new BlobError({ message: `get ${key}: ${String(e)}` }),
      }),
    del: (key) =>
      Effect.tryPromise({
        // Swallow ENOENT: "already gone" is the postcondition, not a failure.
        // s3 and azure are both idempotent here, and `del` runs twice in normal
        // operation (a purge racing an owner cascade). Without this, every
        // caller's `Effect.ignore` is load-bearing rather than defensive.
        try: () => unlinkIfPresent(path.join(dir, key)),
        catch: (e) => new BlobError({ message: `del ${key}: ${String(e)}` }),
      }),
  })
