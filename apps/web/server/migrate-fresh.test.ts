import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { Client } from "pg"
import { afterAll, describe, expect, it } from "vitest"

const exec = promisify(execFile)

/**
 * Guards the real `drizzle-kit migrate` deploy path against an EMPTY database.
 *
 * The rest of the suite can't catch regressions here: both `global-setup.ts`
 * files apply the raw `.sql` files themselves, in explicit order, with no
 * migration ledger — so they pass on a schema no deploy path actually produces.
 *
 * The bug this pins down: engine and auth migrations originally shared one
 * `drizzle.__drizzle_migrations` table, and drizzle's migrator only compares
 * each migration against the single newest `created_at` there. Because the two
 * journals interleave, whichever set ran first parked a high-water mark that
 * silently swallowed the other — engine-first skipped all 11 auth migrations
 * and STILL exited 0, leaving a DB with no `bauth_user` table.
 */

const REPO = path.resolve(import.meta.dirname, "../../..")
const ENGINE_DIR = path.join(REPO, "packages/db")
const WEB_DIR = path.join(REPO, "apps/web")

/** Journal entry count per migration set — the number of rows a complete run records. */
const journalCount = (dir: string): number =>
  JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")).entries.length

const ENGINE_EXPECTED = journalCount(path.join(ENGINE_DIR, "migrations"))
const AUTH_EXPECTED = journalCount(path.join(WEB_DIR, "server/migrations"))

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

/** Run one migration set against `url`, from its own package dir. */
const migrate = async (set: "engine" | "auth", url: string): Promise<void> => {
  const cwd = set === "engine" ? ENGINE_DIR : WEB_DIR
  await exec("bunx", ["drizzle-kit", "migrate"], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
  })
}

interface FreshState {
  readonly engineRows: number
  readonly authRows: number
  readonly hasAuthUser: boolean
  readonly tableCount: number
}

const inspect = async (url: string): Promise<FreshState> => {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    // A missing ledger reports 0 rather than throwing: when this regresses, the
    // assertion that fires should name the real defect (auth tables absent),
    // not an incidental "relation does not exist" from the probe itself.
    // Existence is checked separately because Postgres resolves the relation at
    // parse time — a `where exists (...)` guard in the same statement still throws.
    const count = async (table: string): Promise<number> => {
      const present = await client.query(
        "select 1 from information_schema.tables where table_schema = 'drizzle' and table_name = $1",
        [table],
      )
      if (present.rowCount !== 1) return 0
      const res = await client.query<{ n: string }>(
        `select count(*)::text as n from drizzle.${table}`,
      )
      return Number(res.rows[0]?.n ?? 0)
    }
    const tables = await client.query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_schema = 'public'",
    )
    const authUser = await client.query(
      "select 1 from information_schema.tables where table_schema = 'public' and table_name = 'bauth_user'",
    )
    return {
      engineRows: await count("__drizzle_migrations_engine"),
      authRows: await count("__drizzle_migrations_auth"),
      hasAuthUser: authUser.rowCount === 1,
      tableCount: Number(tables.rows[0]?.n ?? 0),
    }
  } finally {
    await client.end()
  }
}

/**
 * Both orders must produce an identical, complete schema. Order-independence is
 * the property that separate ledgers buy us, so both directions are asserted —
 * a shared ledger fails one silently (exit 0) and the other loudly (exit 1).
 */
const ORDERS = [
  { name: "engine then auth", sets: ["engine", "auth"] as const, db: "km_migfresh_ea" },
  { name: "auth then engine", sets: ["auth", "engine"] as const, db: "km_migfresh_ae" },
]

type Order = (typeof ORDERS)[number]

/**
 * Build one order's scratch DB and inspect it, memoized per order so each test
 * can demand exactly the state it asserts on without depending on another test
 * having run first (and without re-migrating for the cross-order comparison).
 */
const states = new Map<string, Promise<FreshState>>()

const stateFor = (order: Order): Promise<FreshState> => {
  const cached = states.get(order.db)
  if (cached) return cached
  const built = (async () => {
    await createScratchDb(order.db)
    const url = scratchUrl(order.db)
    for (const set of order.sets) await migrate(set, url)
    return inspect(url)
  })()
  states.set(order.db, built)
  return built
}

describe("drizzle-kit migrate on an empty database", () => {
  afterAll(async () => {
    for (const o of ORDERS) await dropScratchDb(o.db)
  })

  for (const order of ORDERS) {
    it(`applies every migration when run ${order.name}`, async () => {
      const state = await stateFor(order)

      // The exact failure the shared ledger produced: auth silently skipped.
      expect(state.hasAuthUser).toBe(true)
      expect(state.engineRows).toBe(ENGINE_EXPECTED)
      expect(state.authRows).toBe(AUTH_EXPECTED)
    }, 240_000)
  }

  it("produces the same schema regardless of order", async () => {
    const [a, b] = await Promise.all(ORDERS.map(stateFor))
    expect(a).toEqual(b)
  }, 240_000)
})
