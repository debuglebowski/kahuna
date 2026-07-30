import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  // Engine migrations get their OWN ledger, separate from the BetterAuth set in
  // apps/web. Both default to `drizzle.__drizzle_migrations`, and drizzle's
  // migrator only compares each migration against the single newest
  // `created_at` in that table — so sharing it makes the two interleaved
  // journals eat each other. On an empty DB, engine-first silently skipped all
  // 11 auth migrations and still exited 0 ("migrations applied successfully!");
  // auth-first skipped 28 engine migrations and then failed half-applied.
  // Must be nested under `migrations` — a top-level `migrationsTable` is
  // silently ignored by drizzle-kit.
  migrations: { table: "__drizzle_migrations_engine" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker",
  },
})
