// Load repo-root .env (vitest runs with CWD=packages/app, which has no .env of its own).
// This is the SERVER's loader, imported for its side effect, so tests and the
// running server agree on which keys exist. It used to be a second, subtly
// different regex here (`^\s*([A-Z0-9_]+)=`) that silently dropped
// `export FOO=bar`, lowercase, and mixed-case keys the server accepts — i.e. a
// key could be visible to the server and invisible to every test.
// It resolves the path from its own import.meta.dirname, so CWD does not matter.
import "./server/env.ts"
import path from "node:path"
import { defineConfig } from "vitest/config"

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
