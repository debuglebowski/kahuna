import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BlobError, BlobStore } from "./BlobStore"

/** A local-filesystem BlobStore rooted at `dir` (the default driver). */
export const LocalFsBlobStore = (dir: string) =>
  Layer.succeed(BlobStore, {
    put: (key, data) =>
      Effect.tryPromise({
        try: async () => {
          const file = path.join(dir, key)
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(file, data)
        },
        catch: (e) => new BlobError({ message: `put ${key}: ${String(e)}` }),
      }),
    get: (key) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await readFile(path.join(dir, key))),
        catch: (e) => new BlobError({ message: `get ${key}: ${String(e)}` }),
      }),
    del: (key) =>
      Effect.tryPromise({
        // Swallow ENOENT: "already gone" is the postcondition, not a failure.
        // s3 and azure are both idempotent here, and `del` runs twice in normal
        // operation (a purge racing an owner cascade). Without this, every
        // caller's `Effect.ignore` is load-bearing rather than defensive.
        try: async () => {
          try {
            await unlink(path.join(dir, key))
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          }
        },
        catch: (e) => new BlobError({ message: `del ${key}: ${String(e)}` }),
      }),
  })
