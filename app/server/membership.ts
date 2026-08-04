import { Effect } from "effect"
import { AccessRoleService } from "#engine"
import { runEngineOrThrow, systemScope } from "./runtime"

/**
 * Give a member the roles they should hold.
 *
 * WHY THIS EXISTS. Membership lives in BetterAuth (`bauth_member.role`), access lives
 * in `access_role_actors`. The backfill assigned roles to every member that existed
 * when access control shipped — but nothing kept the two in step afterwards, so a
 * member who JOINED later held no access role at all.
 *
 * That was invisible for as long as everything fell through to the role-derived
 * default, and it broke the moment something read the RULES: the irreducible-floor
 * check counts who holds `configure`, saw an org with zero holders, and stopped
 * protecting it. Found by `scripts/verify-roles.ts` failing on exactly that assertion.
 *
 * ── TWO HALVES, ONE OF THEM TEMPORARY ────────────────────────────────────────
 *
 * 1. AUTO-ASSIGN — every `user`-kind role flagged `auto_assign` and still `active`.
 *    This is the real mechanism: an org decides where new people land by flipping a
 *    flag on whichever roles it likes, including its own. Purely ADDITIVE — it never
 *    takes a role away, because "should everyone get this?" says nothing about what
 *    an individual was deliberately given.
 *
 * 2. THE MEMBERSHIP MIRROR — `owner`/`admin` membership still points at the managed
 *    role of the same name. This half goes away when membership collapses to
 *    `owner | member` and Admin becomes a role you assign like any other; until then,
 *    removing it would strip every admin of their rules.
 *
 * The mirror moves a member between `owner` and `admin` but never touches `member` —
 * that one is auto-assigned, so everybody holds it and a promotion ADDS rather than
 * replaces. Holding both is harmless: a policy is the union of its allows, and the
 * managed admin role is a superset.
 *
 * Custom roles are never touched by either half — they have no membership
 * counterpart, and clobbering one would silently undo a deliberate grant.
 */
const MIRRORED = ["owner", "admin"] as const

/**
 * Runs as `systemScope` because it is provisioning, not a user action: it must work
 * during the very request that creates the membership, before the new member could
 * hold any access of their own.
 *
 * Never throws. A failure here must not fail the join itself (membership is the
 * source of truth), so it is logged and swallowed.
 */
export const syncMembershipRole = async (
  orgId: string,
  userId: string,
  role: string,
): Promise<void> => {
  await runEngineOrThrow(
    systemScope(orgId, "system:membership-sync"),
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      // An org provisioned before the managed roles existed must not end up role-less.
      yield* roles.ensureBuiltins

      for (const auto of yield* roles.autoAssignFor("user")) {
        yield* roles.assign(auto.id, userId)
      }

      // An unrecognised membership role mirrors nothing and keeps only the
      // auto-assigned roles — fail closed rather than guess at a promotion.
      for (const key of MIRRORED) {
        const mirror = yield* roles.getByKey(key)
        if (!mirror) continue
        if (key === role) yield* roles.assign(mirror.id, userId)
        else yield* roles.unassign(mirror.id, userId)
      }
    }),
  ).catch((e) => {
    console.error("membership role sync failed", { orgId, userId, role, error: String(e) })
  })
}
