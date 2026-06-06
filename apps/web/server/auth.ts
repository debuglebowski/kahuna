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
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  plugins: [organization()],
})

export type Auth = typeof auth
