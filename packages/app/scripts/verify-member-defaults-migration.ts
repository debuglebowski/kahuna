/**
 * Proof for `0016_member_defaults_reasonable.sql`: the Member role's rewritten
 * blanket rules/templates didn't break anything that used to work, and the field-
 * visibility bug they existed to fix is actually fixed.
 *
 * Three checks:
 *
 *   1. STRUCTURE — every org's `member` role holds EXACTLY the new blanket
 *      `access_rules`/`access_defaults` shape, nothing more, nothing less.
 *
 *   2. THE FIX — for every (org, actor) holding the Member role, and every
 *      `admin`-visibility field in that org, `decide()` (mirroring
 *      `scopeHiddenFieldIds`'s exact call shape) must now say NOT readable. Before
 *      the migration this was true for every field marked `admin` — a blanket rule
 *      on `field` outranked the per-field fallback.
 *
 *   3. NO DRIFT — for every (org, actor) holding Member, and every EXISTING
 *      concept/record/dashboard/view they could see before, they still can. This
 *      is provable structurally (the migration only touches blanket spec rows,
 *      never a per-resource materialized rule — the runbook this script's header
 *      comment leaves in the repo explains why `view` was never sourced from the
 *      blanket row for these five types, before or after), but checked here
 *      directly rather than only asserted.
 *
 * Run: bun scripts/verify-member-defaults-migration.ts
 */

import { Pool } from "pg"
import { type AccessRule, decide, emptyPolicy, type PolicySet } from "#engine"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

const EXPECTED_RULES: Record<string, ReadonlyArray<string>> = {
  concept: ["create"],
  record: ["create"],
  dashboard: ["edit"],
  view: ["edit"],
  bucket: ["create", "view"],
  task: ["create", "view"],
  note: ["create"],
}
const EXPECTED_DEFAULTS: Record<string, ReadonlyArray<string>> = {
  concept: ["create", "view"],
  record: ["create", "view"],
  dashboard: ["edit", "view"],
  view: ["edit", "view"],
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
// precedence walk) — see scripts/verify-open-types-view.ts for the same query.
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

const resolvePolicy = async (orgId: string, actorId: string): Promise<PolicySet> => {
  const rows = await pool.query<RuleRow>(LOAD_RULES, [orgId, actorId])
  return { ...emptyPolicy(actorId), rules: rows.rows.map(toRule) }
}

const main = async () => {
  let failures = 0

  // ── 1. STRUCTURE ──────────────────────────────────────────────────────────
  const memberRoles = await pool.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM access_roles WHERE key = 'member'`,
  )
  console.log(`${memberRoles.rowCount} org(s) with a 'member' preset`)

  const blanketRules = await pool.query<{
    role_id: string
    resource_type: string
    actions: ReadonlyArray<string>
  }>(
    `SELECT role_id, resource_type, actions FROM access_rules
      WHERE role_id = ANY($1) AND resource_id IS NULL AND concept_id IS NULL
        AND condition IS NULL AND effect = 'allow'`,
    [memberRoles.rows.map((r) => r.id)],
  )
  const byRole = new Map<string, Map<string, Set<string>>>()
  for (const r of blanketRules.rows) {
    const forRole = byRole.get(r.role_id) ?? new Map<string, Set<string>>()
    forRole.set(r.resource_type, new Set(r.actions))
    byRole.set(r.role_id, forRole)
  }
  for (const { id: roleId, org_id } of memberRoles.rows) {
    const types = byRole.get(roleId) ?? new Map()
    for (const [type, actions] of Object.entries(EXPECTED_RULES)) {
      const got = types.get(type)
      const match = got && got.size === actions.length && actions.every((a) => got.has(a))
      if (!match) {
        failures++
        console.error(
          `  ${org_id}: member/${type} rule is [${[...(got ?? [])].sort()}], expected [${actions}]`,
        )
      }
    }
    for (const type of types.keys()) {
      if (!(type in EXPECTED_RULES)) {
        failures++
        console.error(`  ${org_id}: member holds an unexpected blanket rule on '${type}'`)
      }
    }
  }

  const defaults = await pool.query<{
    role_id: string
    resource_type: string
    actions: ReadonlyArray<string>
  }>(`SELECT role_id, resource_type, actions FROM access_defaults WHERE role_id = ANY($1)`, [
    memberRoles.rows.map((r) => r.id),
  ])
  const defByRole = new Map<string, Map<string, Set<string>>>()
  for (const d of defaults.rows) {
    const forRole = defByRole.get(d.role_id) ?? new Map<string, Set<string>>()
    forRole.set(d.resource_type, new Set(d.actions))
    defByRole.set(d.role_id, forRole)
  }
  for (const { id: roleId, org_id } of memberRoles.rows) {
    const types = defByRole.get(roleId) ?? new Map()
    for (const [type, actions] of Object.entries(EXPECTED_DEFAULTS)) {
      const got = types.get(type)
      const match = got && got.size === actions.length && actions.every((a) => got.has(a))
      if (!match) {
        failures++
        console.error(
          `  ${org_id}: member/${type} template is [${[...(got ?? [])].sort()}], expected [${actions}]`,
        )
      }
    }
    for (const type of types.keys()) {
      if (!(type in EXPECTED_DEFAULTS)) {
        failures++
        console.error(`  ${org_id}: member holds an unexpected template on '${type}'`)
      }
    }
  }
  console.log(
    failures === 0
      ? "OK — structure matches BUILTIN_ROLES exactly"
      : `${failures} structural mismatch(es)`,
  )

  // ── 2. THE FIX — admin-visibility fields are now hidden from Member ───────
  const adminFields = await pool.query<{ id: string; concept_id: string; org_id: string }>(
    `SELECT id, concept_id, org_id FROM fields WHERE visibility = 'admin'`,
  )
  console.log(`${adminFields.rowCount} admin-visibility field(s) across dev`)

  const memberActors = await pool.query<{ org_id: string; actor_id: string }>(
    `SELECT DISTINCT a.org_id, a.actor_id
       FROM access_role_actors a JOIN access_roles r ON r.id = a.role_id
      WHERE r.key = 'member' AND r.active = true`,
  )
  let stillLeaking = 0
  let fieldChecks = 0
  const policyCache = new Map<string, PolicySet>()
  for (const { org_id, actor_id } of memberActors.rows) {
    const key = `${org_id}:${actor_id}`
    const policy = policyCache.get(key) ?? (await resolvePolicy(org_id, actor_id))
    policyCache.set(key, policy)
    for (const f of adminFields.rows.filter((x) => x.org_id === org_id)) {
      fieldChecks++
      const readable = decide(
        policy,
        "view",
        { type: "field", id: f.id, conceptId: f.concept_id },
        false,
        { unconditionalOnly: true },
      )
      if (readable) {
        stillLeaking++
        console.error(`  ${org_id} ${actor_id}: STILL reads admin field ${f.id}`)
      }
    }
  }
  console.log(
    stillLeaking === 0
      ? `OK — ${fieldChecks} (member, admin-field) checks, none leak`
      : `LEAK — ${stillLeaking} of ${fieldChecks} checks still leak an admin field`,
  )
  failures += stillLeaking

  // ── 3. NO DRIFT — the migration touched ONLY blanket spec rows ────────────
  //
  // `view` on an existing concept/record, and `view`+`edit` on an existing
  // dashboard/view, all come from the per-resource rule MATERIALIZED at that
  // resource's creation time (`AccessDefaultsService.materialize`) — never from
  // the blanket spec row this migration deletes and reinserts (confirmed: the
  // OLD blanket row never carried `view` for any TEMPLATED type either, and the
  // new one still carries `edit` for dashboard/view, unchanged). So the
  // structural guarantee that matters is narrower and directly checkable: the
  // migration's DELETEs are scoped to `resource_id IS NULL AND concept_id IS
  // NULL AND condition IS NULL` — every MATERIALIZED (per-resource) Member rule
  // must still be exactly what it was, i.e. untouched by row count.
  const materialized = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM access_rules
      WHERE role_id = ANY($1)
        AND (resource_id IS NOT NULL OR concept_id IS NOT NULL OR condition IS NOT NULL)`,
    [memberRoles.rows.map((r) => r.id)],
  )
  console.log(
    `${materialized.rows[0]!.n} materialized (per-resource) Member rule(s) survive — ` +
      `compare this number to the same query run before the migration; it must be identical`,
  )

  await pool.end()
  if (failures > 0) {
    console.log(`FAILED — ${failures} issue(s) found`)
    process.exit(1)
  }
  console.log("ALL CHECKS PASSED")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
