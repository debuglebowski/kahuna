import { and, asc, eq } from "drizzle-orm"
import type { Effect } from "effect"
import { member } from "#db"
import type { EngineServices, OrgContext } from "#engine"
import { auth } from "./auth"
import { db, pool } from "./db"
import { isAdminRole, type Role } from "./policy"
import { resolvePolicy, runEngine, sessionScope, type UseCaseResult } from "./runtime"

/** Resolve a user's role within an org from the BetterAuth `member` table. */
export const roleOf = async (userId: string, orgId: string): Promise<Role | null> => {
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
    .limit(1)
  return (rows[0]?.role as Role | undefined) ?? null
}

/** A deactivated member keeps their account + membership but is blocked from
 *  the org (every session-resolved entry point checks this). The marker is an
 *  engine-schema sidecar table, so it's read via the shared pool (the same way
 *  rpc.ts reaches engine tables), not the BetterAuth drizzle schema. */
export const isDeactivated = async (userId: string, orgId: string): Promise<boolean> => {
  const r = await pool.query(
    "SELECT 1 FROM member_deactivations WHERE org_id = $1 AND user_id = $2 LIMIT 1",
    [orgId, userId],
  )
  return r.rows.length > 0
}

export type OrgResolution =
  | { readonly ok: true; readonly orgId: string; readonly actor: string; readonly role: Role }
  | { readonly ok: false; readonly status: number; readonly code: string }

/**
 * `resolveOrg` plus an admin check — the plain-HTTP analogue of rpc.ts's
 * `requireAdmin`, for handlers that never enter the RPC middleware.
 *
 * Use it for anything acting on ORG-WIDE state: the shared integration
 * connectors (PostHog / Linear / Apollo / Clay / the Slack bot) hold one
 * credential per org, so a plain member could otherwise disconnect the whole
 * org's Linear or re-point PostHog at a project they control.
 *
 * NOT for per-user credentials — Google and the Slack *user* token are keyed
 * (org_id, user_id), and their owner must stay able to connect/disconnect their
 * own mailbox or identity without being an admin.
 */
export const resolveAdmin = async (request: Request): Promise<OrgResolution> => {
  const org = await resolveOrg(request)
  if (!org.ok) return org
  // The role already came back on the resolution — no second lookup.
  if (!isAdminRole(org.role)) return { ok: false, status: 403, code: "FORBIDDEN" }
  return org
}

/**
 * `resolveOrg` plus an OWNER check — strictly narrower than `resolveAdmin`.
 *
 * For state that decides who can get into the org at all: the SSO provider and
 * the sign-in method toggles (server/sso.ts). An admin re-pointing the org at an
 * IdP they control would be granting themselves and anyone they like a way in,
 * so that stays with the one role the org cannot have more than a few of.
 */
export const resolveOwner = async (request: Request): Promise<OrgResolution> => {
  const org = await resolveOrg(request)
  if (!org.ok) return org
  if (org.role !== "owner") return { ok: false, status: 403, code: "FORBIDDEN" }
  return org
}

/**
 * Resolve the BetterAuth session into an org scope (org_id + actor), or an
 * auth error. Shared by `runScoped` (RPC/attachments) and the SSE stream — the
 * stream NEVER trusts the client for its org; it comes from the session here.
 */
/**
 * Repair a session that has no active org but whose user IS a member of one.
 *
 * `databaseHooks.session.create.before` (auth.ts) stamps the active org from the
 * user's first membership — but on a first SSO login there is no membership yet
 * when it runs. The plugin creates the user and the session, THEN calls
 * `assignOrganizationFromProvider` (verified in the installed
 * `@better-auth/sso` callback), so the brand-new session is stamped `null` and
 * every subsequent request would fail `NO_ACTIVE_ORG` until the user signed out
 * and back in.
 *
 * Repairing here rather than reordering the hook keeps this independent of
 * plugin internals, and covers the same race for any other path that creates a
 * membership after a session (e.g. `POST /api/org/members` for a user who was
 * already signed in). Returns the adopted org id, or null if there genuinely
 * isn't one — which stays a real `NO_ACTIVE_ORG`.
 */
const adoptFirstOrg = async (request: Request, userId: string): Promise<string | null> => {
  const [m] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1)
  if (!m) return null
  // Go through the API, not a direct UPDATE, so the org plugin stays the owner
  // of what "active" means (and any session-cookie cache enabled later is kept
  // in step). A failure here is not fatal: fall through and use the id anyway
  // for THIS request; the next one retries.
  await auth.api
    .setActiveOrganization({ body: { organizationId: m.organizationId }, headers: request.headers })
    .catch((e) => {
      console.error("failed to adopt active org", { userId, error: String(e) })
    })
  return m.organizationId
}

export const resolveOrg = async (request: Request): Promise<OrgResolution> => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return { ok: false, status: 401, code: "UNAUTHENTICATED" }

  const orgId =
    session.session.activeOrganizationId ?? (await adoptFirstOrg(request, session.user.id))
  if (!orgId) return { ok: false, status: 409, code: "NO_ACTIVE_ORG" }

  const role = await roleOf(session.user.id, orgId)
  if (!role) return { ok: false, status: 403, code: "NOT_A_MEMBER" }

  if (await isDeactivated(session.user.id, orgId)) {
    return { ok: false, status: 403, code: "DEACTIVATED" }
  }

  return { ok: true, orgId, actor: session.user.id, role }
}

/**
 * The single server↔engine chokepoint: read the BetterAuth session, build an
 * OrgContext (org_id + actor + role + policy), run the engine effect, map typed
 * errors. Every `/api/*` handler is a thin adapter over this. The role comes from
 * the resolved membership via `sessionScope`, so a request can never carry engine
 * (`"system"`) privilege.
 *
 * The access policy is resolved ONCE here, not per query: a list read needs the
 * whole rule set before it can filter, and `PolicyService` memoizes on the org's
 * policy generation so this costs one indexed lookup on the warm path.
 */
export const runScoped = async <A, E>(
  request: Request,
  effect: Effect.Effect<A, E, OrgContext | EngineServices>,
): Promise<UseCaseResult<A>> => {
  const org = await resolveOrg(request)
  if (!org.ok) return { ok: false, status: org.status, code: org.code }
  const policy = await resolvePolicy(org.orgId, org.actor)
  return runEngine(sessionScope(org.orgId, org.actor, org.role, policy), effect)
}
