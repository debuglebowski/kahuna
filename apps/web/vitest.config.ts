import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { defineConfig } from "vitest/config"

// Load repo-root .env (vitest workers don't inherit bun's --filter env).
const envPath = path.resolve(import.meta.dirname, "../../.env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m?.[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "")
    }
  }
}
// One test database for the whole suite (engine + server + client). The engine
// used to be a separate package with its own vitest config and its own DB; both
// now live here, so `TEST_DATABASE_URL` is rewritten once and every DB-bound
// component — the engine's PgLive, its test harness (which reads
// TEST_DATABASE_URL directly via Config.redacted), and BetterAuth — points at
// the same place. Tests isolate by using a unique org_id each, not by database.
if (process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL.replace(
    /\/[^/]*$/,
    "/kingsmaker_test_web",
  )
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}

export default defineConfig({
  // `#engine`/`#db` come from package.json `imports`, which Vite resolves
  // natively. Only `@/*` needs an explicit alias (it mirrors vite.config.ts).
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["engine/**/*.test.ts", "server/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
})
