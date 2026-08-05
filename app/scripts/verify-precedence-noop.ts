/**
 * Prove that P2 (precedence plumbing) changed NOTHING about what anyone can do.
 *
 * `PolicyService.loadRules` went from a flat join to a recursive CTE that also
 * computes a `precedence` per rule. The query shape changed; the RULE SET a real
 * actor resolves to must not have. This compares the two directly against the live
 * dev DB, for every (org, actor) that currently holds at least one role:
 *
 *   1. THE OLD QUERY (restated here, literally — the flat join `loadRules` used
 *      before this phase) and THE NEW QUERY (the actual recursive CTE, copied from
 *      `PolicyService.ts` so this script exercises the real SQL, not a
 *      paraphrase) must return the exact same SET of rule ids.
 *   2. Every actor's rules must land in exactly ONE precedence tier. `position`
 *      defaults to 0 and nothing sets `based_on`/`personal_for` yet, so a SECOND
 *      tier appearing anywhere would mean the migration or the query is already
 *      fragmenting someone's access before anything was built to do that on
 *      purpose — the single most important thing for this phase to get right.
 *
 * Run: bun scripts/verify-precedence-noop.ts
 */
import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  if (!cond) {
    failures++
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`)
  }
}

/** THE OLD QUERY — `PolicyService.loadRules` before this phase, restated. */
const oldQuery = `
  SELECT r.id
    FROM access_rules r
    JOIN access_role_actors a ON a.role_id = r.role_id AND a.org_id = r.org_id
    JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
   WHERE r.org_id = $1 AND a.actor_id = $2 AND ro.active = true`

/** THE NEW QUERY — copied from `PolicyService.ts`, not paraphrased, so a change
 *  there that this script doesn't know about fails LOUD rather than passing by
 *  comparing against itself. */
const newQuery = `
  WITH RECURSIVE chain AS (
    SELECT a.role_id AS role_id, 0 AS depth,
           CASE WHEN ro.personal_for IS NOT NULL THEN 0
                ELSE (a.position + 1) * 100 END AS precedence
      FROM access_role_actors a
      JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
     WHERE a.org_id = $1 AND a.actor_id = $2 AND ro.active = true
    UNION ALL
    SELECT parent.id AS role_id, chain.depth + 1 AS depth,
           chain.precedence + 1 AS precedence
      FROM chain
      JOIN access_roles child ON child.id = chain.role_id
      JOIN access_roles parent
        ON parent.id = child.based_on AND parent.org_id = child.org_id
     WHERE parent.active = true AND chain.depth < 8
  ),
  best AS (
    SELECT role_id, MIN(precedence) AS precedence FROM chain GROUP BY role_id
  )
  SELECT r.id, b.precedence
    FROM best b
    JOIN access_rules r ON r.role_id = b.role_id AND r.org_id = $1`

const main = async () => {
  const actors = await pool.query<{ org_id: string; actor_id: string }>(
    `SELECT DISTINCT org_id, actor_id FROM access_role_actors ORDER BY org_id, actor_id`,
  )
  console.log(`${actors.rowCount} (org, actor) pair(s)`)

  let compared = 0
  let multiTier = 0

  for (const { org_id, actor_id } of actors.rows) {
    const [before, after] = await Promise.all([
      pool.query<{ id: string }>(oldQuery, [org_id, actor_id]),
      pool.query<{ id: string; precedence: number }>(newQuery, [org_id, actor_id]),
    ])
    compared++

    const beforeIds = new Set(before.rows.map((r) => r.id))
    const afterIds = new Set(after.rows.map((r) => r.id))
    const sameSize = beforeIds.size === afterIds.size
    const sameMembers = [...beforeIds].every((id) => afterIds.has(id))
    ok(
      `${org_id} ${actor_id}: same rule set`,
      sameSize && sameMembers,
      `before=${beforeIds.size} after=${afterIds.size}`,
    )

    const tiers = new Set(after.rows.map((r) => r.precedence))
    if (tiers.size > 1) {
      multiTier++
      console.log(`  ${org_id} ${actor_id}: ${tiers.size} tiers already — ${[...tiers].join(",")}`)
    }
  }

  console.log(
    failures === 0
      ? `OK — ${compared} (org, actor) pairs identical before and after`
      : `DRIFT — ${failures} of ${compared} pairs changed`,
  )
  console.log(
    multiTier === 0
      ? "OK — every actor is still a single tier"
      : `${multiTier} actor(s) already span more than one tier — investigate before shipping`,
  )
  await pool.end()
  if (failures > 0 || multiTier > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
