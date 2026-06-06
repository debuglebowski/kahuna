import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./auth-schema"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"

/** Shared pg pool + Drizzle client for BetterAuth (same Postgres as the engine). */
export const pool = new Pool({ connectionString })
export const db = drizzle(pool, { schema })
