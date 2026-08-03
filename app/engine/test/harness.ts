import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { LocalFsBlobStore } from "../blob/local"
import type { PolicySet } from "../domain/access"
import { EngineLive } from "../layers"
import { OrgContext, type ScopeRole } from "../services/OrgContext"

/** SqlClient layer pointed at the dedicated test database. */
export const PgTestLive = PgClient.layerConfig({
  url: Config.redacted("TEST_DATABASE_URL"),
})

const BlobTestLive = LocalFsBlobStore(path.join(tmpdir(), "kingsmaker-test-blobs"))

/** A fully-provided engine layer scoped to one org (Engine + Pg + Blob + OrgContext).
 *
 *  `role` defaults to `"system"` so the existing suite keeps exercising the
 *  unfiltered engine — read visibility is asserted by tests that pass a role
 *  explicitly (`"member"` / `"admin"`), not by every test incidentally.
 *
 *  `policy` defaults to ABSENT, which means "no access rules" — every decision then
 *  falls through to the resource defaults, i.e. exactly the role-only behaviour the
 *  suite asserted before the access model existed. Pass one to exercise a rule
 *  widening or denying a default. */
export const testLayer = (
  orgId: string,
  actor = "tester",
  role: ScopeRole = "system",
  policy?: PolicySet,
) =>
  Layer.provideMerge(
    EngineLive,
    Layer.mergeAll(
      PgTestLive,
      BlobTestLive,
      Layer.succeed(OrgContext, { orgId, actor, role, policy }),
    ),
  )

export const newOrgId = (): string => randomUUID()
