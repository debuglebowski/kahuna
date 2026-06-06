import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"

/**
 * Vitest global setup: (re)create a clean test database and apply the engine
 * migrations once. Tests then isolate themselves by using a unique org_id each,
 * so no per-test truncation is needed.
 */
export default async function setup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL
  const testUrl = process.env.TEST_DATABASE_URL
  if (!adminUrl || !testUrl) {
    throw new Error("DATABASE_URL and TEST_DATABASE_URL must be set (see .env)")
  }
  const testName = new URL(testUrl).pathname.replace(/^\//, "")

  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS "${testName}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${testName}"`)
  await admin.end()

  const migDir = path.resolve(import.meta.dirname, "../../../db/migrations")
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()

  const db = new Client({ connectionString: testUrl })
  await db.connect()
  for (const file of files) {
    const text = readFileSync(path.join(migDir, file), "utf8")
    for (const stmt of text.split("--> statement-breakpoint")) {
      const s = stmt.trim()
      if (s.length > 0) await db.query(s)
    }
  }
  await db.end()
}
