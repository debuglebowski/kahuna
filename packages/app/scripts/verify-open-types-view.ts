/**
 * Prove the P8 migration (`0015_open_types_view_backfill.sql`) left nobody who could
 * create/edit/archive/share on org/field/bucket/task/note/member unable to VIEW it —
 * the exact regression closing the implicit "no rule = allowed" fallback would cause
 * if the backfill missed anyone.
 *
 * For every (org, actor) holding at least one active role, resolve their policy the
 * same way `PolicyService.loadRules` does (the full based_on/personal_for precedence
 * walk, not the flatter query older verify scripts used — P6 made that walk real) and
 * check, for each of the six types: if `decide()` grants `create` unconditionally, does
 * it also grant `view`? A mismatch means someone can make something they can no longer
 * see, which is the specific shape of "silently empty the app" this phase warned about.
 *
 * Run: bun scripts/verify-open-types-view.ts
 */

import { Pool } from "pg"
import {
  type AccessResourceType,
  type AccessRule,
  decide,
  emptyPolicy,
  type PolicySet,
} from "#engine"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

// `field` and `bucket` were removed from `AccessResourceType` entirely in a later
// migration (0018) — neither can be checked here any more, so this now covers
// four of the original six types.
const TYPES: ReadonlyArray<AccessResourceType> = ["org", "task", "note", "member"]

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
  readonly precedence: number
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
    precedence: r.precedence,
  }) as AccessRule

// Mirrors PolicyService.loadRules exactly (the recursive based_on/personal_for
// precedence walk) — see that file for the long-form explanation of each branch.
const LOAD_RULES = `
  WITH RECURSIVE chain AS (
    SELECT a.role_id AS role_id, 0 AS depth,
           CASE WHEN ro.personal_for IS NOT NULL THEN 0
                ELSE (a.position + 1) * 100 END AS precedence
      FROM access_role_actors a
      JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
     WHERE a.org_id = $1 AND a.actor_id = $2 AND ro.active = true
    UNION ALL
    SELECT parent.id AS role_id, chain.depth + 1 AS depth, chain.precedence + 1 AS precedence
      FROM chain
      JOIN access_roles child ON child.id = chain.role_id
      JOIN access_roles parent ON parent.id = child.based_on AND parent.org_id = child.org_id
     WHERE parent.active = true AND chain.depth < 8
  ),
  best AS (SELECT role_id, MIN(precedence) AS precedence FROM chain GROUP BY role_id)
  SELECT r.id, r.role_id, r.actor_id, r.effect, r.actions,
         r.resource_type, r.resource_id, r.concept_id, r.condition, b.precedence
    FROM best b JOIN access_rules r ON r.role_id = b.role_id AND r.org_id = $1`

const main = async () => {
  const actors = await pool.query<{ org_id: string; actor_id: string }>(
    `SELECT DISTINCT a.org_id, a.actor_id
       FROM access_role_actors a
       JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
      WHERE ro.active = true
      ORDER BY a.org_id, a.actor_id`,
  )
  console.log(`${actors.rowCount} (org, actor) pair(s) holding at least one active role`)

  let checked = 0
  let gaps = 0

  for (const { org_id, actor_id } of actors.rows) {
    const rows = await pool.query<RuleRow>(LOAD_RULES, [org_id, actor_id])
    const policy: PolicySet = { ...emptyPolicy(actor_id), rules: rows.rows.map(toRule) }

    for (const type of TYPES) {
      const resource = { type }
      const canCreate = decide(policy, "create", resource, false, { unconditionalOnly: true })
      const canView = decide(policy, "view", resource, false, { unconditionalOnly: true })
      checked++
      if (canCreate && !canView) {
        gaps++
        console.error(
          `  ${org_id} ${actor_id}: can create on '${type}' but CANNOT view it — the backfill missed this actor's role`,
        )
      }
    }
  }

  console.log(
    gaps === 0
      ? `OK — ${checked} (actor, type) checks, no create-without-view gaps`
      : `GAPS FOUND — ${gaps} of ${checked} checks failed`,
  )
  await pool.end()
  if (gaps > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
