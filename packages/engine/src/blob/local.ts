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
        try: () => unlink(path.join(dir, key)),
        catch: (e) => new BlobError({ message: `del ${key}: ${String(e)}` }),
      }),
  })
