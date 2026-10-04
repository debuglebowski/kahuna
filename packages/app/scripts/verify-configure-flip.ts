/**
 * Prove that closing the last role-derived fallback changed nobody's answer.
 *
 * `requireAction` used to fall back to `isAdminRole(bauth_member.role)` for
 * `configure` and `delete`; it now falls back to `false`, and an administrator
 * passes on the strength of a ROLE granting it. That is only equivalent if every
 * member actually holds a role that says so — which is what P2's backfill is for,
 * and the failure mode if it did not run is silent (buttons stop working, quietly,
 * for people who should have them).
 *
 * So: for every (org, member, action) on the org resource, compute BOTH answers and
 * require they match.
 *
 *   before = decide(policy, action, org, isAdminRole(membershipRole))
 *   after  = membershipRole === 'owner' ? true : decide(policy, action, org, false)
 *
 * A difference in either direction is reported. `after` being WIDER matters as much
 * as narrower: it would mean someone gained org configuration.
 *
 * Run: bun scripts/verify-configure-flip.ts
 */

import { Pool } from "pg"
import { type AccessRule, decide, emptyPolicy, type PolicySet } from "#engine"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kahuna:kahuna@localhost:5544/kahuna"
const pool = new Pool({ connectionString })

const ACTIONS = ["configure", "delete", "view", "edit"] as const

/** The OLD tier predicate, restated here so it survives its own deletion. */
const wasAdmin = (role: string): boolean => role === "owner" || role === "admin"

interface RuleRow {
  readonly id: string
  readonly role_id: string | null
  readonly actor_id: string | null
  readonly effect: string
  readonly actions: ReadonlyArray<string>
  readonly resource_type: string
  readonly resource_id: string | null
  readonly concept_id: string | null
  readonly condition: unknown
}

const toRule = (r: RuleRow): AccessRule =>
  ({
    id: r.id,
    roleId: r.role_id,
    actorId: r.actor_id,
    effect: r.effect === "allow" ? "allow" : "deny",
    actions: r.actions,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    conceptId: r.concept_id,
    condition: r.condition ?? null,
  }) as AccessRule

const main = async () => {
  const members = await pool.query<{ org_id: string; user_id: string; role: string }>(
    `SELECT organization_id AS org_id, user_id, role FROM bauth_member ORDER BY organization_id`,
  )
  console.log(`${members.rowCount} membership(s)`)

  let compared = 0
  let drift = 0

  for (const m of members.rows) {
    // The same union PolicyService.loadRules builds — INACTIVE roles excluded, since
    // that is what a live request would see.
    const rules = await pool.query<RuleRow>(
      `SELECT r.id, r.role_id, r.actor_id, r.effect, r.actions, r.resource_type,
              r.resource_id, r.concept_id, r.condition
         FROM access_rules r
        WHERE r.org_id = $1
          AND (r.actor_id = $2
               OR r.role_id IN (
                 SELECT a.role_id FROM access_role_actors a
                 JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
                WHERE a.org_id = $1 AND a.actor_id = $2 AND ro.active = true))`,
      [m.org_id, m.user_id],
    )
    const policy: PolicySet = { ...emptyPolicy(m.user_id), rules: rules.rows.map(toRule) }

    for (const action of ACTIONS) {
      const closed = action === "configure" || action === "delete"
      const before = decide(policy, action, { type: "org" }, closed ? wasAdmin(m.role) : true, {
        unconditionalOnly: true,
      })
      const after =
        m.role === "owner"
          ? true
          : decide(policy, action, { type: "org" }, !closed, { unconditionalOnly: true })
      compared++
      if (before !== after) {
        drift++
        console.error(
          `  ${m.org_id} ${m.user_id} (${m.role}) ${action}: was ${before}, now ${after}`,
        )
      }
    }
  }

  console.log(
    drift === 0
      ? `OK — ${compared} decisions identical before and after the flip`
      : `DRIFT — ${drift} of ${compared} decisions changed`,
  )
  await pool.end()
  if (drift > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
