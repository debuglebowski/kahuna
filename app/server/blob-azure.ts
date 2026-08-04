import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob"
import { Effect, Layer } from "effect"
import { BlobError, BlobStore } from "#engine"

export interface AzureConfig {
  /** Container name. Must already exist — we never create it (see below). */
  readonly container: string
  /** The portal's connection string. Wins over account/accountKey when set. */
  readonly connectionString?: string
  readonly account?: string
  readonly accountKey?: string
  /** Service-URL override: Azurite, a sovereign cloud, or a custom domain. */
  readonly endpoint?: string
}

/**
 * Azure has NO S3-compatible endpoint, so this is a native driver rather than a
 * config of `blob-s3.ts`. Reaching Azure over the S3 API would mean running a
 * translating gateway (S3Proxy/Flexify) — a whole extra process in the path of
 * every upload, to avoid the file you are reading.
 *
 * The container must exist before the server boots. Creating it on demand would
 * need container-level rights on the credential, which is a much bigger grant
 * than "read and write my own blobs" — not worth widening the blast radius to
 * save operators one `az storage container create`.
 */
export const AzureBlobStore = (cfg: AzureConfig) =>
  Layer.sync(BlobStore, () => {
    const container = serviceClient(cfg).getContainerClient(cfg.container)
    return {
      put: (key, data, contentType) =>
        Effect.tryPromise({
          try: () =>
            container
              .getBlockBlobClient(key)
              // `uploadData` (not `upload`) — it takes a Uint8Array directly and
              // splits anything large into staged blocks, where `upload` caps at
              // a single 5000 MiB request.
              .uploadData(data, {
                blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
              }),
          catch: (e) => new BlobError({ message: `azure put ${key}: ${String(e)}` }),
        }).pipe(Effect.asVoid),
      get: (key) =>
        Effect.tryPromise({
          try: () => container.getBlockBlobClient(key).downloadToBuffer(),
          catch: (e) => new BlobError({ message: `azure get ${key}: ${String(e)}` }),
        }),
      del: (key) =>
        Effect.tryPromise({
          // `deleteIfExists`, so a already-gone blob is not an error: every
          // caller wraps `del` in `Effect.ignore` anyway, and a 404 here means
          // the postcondition already holds. `deleteSnapshots` matters only if
          // an operator turned snapshots on at the account level.
          try: () =>
            container.getBlockBlobClient(key).deleteIfExists({ deleteSnapshots: "include" }),
          catch: (e) => new BlobError({ message: `azure del ${key}: ${String(e)}` }),
        }).pipe(Effect.asVoid),
    }
  })

/**
 * Built inside `Layer.sync`, so a misconfigured deployment throws when the
 * runtime is first used rather than at import. We check the fields ourselves
 * because `StorageSharedKeyCredential("", "")` fails deep in the SDK with an
 * error that names neither the missing variable nor this driver.
 */
const serviceClient = (cfg: AzureConfig) => {
  if (!cfg.container) throw new Error("BLOB_DRIVER=azure needs AZURE_STORAGE_CONTAINER")
  if (cfg.connectionString) return BlobServiceClient.fromConnectionString(cfg.connectionString)
  if (!cfg.account || !cfg.accountKey)
    throw new Error(
      "BLOB_DRIVER=azure needs AZURE_STORAGE_CONNECTION_STRING, or both AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY",
    )
  return new BlobServiceClient(
    cfg.endpoint ?? `https://${cfg.account}.blob.core.windows.net`,
    new StorageSharedKeyCredential(cfg.account, cfg.accountKey),
  )
}
