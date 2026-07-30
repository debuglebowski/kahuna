import type { EngineServices, OrgContext } from "#engine"
import { and, eq } from "drizzle-orm"
import type { Effect } from "effect"
import { auth } from "./auth"
import { member } from "#db"
import { db, pool } from "./db"
import type { Role } from "./policy"
import { runEngine, type UseCaseResult } from "./runtime"

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
  | { readonly ok: true; readonly orgId: string; readonly actor: string }
  | { readonly ok: false; readonly status: number; readonly code: string }

/**
 * Resolve the BetterAuth session into an org scope (org_id + actor), or an
 * auth error. Shared by `runScoped` (RPC/attachments) and the SSE stream — the
 * stream NEVER trusts the client for its org; it comes from the session here.
 */
export const resolveOrg = async (request: Request): Promise<OrgResolution> => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return { ok: false, status: 401, code: "UNAUTHENTICATED" }

  const orgId = session.session.activeOrganizationId
  if (!orgId) return { ok: false, status: 409, code: "NO_ACTIVE_ORG" }

  const role = await roleOf(session.user.id, orgId)
  if (!role) return { ok: false, status: 403, code: "NOT_A_MEMBER" }

  if (await isDeactivated(session.user.id, orgId)) {
    return { ok: false, status: 403, code: "DEACTIVATED" }
  }

  return { ok: true, orgId, actor: session.user.id }
}

/**
 * The single server↔engine chokepoint: read the BetterAuth session, build an
 * OrgContext (org_id + actor), run the engine effect, map typed errors. Every
 * `/api/*` handler is a thin adapter over this.
 */
export const runScoped = async <A, E>(
  request: Request,
  effect: Effect.Effect<A, E, OrgContext | EngineServices>,
): Promise<UseCaseResult<A>> => {
  const org = await resolveOrg(request)
  if (!org.ok) return { ok: false, status: org.status, code: org.code }
  return runEngine({ orgId: org.orgId, actor: org.actor }, effect)
}
