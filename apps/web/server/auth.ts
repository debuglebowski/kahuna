import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import { asc, eq } from "drizzle-orm"
import * as schema from "./auth-schema"
import { db, pool } from "./db"
import { runEngineOrThrow } from "./runtime"
import { seedKingsmaker } from "./seed/seed"

/**
 * Delete every engine-owned row for an org — the inverse of the create-time
 * seed. The engine tables key on `org_id` with no DB-level FK to the
 * BetterAuth `organization` row, so they must be purged explicitly or they
 * orphan. Child→parent order respects the engine's internal FKs. Throws on
 * failure so `beforeDeleteOrganization` aborts the whole deletion. (Blob
 * payloads behind attachments are left in storage — harmless, content-addressed.)
 */
async function purgeOrgEngineData(orgId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("DELETE FROM annotations WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM task_statuses WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM annotation_fields WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM attachments WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM relations WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM instances WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM items WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM fields WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM events WHERE org_id = $1", [orgId])
    await client.query("DELETE FROM concepts WHERE org_id = $1", [orgId])
    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

/**
 * BetterAuth owns Tier-0 identity: user / session / account / verification plus
 * the organization plugin's organization / member / invitation tables. The
 * engine FKs to these logically (org_id = organization.id, actor = user.id) but
 * never writes them.
 */
// Origins allowed to make auth requests (CSRF protection). BetterAuth always
// trusts the baseURL origin; these are appended. In dev the browser runs on the
// Vite origin (:5100, pinned via strictPort) while the API is on :3100; dev
// keeps the all-localhost glob so an API_PROXY second stack still works.
// Production trusts only the baseURL plus whatever TRUSTED_ORIGINS lists
// (comma-separated).
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
  // Settings → Security: allow self-serve email change + account deletion.
  // Both are off by default; we have no mail provider, so these update directly
  // (email is unverified) / are password-gated rather than email-verified.
  user: {
    changeEmail: { enabled: true },
    deleteUser: { enabled: true },
  },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3100",
  trustedOrigins,
  databaseHooks: {
    session: {
      create: {
        // Default the active org on EVERY new session to the user's first
        // membership. The client only calls organization.setActive on sign-up,
        // so without this a plain sign-in yields a session with no active org
        // and every RPC fails the auth middleware with NO_ACTIVE_ORG.
        before: async (session) => {
          const [m] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1)
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } }
        },
      },
    },
  },
  plugins: [
    organization({
      organizationHooks: {
        // Seed the Kingsmaker concepts into every new org, server-side, so it
        // can't be skipped by a failed/absent client call. Idempotent.
        afterCreateOrganization: async ({ organization, user }) => {
          try {
            await runEngineOrThrow({ orgId: organization.id, actor: user.id }, seedKingsmaker)
          } catch (error) {
            console.error(`Failed to seed org ${organization.id}:`, error)
          }
        },
        // Purge the org's engine data BEFORE it is deleted. Throwing here aborts
        // the deletion (BetterAuth awaits this and only deletes on success), so
        // we never end up with an absent org but orphaned engine rows.
        beforeDeleteOrganization: async ({ organization }) => {
          await purgeOrgEngineData(organization.id)
        },
      },
    }),
  ],
})

export type Auth = typeof auth
