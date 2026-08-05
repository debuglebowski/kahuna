/**
 * THE PROOF. For every (org, role, resource, action), compare what access decides
 * TODAY — the `visibility` column as `decide()`'s fallback — against what it will
 * decide once the fallback is fail-closed and only explicit rules remain. Any
 * difference is printed and the script exits non-zero.
 *
 * This exists because the failure direction of the whole change is INVERTED. Every
 * bug in the old model leaks (too visible — someone notices immediately). Every bug
 * in the new one HIDES, and hides from members only, while admins see everything
 * working perfectly. Nobody files that bug for weeks. So the flip does not land
 * until this reports zero drift.
 *
 * Read-only: opens no transaction and writes nothing.
 *
 * Run: bun scripts/verify-access-values.ts
 */

import { Pool } from "pg"
import {
  type ACTION_ALL,
  type AccessAction,
  type AccessResourceType,
  type AccessRule,
  type ConceptVisibility,
  canReadConcept,
  decide,
  emptyPolicy,
  type PolicySet,
} from "#engine"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

const membershipRoleFor = (key: string | null): "owner" | "admin" | "member" =>
  key === "owner" ? "owner" : key === "admin" ? "admin" : "member"

const isAdminRole = (r: string): boolean => r === "owner" || r === "admin"

const ACTIONS_BY_TYPE: Record<string, ReadonlyArray<AccessAction>> = {
  concept: ["view", "archive", "delete", "share", "configure"],
  record: ["view"],
  dashboard: ["view", "edit", "delete", "share"],
  view: ["view", "edit", "delete", "share"],
  automation: ["view", "edit", "archive", "delete", "share"],
}

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

const toRule = (r: RuleRow): AccessRule => ({
  id: r.id,
  roleId: r.role_id,
  actorId: r.actor_id,
  effect: r.effect === "allow" ? "allow" : "deny",
  actions: r.actions as ReadonlyArray<AccessAction | typeof ACTION_ALL>,
  resourceType: r.resource_type as AccessResourceType,
  resourceId: r.resource_id,
  conceptId: r.concept_id,
  condition: r.condition === null ? null : ({ kind: "any", of: [] } as never),
})

const policyOf = (rules: ReadonlyArray<AccessRule>): PolicySet => ({
  ...emptyPolicy("verify"),
  rules,
})

async function main() {
  const drift: string[] = []
  let checked = 0

  const orgs = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM access_roles ORDER BY org_id`,
  )

  for (const { org_id: orgId } of orgs.rows) {
    const roles = await pool.query<{ id: string; key: string | null; full_access: boolean }>(
      `SELECT id, key, full_access FROM access_roles WHERE org_id = $1`,
      [orgId],
    )
    const allRules = await pool.query<RuleRow>(
      `SELECT id, role_id, actor_id, effect, actions, resource_type, resource_id,
              concept_id, condition
         FROM access_rules WHERE org_id = $1 AND role_id IS NOT NULL`,
      [orgId],
    )
    const concepts = await pool.query<{ id: string; visibility: string; name: string }>(
      `SELECT id, visibility, name FROM concepts WHERE org_id = $1 AND archived_at IS NULL`,
      [orgId],
    )
    const dashboards = await pool.query<{ id: string }>(
      `SELECT id FROM dashboards WHERE org_id = $1 AND owner_id IS NULL`,
      [orgId],
    )
    const views = await pool.query<{ id: string }>(
      `SELECT id FROM sidebar_views WHERE org_id = $1 AND owner_id IS NULL`,
      [orgId],
    )
    const automations = await pool.query<{ id: string }>(
      `SELECT id FROM automations WHERE org_id = $1`,
      [orgId],
    )

    for (const role of roles.rows) {
      // Exempt by design — it keeps its blanket `*`, so nothing about it changes.
      if (role.full_access) continue
      const mine = allRules.rows.filter((r) => r.role_id === role.id)
      const policy = policyOf(mine.filter((r) => r.condition === null).map(toRule))
      const mRole = membershipRoleFor(role.key)
      const who = `org=${orgId.slice(0, 8)} role=${role.key ?? role.id.slice(0, 8)}`

      /** OLD = the resource's own default under `decide()`. NEW = fail-closed. */
      const compare = (
        label: string,
        action: AccessAction,
        resource: { type: AccessResourceType; id?: string; conceptId?: string },
        oldFallback: boolean,
      ) => {
        checked++
        const before = decide(policy, action, resource, oldFallback, { unconditionalOnly: true })
        const after = decide(policy, action, resource, false, { unconditionalOnly: true })
        if (before !== after) {
          drift.push(
            `${who} ${label} ${action}: was ${before ? "ALLOW" : "deny"}, ` +
              `would be ${after ? "ALLOW" : "deny"}`,
          )
        }
      }

      for (const c of concepts.rows) {
        const readable = canReadConcept(c.visibility as ConceptVisibility, mRole)
        for (const a of ACTIONS_BY_TYPE.concept!) {
          compare(
            `concept:${c.name}`,
            a,
            { type: "concept", id: c.id },
            a === "view"
              ? readable
              : a === "configure" || a === "delete"
                ? isAdminRole(mRole)
                : true,
          )
        }
        compare(`records-in:${c.name}`, "view", { type: "record", conceptId: c.id }, readable)
      }

      for (const [type, rows] of [
        ["dashboard", dashboards.rows],
        ["view", views.rows],
        ["automation", automations.rows],
      ] as const) {
        for (const row of rows) {
          for (const a of ACTIONS_BY_TYPE[type]!) {
            compare(
              `${type}:${row.id.slice(0, 8)}`,
              a,
              { type: type as AccessResourceType, id: row.id },
              a === "delete" ? isAdminRole(mRole) : true,
            )
          }
        }
      }
    }
  }

  await pool.end()

  if (drift.length > 0) {
    // Capped: a systemic miss produces one line per pair, and 40 is plenty to see
    // the shape of it.
    console.error(`DRIFT in ${drift.length} of ${checked} decisions:`)
    for (const d of drift.slice(0, 40)) console.error(`  ${d}`)
    if (drift.length > 40) console.error(`  … and ${drift.length - 40} more`)
    process.exit(1)
  }
  console.log(`OK — ${checked} decisions identical before and after the flip.`)
}

main().catch(async (e) => {
  console.error(e)
  await pool.end()
  process.exit(1)
})
