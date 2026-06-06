import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { LocalFsBlobStore } from "../blob/local"
import { EngineLive } from "../layers"
import { OrgContext } from "../services/OrgContext"

/** SqlClient layer pointed at the dedicated test database. */
export const PgTestLive = PgClient.layerConfig({
  url: Config.redacted("TEST_DATABASE_URL"),
})

const BlobTestLive = LocalFsBlobStore(path.join(tmpdir(), "kingsmaker-test-blobs"))

/** A fully-provided engine layer scoped to one org (Engine + Pg + Blob + OrgContext). */
export const testLayer = (orgId: string, actor = "tester") =>
  Layer.provideMerge(
    EngineLive,
    Layer.mergeAll(PgTestLive, BlobTestLive, Layer.succeed(OrgContext, { orgId, actor })),
  )

export const newOrgId = (): string => randomUUID()
