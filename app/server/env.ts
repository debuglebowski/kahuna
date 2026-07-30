import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Load the monorepo-root `.env` into `process.env`.
 *
 * Bun only auto-loads `.env` from the process CWD, but this server is launched
 * from `app` (which has no `.env`) — the repo's single `.env` lives at the
 * root. Without this, `DATABASE_URL` is absent and the engine's `PgClient`
 * (`Config.redacted("DATABASE_URL")`, no fallback) crashes on the first RPC.
 *
 * Synchronous + imported first in `index.ts` so it runs before any module that
 * reads `process.env` at import time (e.g. `./db`). Real env vars win over the
 * file, so production / test (vitest sets DATABASE_URL) are unaffected.
 */
const envPath = path.resolve(import.meta.dirname, "../../.env")

try {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "")
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key || process.env[key] !== undefined) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
} catch {
  // No root `.env` (e.g. CI / prod inject real env vars) — nothing to load.
}
