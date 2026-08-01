import { execFile } from "node:child_process"
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { Client } from "pg"
import { afterAll, describe, expect, it } from "vitest"

const exec = promisify(execFile)

/**
 * Guards the real `drizzle-kit` deploy path. Four invariants:
 * completeness, idempotency, journal monotonicity, and schema drift.
 *
 * The rest of the suite cannot catch regressions here: `test/global-setup.ts`
 * applies the raw `.sql` itself with no ledger, so it passes on a schema no
 * deploy path actually produces.
 *
 * History, because it explains why these specific things are asserted. There
 * used to be TWO migration sets (engine in packages/db, auth in app)
 * against one database, sharing drizzle's default ledger. The migrator gates
 * each migration on the single newest `created_at` in that table, so the
 * interleaved journals swallowed each other: on an empty DB, engine-then-auth
 * applied 37, skipped all 11 auth ones, and STILL EXITED 0 — no `bauth_user`
 * table, "migrations applied successfully!". The same failure also existed
 * within one set: a hand-written migration carried a `when` 100s BEHIND its
 * predecessor, so a DB stopped there would skip it forever.
 *
 * Both are now structurally impossible (one config, one journal, one ledger),
 * which is exactly why these tests exist — to keep it that way.
 */

const APP_DIR = path.resolve(import.meta.dirname, "..")
const MIGRATIONS_DIR = path.join(APP_DIR, "db/migrations")

interface JournalEntry {
  readonly tag: string
  readonly when: number
}

const journal = (dir: string): readonly JournalEntry[] =>
  JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")).entries

/** Rows a complete run records — read from the journal so adding a migration doesn't break this. */
const EXPECTED_LEDGER_ROWS = journal(MIGRATIONS_DIR).length

/** Admin URL (an existing DB on the same server) used to create/drop scratch DBs. */
const adminUrl = (): string => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL must be set")
  return url
}

const withAdmin = async (fn: (c: Client) => Promise<void>): Promise<void> => {
  const client = new Client({ connectionString: adminUrl() })
  await client.connect()
  try {
    await fn(client)
  } finally {
    await client.end()
  }
}

const scratchUrl = (name: string): string => {
  const url = new URL(adminUrl())
  url.pathname = `/${name}`
  return url.toString()
}

const createScratchDb = async (name: string): Promise<void> => {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await c.query(`CREATE DATABASE "${name}"`)
  })
}

const dropScratchDb = async (name: string): Promise<void> => {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  })
}

/**
 * Run the real migrate command against `url`. CWD must be app/ — drizzle-kit
 * resolves `out`/`schema` against process.cwd() (the config asserts this too).
 */
const migrate = async (url: string): Promise<void> => {
  await exec("bunx", ["drizzle-kit", "migrate"], {
    cwd: APP_DIR,
    env: { ...process.env, DATABASE_URL: url },
  })
}

interface DbState {
  readonly ledgerRows: number
  readonly tableCount: number
  readonly hasAuthTable: boolean
  readonly hasEngineTable: boolean
}

const inspect = async (url: string): Promise<DbState> => {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    // A missing ledger reports 0 rather than throwing, so a regression fails on
    // the meaningful assertion instead of an incidental "relation does not
    // exist". Existence is checked separately because Postgres resolves the
    // relation at parse time — a `where exists (...)` guard still throws.
    const present = await client.query(
      "select 1 from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations'",
    )
    const ledgerRows =
      present.rowCount === 1
        ? Number(
            (
              await client.query<{ n: string }>(
                "select count(*)::text as n from drizzle.__drizzle_migrations",
              )
            ).rows[0]?.n ?? 0,
          )
        : 0

    const has = async (table: string): Promise<boolean> =>
      (
        await client.query(
          "select 1 from information_schema.tables where table_schema = 'public' and table_name = $1",
          [table],
        )
      ).rowCount === 1

    const tables = await client.query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_schema = 'public'",
    )

    return {
      ledgerRows,
      tableCount: Number(tables.rows[0]?.n ?? 0),
      // Both halves are probed at the schema level: with one migration set the
      // ledger row count can no longer distinguish "the auth tables landed"
      // from "the engine tables landed".
      hasAuthTable: await has("bauth_user"),
      hasEngineTable: await has("events"),
    }
  } finally {
    await client.end()
  }
}

const SCRATCH_DB = "km_migrations_test"

describe("migrations", () => {
  afterAll(async () => {
    await dropScratchDb(SCRATCH_DB)
  })

  it("applies the full schema to an empty database, and is idempotent", async () => {
    await createScratchDb(SCRATCH_DB)
    const url = scratchUrl(SCRATCH_DB)

    await migrate(url)
    const first = await inspect(url)

    // Exact count, not a truthiness check: a partially-applied baseline would
    // pass `> 0`. 58 tables + the instance_state_readable view.
    // (56 + automations + automation_runs, added by 0001.)
    expect(first.tableCount).toBe(59)
    expect(first.hasAuthTable).toBe(true)
    expect(first.hasEngineTable).toBe(true)
    expect(first.ledgerRows).toBe(EXPECTED_LEDGER_ROWS)

    // Idempotency is what makes `docker compose run --rm app migrate` safe to
    // run on every deploy: a second pass must not re-apply DDL.
    await migrate(url)
    expect(await inspect(url)).toEqual(first)
  }, 240_000)

  it("has a strictly increasing journal, with one .sql per entry", () => {
    const entries = journal(MIGRATIONS_DIR)
    expect(entries.length).toBeGreaterThan(0)

    for (const [i, entry] of entries.entries()) {
      expect(
        existsSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`)),
        `journal names ${entry.tag} but ${entry.tag}.sql is missing`,
      ).toBe(true)

      const prev = entries[i - 1]
      if (!prev) continue
      // drizzle gates every migration on the newest `created_at` already in the
      // ledger, so a journal that goes backwards means any database stopped at
      // the higher timestamp skips the lower one SILENTLY AND FOREVER. This
      // really happened here: a hand-written 0025 sat 100s behind 0024.
      expect(
        entry.when,
        `journal is not monotonic: ${entry.tag} (${entry.when}) is not after ${prev.tag} (${prev.when}) — ` +
          `a database stopped at ${prev.tag} would skip ${entry.tag} forever`,
      ).toBeGreaterThan(prev.when)
    }
  })

  it("has no schema drift — the baseline matches the schema files", async () => {
    // Catches "edited db/schema.ts and forgot to generate". Generates into a
    // COPY of the migrations dir so a failure can't dirty the working tree.
    //
    // The copy must live INSIDE app under a relative path: drizzle-kit
    // prepends "./" to whatever `--out` it is given, so an absolute path
    // becomes `.//tmp/...` and dies with ENOENT reading the snapshot. Same
    // reason drizzle.config.ts uses relative paths.
    const rel = `.drift-${process.pid}`
    const tmp = path.join(APP_DIR, rel)
    try {
      rmSync(tmp, { recursive: true, force: true })
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true })
      const before = readdirSync(tmp).filter((f) => f.endsWith(".sql")).length

      // Explicit --dialect/--schema/--out rather than --config: drizzle-kit
      // rejects mixing --config with other params ("ambiguous params"), and
      // this way no config file is loaded at all.
      const { stdout } = await exec(
        "bunx",
        ["drizzle-kit", "generate", "--dialect", "postgresql", "--schema", "./db", "--out", rel],
        { cwd: APP_DIR },
      )

      const after = readdirSync(tmp).filter((f) => f.endsWith(".sql")).length

      // Assert on stdout AND the filesystem, never the exit code: drizzle-kit
      // wraps generate in try/catch with no rethrow, so it exits 0 even when
      // it threw. "no new files" alone is a false pass for the same reason.
      expect(stdout).toContain("No schema changes")
      expect(after).toBe(before)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 240_000)
})
