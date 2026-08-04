import { DefaultAzureCredential } from "@azure/identity"
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob"
import { Effect, Layer } from "effect"
import { BlobError, BlobStore } from "#engine"

export interface AzureConfig {
  /** Container name. Must already exist — we never create it (see below). */
  readonly container: string
  /** The portal's connection string. Wins over account/accountKey when set. */
  readonly connectionString?: string
  /** Storage account name. Required unless `connectionString` is set. */
  readonly account?: string
  /** Shared key. OMIT to authenticate as a managed identity instead. */
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
 *
 * Authenticates by connection string, account + shared key, or a managed
 * identity — see `azureServiceClient` below for the selection order.
 */
export const AzureBlobStore = (cfg: AzureConfig) =>
  Layer.sync(BlobStore, () => {
    const container = azureServiceClient(cfg).getContainerClient(cfg.container)
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
 * Credential selection, most-explicit first:
 *
 *   1. connection string — carries its OWN `BlobEndpoint`, so `endpoint` does
 *      NOT apply on this path. The two are mutually exclusive by construction,
 *      not by choice.
 *   2. account + key — shared key. What Azurite speaks, and the only path the
 *      conformance suites can exercise.
 *   3. account alone — `DefaultAzureCredential`: the user-assigned managed
 *      identity on Container Apps, workload identity on AKS, or `az login`
 *      locally. Nothing to configure beyond the account name; the identity has
 *      to hold Storage Blob Data Contributor on the container.
 *
 * Exported so `scripts/verify-blob-drivers.ts` creates its container with the
 * SAME credential the driver will use — a second copy of this ladder would be
 * free to drift.
 *
 * Built inside `Layer.sync`, so a misconfigured deployment throws when the
 * runtime is first used rather than at import. We check the fields ourselves
 * because `StorageSharedKeyCredential("", "")` fails deep in the SDK with an
 * error that names neither the missing variable nor this driver.
 */
export const azureServiceClient = (cfg: AzureConfig) => {
  if (!cfg.container) throw new Error("BLOB_DRIVER=azure needs AZURE_STORAGE_CONTAINER")
  if (cfg.connectionString) return BlobServiceClient.fromConnectionString(cfg.connectionString)
  if (!cfg.account)
    throw new Error(
      "BLOB_DRIVER=azure needs AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT — with AZURE_STORAGE_KEY, or alone to authenticate as a managed identity",
    )
  const url = cfg.endpoint ?? `https://${cfg.account}.blob.core.windows.net`
  if (cfg.accountKey)
    return new BlobServiceClient(url, new StorageSharedKeyCredential(cfg.account, cfg.accountKey))
  // NOTE the failure mode this opens up: DefaultAzureCredential constructs fine
  // with no identity present, and only fails at the first blob operation. So an
  // account set WITHOUT a key used to be a boot-time error naming the missing
  // variable, and is now a runtime one. The right trade for the managed-identity
  // deploy (there is genuinely no key to name), but a plain forgotten
  // AZURE_STORAGE_KEY now surfaces later, and as whichever error the SDK reaches
  // first — CredentialUnavailable when no identity is present, or, if `url` is
  // http://, "Bearer token authentication is not permitted for non-TLS protected
  // URLs" before any token is even requested. That last one also means identity
  // auth is HTTPS-only: it cannot work against Azurite or any plain-http endpoint.
  return new BlobServiceClient(url, new DefaultAzureCredential())
}
