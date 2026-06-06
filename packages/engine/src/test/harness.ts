import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { EngineLive } from "../layers"
import { OrgContext } from "../services/OrgContext"

/** SqlClient layer pointed at the dedicated test database. */
export const PgTestLive = PgClient.layerConfig({
  url: Config.redacted("TEST_DATABASE_URL"),
})

/** A fully-provided engine layer scoped to one org (Engine + Pg + OrgContext). */
export const testLayer = (orgId: string, actor = "tester") =>
  Layer.provideMerge(
    EngineLive,
    Layer.mergeAll(PgTestLive, Layer.succeed(OrgContext, { orgId, actor })),
  )

export const newOrgId = (): string => randomUUID()
