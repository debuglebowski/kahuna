import { defineConfig } from "vitest/config"

/**
 * No database, no global setup, no `.env`. The CLI's tests are pure: parsing,
 * rendering, config on a temp directory. Anything that needs a live server is a
 * verify driver in packages/app/scripts, not a unit test — the same split the
 * rest of the repo uses.
 */
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
  },
})
