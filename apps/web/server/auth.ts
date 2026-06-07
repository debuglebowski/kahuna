import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import * as schema from "./auth-schema"
import { db } from "./db"

/**
 * BetterAuth owns Tier-0 identity: user / session / account / verification plus
 * the organization plugin's organization / member / invitation tables. The
 * engine FKs to these logically (org_id = organization.id, actor = user.id) but
 * never writes them.
 */
// Origins allowed to make auth requests (CSRF protection). BetterAuth always
// trusts the baseURL origin; these are appended. In dev the browser runs on the
// Vite origin (any localhost port — it drifts when 5173 is taken) while the API
// is on :3000, so dev trusts all localhost ports via a glob. Production trusts
// only the baseURL plus whatever TRUSTED_ORIGINS lists (comma-separated).
const isProd = process.env.NODE_ENV === "production"
const envOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
const trustedOrigins = isProd
  ? envOrigins
  : [...envOrigins, "http://localhost:*", "http://127.0.0.1:*"]

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins,
  plugins: [organization()],
})

export type Auth = typeof auth
