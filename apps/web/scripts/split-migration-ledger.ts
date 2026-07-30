/**
 * One-time migration-ledger split for databases created BEFORE the engine and
 * BetterAuth migration sets were given separate ledger tables.
 *
 * Both `drizzle.config.ts` files used to default to `drizzle.__drizzle_migrations`.
 * Drizzle's migrator gates each migration on the single newest `created_at` in
 * that table, so the two interleaved journals silently swallowed each other on a
 * fresh database. They now record into `__drizzle_migrations_engine` and
 * `__drizzle_migrations_auth` respectively.
 *
 * An existing database already HAS every migration applied, but only in the old
 * shared table — so both new ledgers look empty and drizzle would re-run all 48
 * migrations against a populated schema. This copies the already-applied rows
 * into the new per-set ledgers, matching on the migration hash (sha256 of the
 * raw .sql file, exactly as drizzle computes it).
 *
 * Idempotent: rows already present in a new ledger are left alone. The legacy
 * table is NOT dropped — it is harmless, and keeping it preserves a rollback
 * path. Safe to run against dev and prod.
 *
 * Run from `apps/web` (where `pg` resolves):
 *
 *   bun scripts/split-migration-ledger.ts            # apply
 *   bun scripts/split-migration-ledger.ts --dry-run  # report only
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"

const DRY_RUN = process.argv.includes("--dry-run")
const REPO = path.resolve(import.meta.dirname, "../../..")

interface MigrationSet {
  readonly label: string
  readonly dir: string
  readonly table: string
}

const SETS: readonly MigrationSet[] = [
  {
    label: "engine",
    dir: path.join(REPO, "packages/db/migrations"),
    table: "__drizzle_migrations_engine",
  },
  {
    label: "auth",
    dir: path.join(REPO, "apps/web/server/migrations"),
    table: "__drizzle_migrations_auth",
  },
]

interface JournalEntry {
  readonly tag: string
  readonly when: number
}

/** Hash a migration file the same way drizzle's migrator does. */
const hashOf = (dir: string, tag: string): string =>
  createHash("sha256")
    .update(readFileSync(path.join(dir, `${tag}.sql`)))
    .digest("hex")

const readJournal = (dir: string): readonly JournalEntry[] =>
  JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")).entries

const main = async (): Promise<void> => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL must be set")

  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    const legacyExists = await client.query(
      "select 1 from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations'",
    )
    if (legacyExists.rowCount !== 1) {
      console.log("No legacy drizzle.__drizzle_migrations table — nothing to split.")
      return
    }

    const legacy = await client.query<{ hash: string; created_at: string }>(
      "select hash, created_at from drizzle.__drizzle_migrations",
    )
    const applied = new Map(legacy.rows.map((r) => [r.hash, r.created_at]))
    console.log(`Legacy ledger: ${applied.size} applied migration(s).\n`)

    for (const set of SETS) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS drizzle.${set.table} (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `)

      const existing = await client.query<{ hash: string }>(`select hash from drizzle.${set.table}`)
      const present = new Set(existing.rows.map((r) => r.hash))

      const journal = readJournal(set.dir)
      const toCopy: Array<{ tag: string; hash: string; createdAt: string }> = []
      const notApplied: string[] = []

      for (const entry of journal) {
        const hash = hashOf(set.dir, entry.tag)
        if (present.has(hash)) continue
        const createdAt = applied.get(hash)
        // Absent from the legacy ledger => genuinely not applied to this DB.
        // Leave it for `drizzle-kit migrate` to apply normally.
        if (createdAt === undefined) {
          notApplied.push(entry.tag)
          continue
        }
        toCopy.push({ tag: entry.tag, hash, createdAt })
      }

      if (!DRY_RUN && toCopy.length > 0) {
        await client.query("BEGIN")
        try {
          for (const row of toCopy) {
            await client.query(
              `insert into drizzle.${set.table} ("hash", "created_at") values ($1, $2)`,
              [row.hash, row.createdAt],
            )
          }
          await client.query("COMMIT")
        } catch (e) {
          await client.query("ROLLBACK")
          throw e
        }
      }

      const verb = DRY_RUN ? "would copy" : "copied"
      console.log(
        `${set.label}: ${verb} ${toCopy.length} row(s) into drizzle.${set.table}` +
          ` (${present.size} already there, ${journal.length} in journal)`,
      )
      if (notApplied.length > 0) {
        console.log(
          `  ${notApplied.length} not yet applied to this DB, left for migrate: ${notApplied.join(", ")}`,
        )
      }
    }

    console.log(
      DRY_RUN
        ? "\nDry run — nothing written. Re-run without --dry-run to apply."
        : "\nDone. Legacy table left in place; `drizzle-kit migrate` now reads the split ledgers.",
    )
  } finally {
    await client.end()
  }
}

await main()
