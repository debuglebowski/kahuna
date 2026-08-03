export type Role = "owner" | "admin" | "member"

/**
 * The role→default mapping, and nothing more.
 *
 * This file used to hold `can(role, action)` — the whole v1 permission model. That
 * job now belongs to `engine/domain/access.ts:decide()`, which resolves a caller's
 * access rules over a default. What survives here is only how a MEMBERSHIP ROLE
 * computes that default, because the roles themselves still come from BetterAuth.
 *
 * `decide()` is the only place that combines this with rules. Anything reaching for
 * a bare role check should ask whether it wants an action check instead — see
 * `requireAction` in rpc.ts.
 */

/**
 * Owner/admin: the two roles that may administer the org.
 *
 * The privilege order is explicit rather than a rank comparison, matching
 * `canReadRestricted` in the engine: a new role must be classified on purpose, not
 * inherit access by sorting above "member".
 */
export const isAdminRole = (role: string): boolean => role === "owner" || role === "admin"
