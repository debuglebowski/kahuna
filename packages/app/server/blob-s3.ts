import { Effect, Layer } from "effect"
import { BlobError, BlobStore } from "#engine"

export interface S3Config {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly bucket: string
  readonly region?: string
  readonly endpoint?: string
}

/**
 * S3-compatible BlobStore backed by Bun's native S3 client (works with AWS S3,
 * MinIO, Cloudflare R2, etc.). `Bun` is referenced only inside the factory, so
 * this module is import-safe under non-Bun runtimes (the default driver is local).
 */
export const S3BlobStore = (cfg: S3Config) =>
  Layer.sync(BlobStore, () => {
    const client = new Bun.S3Client({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
    })
    return {
      put: (key, body, contentType) =>
        Effect.tryPromise({
          // A multipart upload in `partSize` parts, `queueSize` in flight: memory
          // stays at ~partSize × queueSize however large the file. Bun's writer
          // has no abort — `end(error)` still COMMITS what it buffered (verified
          // against an S3 emulator) — so a failed stream is ended and then the
          // key deleted. Keys are fresh uuids, so nothing else lived there.
          try: async () => {
            const file = client.file(key)
            const writer = file.writer({
              type: contentType,
              partSize: 8 * 1024 * 1024,
              queueSize: 2,
            })
            const reader = body.getReader()
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                await writer.write(value)
              }
            } catch (e) {
              const err = e instanceof Error ? e : new Error(String(e))
              await Promise.resolve(writer.end(err)).catch(() => {})
              await file.delete().catch(() => {})
              throw e
            } finally {
              reader.releaseLock()
            }
            await writer.end()
          },
          catch: (e) => new BlobError({ message: `s3 put ${key}: ${String(e)}` }),
        }),
      get: (key) =>
        Effect.tryPromise({
          // `exists()` first so a missing key fails HERE, not once the response
          // is already streaming.
          try: async () => {
            const file = client.file(key)
            if (!(await file.exists())) throw new Error("NoSuchKey")
            return file.stream() as ReadableStream<Uint8Array>
          },
          catch: (e) => new BlobError({ message: `s3 get ${key}: ${String(e)}` }),
        }),
      del: (key) =>
        Effect.tryPromise({
          try: () => client.file(key).delete(),
          catch: (e) => new BlobError({ message: `s3 del ${key}: ${String(e)}` }),
        }).pipe(Effect.asVoid),
    }
  })
