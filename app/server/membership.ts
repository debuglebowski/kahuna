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
 * ── ONE MECHANISM: AUTO-ASSIGN ───────────────────────────────────────────────
 *
 * Every `user`-kind role flagged `auto_assign` and still `active`. An org decides
 * where new people land by flipping a flag on whichever roles it likes, including
 * its own.
 *
 * Purely ADDITIVE. It never takes a role away, because "should everyone get this?"
 * says nothing about what an individual was deliberately given — and custom roles
 * have no membership counterpart at all, so clobbering one would silently undo a
 * deliberate grant.
 *
 * The membership MIRROR that used to live here is gone with the collapse: membership
 * is `owner | member`, owner is a bypass that needs no role, and Admin is an ordinary
 * role you assign. `role` is still taken so callers read naturally and so an
 * unrecognised value can be logged, but nothing branches on it any more.
 */

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
    }),
  ).catch((e) => {
    console.error("membership role sync failed", { orgId, userId, role, error: String(e) })
  })
}
