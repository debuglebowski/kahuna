import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { defineConfig } from "vitest/config"

// Load the repo-root .env into process.env (vitest workers don't inherit
// bun's --filter env). Existing vars win.
const envPath = path.resolve(import.meta.dirname, "../../.env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m?.[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "")
    }
  }
}

export default defineConfig({
  test: {
    globalSetup: ["./src/test/global-setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Run files sequentially: they share one test database (isolated per-org).
    fileParallelism: false,
  },
})
