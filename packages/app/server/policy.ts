import { type AccessResource, decide, type PolicySet } from "#engine"
import { resolvePolicy, withLayer0 } from "./runtime"

export type Role = "owner" | "member"

/**
 * Who may administer the org — or, since `role` and `member` became real resource
 * types, one narrower slice of it.
 *
 * This file used to hold `can(role, action)` — the whole v1 permission model — and
 * then `isAdminRole`, a bare check on the BetterAuth membership role. Both are gone:
 * "is this person an admin?" is not a property of their membership tier any more, it
 * is whether they hold `configure` on a RESOURCE through some role.
 *
 * Why that had to change: Admin is now an ordinary access role, editable and
 * assignable like any other, so an org can grant org-configuration to "Ops" without
 * touching anyone's membership row. A tier check would have silently ignored that.
 *
 * `resource` defaults to `{type:"org"}` — schema/settings administration, unchanged
 * for every existing caller. Pass `{type:"member"}` for the member roster or
 * `{type:"role"}` for role/rule editing, so "may manage people" and "may manage
 * permissions" can be granted separately from org configuration and from each other.
 *
 * OWNER no longer short-circuits for every resource — that was the pre-Layer-0
 * bypass, and leaving it here would have quietly reintroduced it at every call site
 * below even though `sessionScope` no longer grants it. An owner gets the SAME
 * Layer 0 floor a live session gets (`configure` on `role`/`member` only, added by
 * `withLayer0`) and is decided by the cascade like anyone else for every other
 * resource — including `org`, which Layer 0 deliberately does not cover.
 */
export const canConfigure = async (
  orgId: string,
  actor: string,
  role: Role | string | null,
  resource: AccessResource = { type: "org" },
): Promise<boolean> => {
  if (!role) return false
  const policy = await resolvePolicy(orgId, actor)
  return decideConfigure(policy, role, resource)
}

/**
 * The pure core of `canConfigure` — given an already-resolved policy, decide
 * `configure` on `resource`. Split out so the Layer-0-vs-cascade behaviour is
 * unit-testable without a database; `canConfigure` is just this plus the lookup.
 */
export const decideConfigure = (
  policy: PolicySet,
  role: Role | string | null,
  resource: AccessResource = { type: "org" },
): boolean => {
  if (!role) return false
  const effective = role === "owner" ? withLayer0(policy.actorId, policy) : policy
  // `unconditionalOnly`: a conditional grant ("configure records you created") is not
  // an answer to "may this person administer the org".
  return decide(effective, "configure", resource, false, { unconditionalOnly: true })
}
