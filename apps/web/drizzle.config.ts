import { defineConfig } from "drizzle-kit"

/** Migrations for the BetterAuth-owned Tier-0 tables (separate from the engine). */
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/auth-schema.ts",
  out: "./server/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker",
  },
})
