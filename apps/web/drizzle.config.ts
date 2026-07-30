import { existsSync } from "node:fs"
import path from "node:path"
import { defineConfig } from "drizzle-kit"

/**
 * The ONE drizzle config. Do not add a second.
 *
 * This repo previously had two — one for the engine tables (packages/db) and one
 * for the BetterAuth + integration tables (apps/web) — both pointed at the same
 * database. They shared drizzle's default `__drizzle_migrations` ledger, and the
 * migrator gates each migration on the SINGLE NEWEST `created_at` in that table.
 * Because the two journals interleaved, whichever set ran first parked a
 * high-water mark that silently swallowed the other: on an empty database,
 * engine-then-auth applied 37 migrations, skipped all 11 auth ones, and still
 * exited 0 with "migrations applied successfully!" — leaving no `bauth_user`
 * table. (Fixed first by splitting the ledgers in e4dc17a, then structurally by
 * collapsing to one set. `git show e4dc17a` has the full post-mortem.)
 *
 * The same failure mode also existed *within* one set: a hand-written migration
 * carried a `when` timestamp 100s BEHIND its predecessor, so any database
 * stopped at that point would have skipped it forever. One journal entry cannot
 * interleave with itself; `server/migrate-fresh.test.ts` now asserts
 * monotonicity so a future hand-edit cannot reintroduce it.
 *
 * ALWAYS INVOKE VIA `bun run db:*` FROM THE REPO ROOT (or with CWD=apps/web).
 * drizzle-kit resolves `schema` and `out` against `process.cwd()`, not against
 * this file, so the paths below are relative and the CWD matters. Absolute paths
 * are not an option: `migrate` accepts them, but `generate` prepends "./" and
 * then fails with `ENOENT .//Users/...` when reading the snapshot. The npm
 * scripts (`bun run --filter @kingsmaker/web db:generate`) set CWD to apps/web,
 * which is why they are the supported entry point.
 *
 * Guard below: if `out` resolved to somewhere without a journal, drizzle-kit
 * would silently treat the folder as empty and "apply" nothing — so assert the
 * baseline is actually visible from the current directory.
 */
const MIGRATIONS_DIR = "./db/migrations"

if (!existsSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"))) {
  throw new Error(
    `drizzle-kit must run with CWD=apps/web — no journal at ${MIGRATIONS_DIR}/meta/_journal.json ` +
      `(cwd is ${process.cwd()}). Use \`bun run db:migrate\` from the repo root.`,
  )
}

export default defineConfig({
  dialect: "postgresql",
  // The whole directory: db/schema.ts (engine tables, DDL-only — the engine
  // queries them with raw SQL) + db/auth-schema.ts (BetterAuth + integrations,
  // a real runtime drizzle model).
  schema: "./db",
  out: MIGRATIONS_DIR,
  // Explicit even though it is drizzle's default: with one set there is nothing
  // to collide with, and naming it documents that there is exactly one ledger.
  // Must be nested under `migrations` — a top-level `migrationsTable` is
  // silently ignored by drizzle-kit.
  migrations: { table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker",
  },
})
