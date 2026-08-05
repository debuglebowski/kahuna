import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect } from "effect"

/**
 * The Postgres-backed `SqlClient` layer, configured from `DATABASE_URL`.
 * This is the single place the engine binds to a concrete database.
 */
export const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
})

/**
 * Phase-0 health probe: confirms the SqlClient can reach Postgres.
 * Swallows query errors into `false` so callers get a simple boolean.
 */
export const healthCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly ok: number }>`SELECT 1 AS ok`
  return rows.length > 0 && rows[0]?.ok === 1
}).pipe(Effect.orElseSucceed(() => false))
