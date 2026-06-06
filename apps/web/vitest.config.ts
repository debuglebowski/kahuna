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
// Use a web-specific test DB (so it never clashes with the engine suite's),
// and point every DB-bound component (engine PgLive, BetterAuth) at it.
if (process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL.replace(
    /\/[^/]*$/,
    "/kingsmaker_test_web",
  )
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["server/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
})
