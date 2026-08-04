/**
 * The shared BlobStore contract (engine/blob/conformance.ts) run under BUN — the
 * runtime the server actually boots in. Complements `server/blob-drivers.test.ts`,
 * which runs the same cases under vitest/Node. Two things live only here:
 *
 *   - the s3 driver, which builds a `Bun.S3Client` and so cannot execute under
 *     vitest at all;
 *   - Bun-vs-Node compat. `@azure/storage-blob` is a Node-targeted SDK leaning on
 *     Bun's compat surface (core-http-compat, node streams, crypto). A Bun upgrade
 *     could break it while every Node-side test stays green.
 *
 * Each driver runs only if its target is configured/reachable, and the summary
 * says which ones sat out — a silent skip is indistinguishable from a pass.
 *
 *   local  always (a temp dir)
 *   azure  Azurite on :11000, or a real account via AZURE_STORAGE_*
 *            docker run --rm -p 11000:10000 mcr.microsoft.com/azure-storage/azurite \
 *              azurite-blob --blobHost 0.0.0.0 --blobPort 10000 --skipApiVersionCheck
 *   s3     set S3_TEST_ENDPOINT + S3_TEST_ACCESS_KEY_ID + S3_TEST_SECRET_ACCESS_KEY
 *          + S3_TEST_BUCKET (MinIO, R2, or real S3)
 *            docker run --rm -p 11001:9000 -e MINIO_ROOT_USER=minioadmin \
 *              -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
 */
import { randomUUID } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob"
import type { Layer } from "effect"
import { type BlobStore, LocalFsBlobStore } from "#engine"
import { BLOB_CONFORMANCE_CASES } from "../engine/blob/conformance"
import { AzureBlobStore } from "../server/blob-azure"
import { S3BlobStore } from "../server/blob-s3"

const AZURITE_ACCOUNT = "devstoreaccount1"
// Azurite's well-known development key — public, fixed, useless off the emulator.
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="

let failures = 0
const skipped: string[] = []

const runDriver = async (name: string, layer: Layer.Layer<BlobStore>) => {
  console.log(`\n${name}`)
  for (const c of BLOB_CONFORMANCE_CASES) {
    try {
      await c.run(layer)
      console.log(`  ✓ ${c.name}`)
    } catch (e) {
      failures++
      console.log(`  ✗ ${c.name} — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// --- local -----------------------------------------------------------------
await runDriver(
  "local",
  LocalFsBlobStore(await mkdtemp(path.join(tmpdir(), "kingsmaker-blob-verify-"))),
)

// --- azure -----------------------------------------------------------------
const azureAccount = process.env.AZURE_STORAGE_ACCOUNT ?? AZURITE_ACCOUNT
const azureKey = process.env.AZURE_STORAGE_KEY ?? AZURITE_KEY
const azureEndpoint =
  process.env.AZURE_STORAGE_ENDPOINT ??
  (azureAccount === AZURITE_ACCOUNT
    ? `${process.env.AZURITE_URL ?? "http://127.0.0.1:11000"}/${AZURITE_ACCOUNT}`
    : undefined)
const azureBase = azureEndpoint ?? `https://${azureAccount}.blob.core.windows.net`
const azureUp = await fetch(azureBase, { signal: AbortSignal.timeout(2000) })
  .then(() => true)
  .catch(() => false)

if (!azureUp) {
  skipped.push(`azure (nothing answering at ${azureBase})`)
} else {
  const container = process.env.AZURE_STORAGE_CONTAINER ?? `verify-${randomUUID()}`
  // The driver never creates containers; do what a real operator would do first.
  await new BlobServiceClient(azureBase, new StorageSharedKeyCredential(azureAccount, azureKey))
    .getContainerClient(container)
    .createIfNotExists()
  await runDriver(
    `azure (${azureBase})`,
    AzureBlobStore({
      container,
      account: azureAccount,
      accountKey: azureKey,
      endpoint: azureEndpoint,
    }),
  )
}

// --- s3 --------------------------------------------------------------------
const s3Endpoint = process.env.S3_TEST_ENDPOINT
if (!s3Endpoint) {
  skipped.push("s3 (set S3_TEST_ENDPOINT + key/secret/bucket)")
} else {
  await runDriver(
    `s3 (${s3Endpoint})`,
    S3BlobStore({
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "",
      bucket: process.env.S3_TEST_BUCKET ?? "",
      region: process.env.S3_TEST_REGION,
      endpoint: s3Endpoint,
    }),
  )
}

for (const s of skipped) console.log(`\n○ SKIPPED ${s}`)
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
