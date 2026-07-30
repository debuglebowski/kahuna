import { defineConfig } from "drizzle-kit"

/** Migrations for the BetterAuth-owned Tier-0 tables (separate from the engine). */
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/auth-schema.ts",
  out: "./server/migrations",
  // Own ledger, separate from the engine's — see the note in
  // packages/db/drizzle.config.ts for why sharing one silently drops
  // migrations. Nested under `migrations`; top-level `migrationsTable` is
  // silently ignored by drizzle-kit.
  migrations: { table: "__drizzle_migrations_auth" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker",
  },
})
