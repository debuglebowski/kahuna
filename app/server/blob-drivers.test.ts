/**
 * The shared BlobStore contract (engine/blob/conformance.ts), run against every
 * driver this runtime CAN reach. Before this existed, `local` was covered only
 * incidentally by attachments.test.ts and the cloud drivers not at all.
 *
 * Vitest executes under NODE, which bounds what belongs here:
 *   - local — always.
 *   - azure — when Azurite is reachable. The SDK is pure JS, so Node is fine:
 *       docker run --rm -p 11000:10000 mcr.microsoft.com/azure-storage/azurite \
 *         azurite-blob --blobHost 0.0.0.0 --blobPort 10000 --skipApiVersionCheck
 *   - s3    — NEVER. `S3BlobStore` builds a `Bun.S3Client`, and there is no
 *       `Bun` global here. It is covered by `scripts/verify-blob-drivers.ts`,
 *       which runs the same cases under Bun. Do not "fix" this by adding an s3
 *       block; it can only fail.
 *
 * A skipped emulator reads exactly like a pass, so the describe title names the
 * driver that sat out.
 */
import { randomUUID } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob"
import { describe, it } from "vitest"
import { LocalFsBlobStore } from "#engine"
// Direct, not via the `#engine` barrel: re-exporting test-only code there would
// pull conformance.ts into the image's import graph (check:imports traces it).
import { BLOB_CONFORMANCE_CASES } from "../engine/blob/conformance"
import { AzureBlobStore } from "./blob-azure"

describe("local driver", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kingsmaker-blob-conformance-"))
  const layer = LocalFsBlobStore(dir)
  for (const c of BLOB_CONFORMANCE_CASES) it(c.name, () => c.run(layer))
})

const AZURITE_ACCOUNT = "devstoreaccount1"
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="
// Azurite is path-style: the account is a path segment, not a subdomain.
const azuriteEndpoint = `${process.env.AZURITE_URL ?? "http://127.0.0.1:11000"}/${AZURITE_ACCOUNT}`

const azuriteUp = await fetch(azuriteEndpoint, { signal: AbortSignal.timeout(1000) })
  .then(() => true)
  .catch(() => false)

describe.skipIf(!azuriteUp)("azure driver (Azurite)", async () => {
  const container = `conformance-${randomUUID()}`
  if (azuriteUp) {
    // The driver never creates containers — that needs a much wider grant — so
    // the harness does what a real operator would do first.
    await new BlobServiceClient(
      azuriteEndpoint,
      new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_KEY),
    )
      .getContainerClient(container)
      .createIfNotExists()
  }
  const layer = AzureBlobStore({
    container,
    account: AZURITE_ACCOUNT,
    accountKey: AZURITE_KEY,
    endpoint: azuriteEndpoint,
  })
  for (const c of BLOB_CONFORMANCE_CASES) it(c.name, () => c.run(layer))
})
