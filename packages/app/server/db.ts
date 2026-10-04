import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "#db"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kahuna:kahuna@localhost:5544/kahuna"

/**
 * Shared pg pool + Drizzle client for BetterAuth (same Postgres as the engine).
 *
 * Note the two similar names: `server/db.ts` (this file — the CONNECTION) vs
 * `#db` / `app/db/` (the SCHEMA). Importing `pool` from `#db` typechecks as
 * a missing export, but the reverse mistake — reaching for a table object here —
 * would be quieter, so keep the distinction in mind.
 */
export const pool = new Pool({ connectionString })
export const db = drizzle(pool, { schema })
