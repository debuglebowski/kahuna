import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"

const applyMigrations = async (client: Client, dir: string) => {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), "utf8")
    for (const stmt of text.split("--> statement-breakpoint")) {
      const s = stmt.trim()
      if (s.length > 0) await client.query(s)
    }
  }
}

/**
 * Recreate the test DB and apply the migrations.
 *
 * This is the only global setup for the whole suite (engine + server + client).
 * It applies the raw `.sql` itself rather than shelling out to `drizzle-kit`, so
 * it deliberately does NOT exercise the deploy path or write a ledger — that is
 * what `server/migrate-fresh.test.ts` is for.
 */
export default async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL
  if (!testUrl) throw new Error("TEST_DATABASE_URL must be set (see .env)")
  const testName = new URL(testUrl).pathname.replace(/^\//, "")
  const adminUrl = new URL(testUrl)
  adminUrl.pathname = "/kahuna"

  const admin = new Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS "${testName}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${testName}"`)
  await admin.end()

  const db = new Client({ connectionString: testUrl })
  await db.connect()
  await applyMigrations(db, path.resolve(import.meta.dirname, "../db/migrations"))
  await db.end()
}
