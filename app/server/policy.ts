import { decide } from "#engine"
import { resolvePolicy } from "./runtime"

export type Role = "owner" | "admin" | "member"

/**
 * Who may administer the org.
 *
 * This file used to hold `can(role, action)` — the whole v1 permission model — and
 * then `isAdminRole`, a bare check on the BetterAuth membership role. Both are gone:
 * "is this person an admin?" is not a property of their membership tier any more, it
 * is whether they hold `configure` on the org through some role.
 *
 * Why that had to change: Admin is now an ordinary access role, editable and
 * assignable like any other, so an org can grant org-configuration to "Ops" without
 * touching anyone's membership row. A tier check would have silently ignored that.
 *
 * OWNER short-circuits. An owner's session resolves an unrestricted policy anyway
 * (see `sessionScope`), so this is only a shortcut past the lookup — but it is also
 * the statement that an owner can never be locked out, which no rule may contradict.
 */
export const canConfigure = async (
  orgId: string,
  actor: string,
  role: Role | string | null,
): Promise<boolean> => {
  if (role === "owner") return true
  if (!role) return false
  const policy = await resolvePolicy(orgId, actor)
  // `unconditionalOnly`: a conditional grant ("configure records you created") is not
  // an answer to "may this person administer the org".
  return decide(policy, "configure", { type: "org" }, false, { unconditionalOnly: true })
}
