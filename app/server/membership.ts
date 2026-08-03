import { Effect } from "effect"
import { AccessRoleService } from "#engine"
import { runEngineOrThrow, systemScope } from "./runtime"

/**
 * Keep a member's ACCESS ROLE in step with their BetterAuth membership role.
 *
 * WHY THIS EXISTS. Membership lives in BetterAuth (`bauth_member.role`), access lives
 * in `access_role_actors`. The backfill assigned presets to every member that existed
 * when access control shipped — but nothing kept the two in step afterwards, so a
 * member who JOINED later held no access role at all.
 *
 * That was invisible for as long as everything fell through to the role-derived
 * default (which P1/P2 deliberately made identical to the presets), and it broke the
 * moment something read the RULES instead: the irreducible-floor check counts who
 * holds `configure`, saw an org with zero holders, and stopped protecting it. Found by
 * `scripts/verify-roles.ts` failing on exactly that assertion.
 *
 * Only the three membership presets are mirrored. Custom roles are never touched —
 * they have no membership counterpart, and clobbering them would silently undo an
 * admin's deliberate grant.
 */
const PRESET_FOR: Record<string, string> = {
  owner: "owner",
  admin: "admin",
  member: "member",
}

const MEMBERSHIP_PRESETS = ["owner", "admin", "member"] as const

/**
 * Point the member at the preset matching `role`, dropping the other two.
 *
 * Runs as `systemScope` because it is provisioning, not a user action: it must work
 * during the very request that creates the membership, before the new member could
 * hold any access of their own. An unrecognised role maps to `member`, the narrowest
 * preset — fail closed.
 *
 * Never throws. A failure here must not fail the join itself (membership is the source
 * of truth, and the role-derived defaults still apply), so it is logged and swallowed.
 */
export const syncMembershipRole = async (
  orgId: string,
  userId: string,
  role: string,
): Promise<void> => {
  const wanted = PRESET_FOR[role] ?? "member"
  await runEngineOrThrow(
    systemScope(orgId, "system:membership-sync"),
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      // An org provisioned before the presets existed must not end up role-less.
      yield* roles.ensureBuiltins
      for (const key of MEMBERSHIP_PRESETS) {
        const preset = yield* roles.getByKey(key)
        if (!preset) continue
        if (key === wanted) yield* roles.assign(preset.id, userId)
        else yield* roles.unassign(preset.id, userId)
      }
    }),
  ).catch((e) => {
    console.error("membership role sync failed", { orgId, userId, role, error: String(e) })
  })
}
