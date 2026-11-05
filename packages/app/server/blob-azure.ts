import { Readable } from "node:stream"
import { DefaultAzureCredential } from "@azure/identity"
import {
  BlobServiceClient,
  type BlockBlobClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob"
import { Effect, Layer } from "effect"
import { BlobError, BlobStore } from "#engine"

/** Block size for staged uploads: the most one upload holds in memory. */
const BLOCK_BYTES = 4 * 1024 * 1024

/** Block ids must be base64 and all the same length within one blob. */
const blockId = (i: number) => Buffer.from(String(i).padStart(8, "0")).toString("base64")

/**
 * Stream `body` into a block blob: fill one `BLOCK_BYTES` buffer, stage it, repeat;
 * then commit the list. Memory stays at one block however large the file.
 *
 * Hand-rolled on purpose. The SDK's `uploadStream` does the same thing but hangs
 * (or 400s) under Bun — fine under Node, so a vitest run would never show it — and
 * `uploadData` needs the whole file as one buffer, which is what this replaces.
 * `stageBlock` with a Buffer body is the request shape `uploadData` already used.
 *
 * A stream that errors stops before the commit: the staged blocks stay
 * uncommitted — never readable, an existing blob under the key untouched — and
 * Azure garbage-collects them.
 */
const putBlocks = async (
  blob: BlockBlobClient,
  body: ReadableStream<Uint8Array>,
  contentType?: string,
) => {
  const ids: string[] = []
  let block = Buffer.allocUnsafe(BLOCK_BYTES)
  let filled = 0
  const stage = async () => {
    const id = blockId(ids.length)
    await blob.stageBlock(id, block.subarray(0, filled), filled)
    ids.push(id)
    block = Buffer.allocUnsafe(BLOCK_BYTES)
    filled = 0
  }
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.byteLength) {
        const n = Math.min(BLOCK_BYTES - filled, value.byteLength - offset)
        block.set(value.subarray(offset, offset + n), filled)
        filled += n
        offset += n
        if (filled === BLOCK_BYTES) await stage()
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (filled > 0) await stage()
  await blob.commitBlockList(ids, {
    blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
  })
}

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
      put: (key, body, contentType) =>
        Effect.tryPromise({
          try: () => putBlocks(container.getBlockBlobClient(key), body, contentType),
          catch: (e) => new BlobError({ message: `azure put ${key}: ${String(e)}` }),
        }),
      get: (key) =>
        Effect.tryPromise({
          // `download()` resolves once the response headers are in, so a missing
          // key (404) rejects HERE; the body then streams.
          try: async () => {
            const res = await container.getBlockBlobClient(key).download()
            if (!res.readableStreamBody) throw new Error("no body")
            return Readable.toWeb(
              res.readableStreamBody as Readable,
            ) as unknown as ReadableStream<Uint8Array>
          },
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
