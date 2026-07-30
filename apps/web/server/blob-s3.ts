import { BlobError, BlobStore } from "#engine"
import { Effect, Layer } from "effect"

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
      put: (key, data, contentType) =>
        Effect.tryPromise({
          try: () => client.write(key, data, contentType ? { type: contentType } : undefined),
          catch: (e) => new BlobError({ message: `s3 put ${key}: ${String(e)}` }),
        }).pipe(Effect.asVoid),
      get: (key) =>
        Effect.tryPromise({
          try: () => client.file(key).bytes(),
          catch: (e) => new BlobError({ message: `s3 get ${key}: ${String(e)}` }),
        }),
      del: (key) =>
        Effect.tryPromise({
          try: () => client.file(key).delete(),
          catch: (e) => new BlobError({ message: `s3 del ${key}: ${String(e)}` }),
        }).pipe(Effect.asVoid),
    }
  })
