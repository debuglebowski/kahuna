/**
 * THE REPAIR PATH. Find every resource that has no explicit rules for a role, and
 * fill it in from that role's creation template.
 *
 * Exists because the failure direction of the one-layer model is inverted. Under the
 * old default a missed step made something TOO VISIBLE — loud, noticed immediately.
 * Now a missed step makes a resource INVISIBLE, and invisible to members only, while
 * the admin who created it sees it working perfectly. Nobody reports that for weeks.
 *
 * Materialization runs inside each creating transaction, so this should never find
 * anything. Run it after the fallback flip, after a restore, and on deploy — the
 * cost of running it when it is unnecessary is one query per org.
 *
 * Reports what it would do with --dry.
 *
 * Run: bun scripts/reconcile-access.ts [--dry]
 */

import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

const DRY = process.argv.includes("--dry")

/**
 * Where each templated type's resources live, and how a rule points at one.
 *
 * `record` is the odd one: its rules are scoped by CONTAINER — `concept_id` set,
 * `resource_id` null, meaning "records in this concept" — so it reads the concepts
 * table but writes the other column. Getting that backwards produces a rule about a
 * single record whose id happens to equal a concept id, which matches nothing.
 */
const SOURCES = [
  { type: "concept", table: "concepts", where: "archived_at IS NULL", byConcept: false },
  { type: "record", table: "concepts", where: "archived_at IS NULL", byConcept: true },
  // Shared only: a personal dashboard/view is governed by `owner_id` and needs no
  // role rules at all.
  { type: "dashboard", table: "dashboards", where: "owner_id IS NULL", byConcept: false },
  { type: "view", table: "sidebar_views", where: "owner_id IS NULL", byConcept: false },
  { type: "automation", table: "automations", where: "TRUE", byConcept: false },
] as const

async function main() {
  let filled = 0
  let orgs = 0
  const report: string[] = []

  const orgRows = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM access_roles ORDER BY org_id`,
  )

  for (const { org_id: orgId } of orgRows.rows) {
    orgs++
    // Full-access roles are exempt — they hold a blanket `*` and are never
    // materialized, so a missing per-resource rule is correct for them.
    const templates = await pool.query<{
      role_id: string
      resource_type: string
      actions: string[]
    }>(
      `SELECT d.role_id, d.resource_type, d.actions
         FROM access_defaults d
         JOIN access_roles r ON r.id = d.role_id
        WHERE d.org_id = $1 AND d.effect = 'allow' AND r.full_access = false`,
      [orgId],
    )
    if (templates.rowCount === 0) continue

    // Group templates by type: a resource is judged once, against ALL roles.
    const byType = new Map<string, typeof templates.rows>()
    for (const t of templates.rows) {
      const list = byType.get(t.resource_type) ?? []
      list.push(t)
      byType.set(t.resource_type, list)
    }

    for (const [resourceType, roleTemplates] of byType) {
      const src = SOURCES.find((s) => s.type === resourceType)
      if (!src) continue
      /**
       * UNMATERIALIZED, not merely "not allowed".
       *
       * The whole correctness of this script is in this predicate, and it is narrower
       * than it first looks. Two wrong versions, both of which I shipped:
       *
       * 1. "No rule for role R" — that is the NORMAL way of saying R may not see it,
       *    since the absence of an allow IS "no". Filling it in widens access,
       *    silently granting what someone deliberately withheld.
       *
       * 2. "No rule of THIS TYPE for any role" — flags every admin-only concept,
       *    because members correctly hold a `concept` rule for it and no `record`
       *    rule. The concept was materialized; one of its two rules was simply
       *    empty-and-therefore-absent.
       *
       * What actually indicates a skipped hook is a resource NO scoped role names AT
       * ALL, in either column, for any type. `materialize` writes every applicable
       * rule in one transaction, so a single row anywhere proves it ran.
       */
      const gaps = await pool.query<{ id: string; label: string | null }>(
        `SELECT s.id, s.name AS label
           FROM ${src.table} s
          WHERE s.org_id = $1 AND ${src.where}
            AND NOT EXISTS (
              SELECT 1 FROM access_rules r
                JOIN access_roles ro ON ro.id = r.role_id
               WHERE r.org_id = $1 AND ro.full_access = false
                 AND (r.resource_id = s.id OR r.concept_id = s.id)
            )`,
        [orgId],
      )
      for (const gap of gaps.rows) {
        report.push(`org=${orgId.slice(0, 8)} ${resourceType}=${gap.label ?? gap.id}`)
        // Never materialized, so the template IS the right answer for every role.
        for (const t of roleTemplates) {
          if (!DRY) {
            await pool.query(
              `INSERT INTO access_rules
                 (org_id, role_id, effect, actions, resource_type, resource_id, concept_id,
                  created_by)
               VALUES ($1, $2, 'allow', $3, $4, $5, $6, 'reconcile')`,
              [
                orgId,
                t.role_id,
                t.actions,
                resourceType,
                src.byConcept ? null : gap.id,
                src.byConcept ? gap.id : null,
              ],
            )
          }
        }
        filled++
      }
    }

    if (filled > 0 && !DRY) {
      await pool.query(
        `INSERT INTO access_policy_versions (org_id, version) VALUES ($1, 2)
         ON CONFLICT (org_id) DO UPDATE SET version = access_policy_versions.version + 1,
                                            updated_at = now()`,
        [orgId],
      )
    }
  }

  for (const line of report.slice(0, 40)) console.log(`  ${DRY ? "would fill" : "filled"} ${line}`)
  if (report.length > 40) console.log(`  … and ${report.length - 40} more`)
  console.log(`${DRY ? "[dry] " : ""}orgs=${orgs} gaps=${filled}`)
  await pool.end()
  // Non-zero on a gap so this can gate a deploy: finding one means a create path
  // skipped materialization, which is a bug, not routine drift.
  if (filled > 0 && DRY) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  await pool.end()
  process.exit(1)
})
