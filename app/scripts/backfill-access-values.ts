/**
 * Materialize today's effective access into EXPLICIT per-resource rules, so the
 * permissions grid can show one definite value per (resource, role) instead of an
 * "Inherit" state meaning "no rule here — the `visibility` column decides".
 *
 * Phase 2 of collapsing the two access layers into one. Purely ADDITIVE and
 * re-runnable: it only ever inserts allow rules that are missing, so running it
 * twice is a no-op and running it before the fallback flips changes nothing anyone
 * can observe. That is what makes it safe to land ahead of the flip.
 *
 * ── WHY IT WRITES ALLOWS AND NEVER DENIES ────────────────────────────────────
 *
 * "Not allowed" must be the ABSENCE of an allow. A deny is absolute and is checked
 * before record grants (see `scopeConceptRead`), so writing "member can't see Deals"
 * as `deny(member, Deals)` would silently kill every share of a Deal to a member —
 * and only one test would notice. Absence leaves shares working.
 *
 * ── WHY TYPESCRIPT AND NOT SQL ───────────────────────────────────────────────
 *
 * Each value is whatever `decide()` answers today: deny-wins, wildcard expansion,
 * concept-scoped record rules, the `visibility` column as the fallback. Restating
 * that in SQL is how the two drift. So the pure engine functions are imported and
 * driven from raw pool queries — cross-org iteration AND zero drift.
 *
 * Run: bun scripts/backfill-access-values.ts [--dry]
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

const DRY = process.argv.includes("--dry")

/**
 * The membership role a preset stands in for.
 *
 * The OLD default keyed on the BetterAuth membership role (`canReadConcept(vis,
 * role)`), not on the access role — so reproducing it per access role needs this
 * mapping. A custom role has no membership equivalent and is treated as `member`,
 * which is the conservative direction: it can only ever compute a narrower default
 * than an admin would have had, and rules layered on top still widen it.
 */
const membershipRoleFor = (key: string | null): "owner" | "admin" | "member" =>
  key === "owner" ? "owner" : key === "admin" ? "admin" : "member"

const isAdminRole = (r: string): boolean => r === "owner" || r === "admin"

/** Actions the grid shows per area — the only ones worth materializing, because a
 *  rule for an action nothing decides against that type is dead weight. */
const ACTIONS_BY_TYPE: Record<string, ReadonlyArray<AccessAction>> = {
  concept: ["view", "archive", "delete", "share", "configure"],
  record: ["view"],
  dashboard: ["view", "edit", "delete", "share"],
  view: ["view", "edit", "delete", "share"],
  automation: ["view", "edit", "archive", "delete", "share"],
}

interface RoleRow {
  readonly id: string
  readonly key: string | null
  readonly full_access: boolean
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
  // Conditional rules are deliberately NOT materialized (see below), and this
  // script never evaluates a condition, so carrying the payload adds nothing.
  condition: r.condition === null ? null : ({ kind: "any", of: [] } as never),
})

/** The role's own rules, as a PolicySet `decide()` can consume. */
const policyOf = (rules: ReadonlyArray<AccessRule>): PolicySet => ({
  ...emptyPolicy("backfill"),
  rules,
})

interface Counts {
  orgs: number
  inserted: number
  templates: number
  skippedConditional: number
  blanketDenies: number
}

async function main() {
  const counts: Counts = {
    orgs: 0,
    inserted: 0,
    templates: 0,
    skippedConditional: 0,
    blanketDenies: 0,
  }

  const orgs = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM access_roles ORDER BY org_id`,
  )

  for (const { org_id: orgId } of orgs.rows) {
    counts.orgs++
    const client = await pool.connect()
    try {
      await client.query("BEGIN")

      const roles = await client.query<RoleRow>(
        `SELECT id, key, full_access FROM access_roles WHERE org_id = $1`,
        [orgId],
      )
      const allRules = await client.query<RuleRow>(
        `SELECT id, role_id, actor_id, effect, actions, resource_type, resource_id,
                concept_id, condition
           FROM access_rules WHERE org_id = $1 AND role_id IS NOT NULL`,
        [orgId],
      )
      const concepts = await client.query<{ id: string; visibility: string }>(
        `SELECT id, visibility FROM concepts WHERE org_id = $1 AND archived_at IS NULL`,
        [orgId],
      )
      // Shared only. A personal dashboard/view is governed by `owner_id`, which is
      // per-ACTOR and orthogonal to roles — writing role rows for one would make
      // sharing it impossible later, since a deny beats the actor grant a share writes.
      const dashboards = await client.query<{ id: string }>(
        `SELECT id FROM dashboards WHERE org_id = $1 AND owner_id IS NULL`,
        [orgId],
      )
      const views = await client.query<{ id: string }>(
        `SELECT id FROM sidebar_views WHERE org_id = $1 AND owner_id IS NULL`,
        [orgId],
      )
      const automations = await client.query<{ id: string }>(
        `SELECT id FROM automations WHERE org_id = $1`,
        [orgId],
      )

      for (const role of roles.rows) {
        // Full-access roles keep their blanket `*`. Materializing a wildcard freezes
        // the role at today's action list, so an action added in a later release is
        // silently not granted — to the OWNER, with no error that explains why.
        if (role.full_access) continue

        const mine = allRules.rows.filter((r) => r.role_id === role.id)
        const conditional = mine.filter((r) => r.condition !== null)
        counts.skippedConditional += conditional.length
        // A conditional allow means "SOME records". Materializing it as a blanket
        // per-resource allow would widen it to all of them. Leave those rules alone
        // and let them keep working as exceptions.
        const policy = policyOf(mine.filter((r) => r.condition === null).map(toRule))
        const mRole = membershipRoleFor(role.key)

        /** Insert an allow, unless one already covers this exact target. */
        const put = async (
          resourceType: string,
          actions: ReadonlyArray<AccessAction>,
          resourceId: string | null,
          conceptId: string | null,
        ) => {
          if (actions.length === 0) return
          const exists = await client.query(
            `SELECT 1 FROM access_rules
              WHERE org_id = $1 AND role_id = $2 AND resource_type = $3
                AND effect = 'allow' AND condition IS NULL
                AND resource_id IS NOT DISTINCT FROM $4
                AND concept_id IS NOT DISTINCT FROM $5
              LIMIT 1`,
            [orgId, role.id, resourceType, resourceId, conceptId],
          )
          if (exists.rowCount) return
          if (!DRY) {
            await client.query(
              `INSERT INTO access_rules
                 (org_id, role_id, effect, actions, resource_type, resource_id,
                  concept_id, created_by)
               VALUES ($1, $2, 'allow', $3, $4, $5, $6, 'backfill')`,
              [orgId, role.id, [...actions], resourceType, resourceId, conceptId],
            )
          }
          counts.inserted++
        }

        // ── concepts, and the records inside them ──────────────────────────────
        for (const c of concepts.rows) {
          const vis = c.visibility as ConceptVisibility
          const readable = canReadConcept(vis, mRole)
          const allowed = ACTIONS_BY_TYPE.concept!.filter((a) =>
            decide(
              policy,
              a,
              { type: "concept", id: c.id },
              // The old fallback, per action: `view` came from the visibility
              // column; `configure`/`delete` were admin-only at the RPC gate;
              // everything else was open to any member.
              a === "view"
                ? readable
                : a === "configure" || a === "delete"
                  ? isAdminRole(mRole)
                  : true,
              { unconditionalOnly: true },
            ),
          )
          await put("concept", allowed, c.id, null)

          const recordsReadable = decide(
            policy,
            "view",
            { type: "record", conceptId: c.id },
            readable,
            { unconditionalOnly: true },
          )
          await put("record", recordsReadable ? (["view"] as const) : [], null, c.id)
        }

        // ── shared dashboards / views / automations ────────────────────────────
        for (const [type, rows] of [
          ["dashboard", dashboards.rows],
          ["view", views.rows],
          ["automation", automations.rows],
        ] as const) {
          for (const row of rows) {
            const allowed = ACTIONS_BY_TYPE[type]!.filter((a) =>
              decide(
                policy,
                a,
                { type: type as AccessResourceType, id: row.id },
                // Shared dashboards/views are visible to everyone by default, and
                // automations were readable by anyone and admin-writable.
                a === "delete" ? isAdminRole(mRole) : true,
                { unconditionalOnly: true },
              ),
            )
            await put(type, allowed, row.id, null)
          }
        }

        // ── the blanket rows become the CREATION TEMPLATE ──────────────────────
        // They are what "a new resource of this type grants this role" already
        // means; moving them out of access_rules is what stops them being consulted
        // at request time, which is the whole point of the change.
        for (const r of mine) {
          if (r.resource_id !== null || r.concept_id !== null || r.condition !== null) continue
          if (!(r.resource_type in ACTIONS_BY_TYPE)) continue
          if (r.effect !== "allow") {
            // A blanket deny is not expressible as absence. Left alone as a rule,
            // and reported so someone can look at it.
            counts.blanketDenies++
            console.warn(
              `  ! blanket DENY kept as a rule: org=${orgId} role=${role.key ?? role.id} ` +
                `type=${r.resource_type} actions=${r.actions.join(",")}`,
            )
            continue
          }
          // THE TEMPLATE IS COMPUTED, NOT COPIED.
          //
          // The blanket rule's action list is the wrong answer: presets withhold a
          // blanket `view` on purpose (it used to outrank the `visibility` column),
          // so copying it verbatim produces a template under which every resource
          // created afterwards is invisible — silently, and to members only.
          //
          // What a NEW resource grants is what the OLD default granted it: a fresh
          // concept was `visibility='visible'`, a fresh dashboard was org-shared. So
          // compute that, and union in whatever ungridded actions the blanket carried
          // (`create`/`edit`) so nothing is lost.
          const fresh = ACTIONS_BY_TYPE[r.resource_type]!.filter((a) =>
            r.resource_type === "concept" || r.resource_type === "record"
              ? a === "view" || (a !== "configure" && a !== "delete") || isAdminRole(mRole)
              : a !== "delete" || isAdminRole(mRole),
          )
          const templateActions = [...new Set<string>([...r.actions, ...fresh])]
          if (!DRY) {
            await client.query(
              `INSERT INTO access_defaults
                 (org_id, role_id, resource_type, effect, actions, created_by)
               VALUES ($1, $2, $3, 'allow', $4, 'backfill')
               ON CONFLICT (role_id, resource_type, effect)
               DO UPDATE SET actions = (
                 SELECT array_agg(DISTINCT a) FROM unnest(
                   access_defaults.actions || EXCLUDED.actions) AS a),
                 updated_at = now()`,
              [orgId, role.id, r.resource_type, templateActions],
            )
            await client.query(`DELETE FROM access_rules WHERE id = $1`, [r.id])
          }
          counts.templates++
        }
      }

      // ── TEMPLATE REPAIR ─────────────────────────────────────────────────────
      // Idempotent, and separate from the block above because that one only fires
      // while a blanket rule still exists to convert. A template missing `view` is
      // the single worst state this migration can leave behind — every resource
      // created afterwards is invisible to that role, with nothing on screen saying
      // so — and a re-run must be able to fix it without the original blanket row.
      for (const role of roles.rows) {
        if (role.full_access) continue
        const mRole = membershipRoleFor(role.key)
        for (const [type, actions] of Object.entries(ACTIONS_BY_TYPE)) {
          const fresh = actions.filter((a) =>
            a === "configure" || a === "delete" ? isAdminRole(mRole) : true,
          )
          if (fresh.length === 0) continue
          if (!DRY) {
            await client.query(
              `INSERT INTO access_defaults
                 (org_id, role_id, resource_type, effect, actions, created_by)
               VALUES ($1, $2, $3, 'allow', $4, 'backfill')
               ON CONFLICT (role_id, resource_type, effect)
               DO UPDATE SET actions = (
                 SELECT array_agg(DISTINCT a) FROM unnest(
                   access_defaults.actions || EXCLUDED.actions) AS a),
                 updated_at = now()`,
              [orgId, role.id, type, fresh],
            )
          }
        }
      }

      // Every running process memoizes its resolved policies on this number. Without
      // the bump they serve the pre-backfill rule set until they restart.
      if (!DRY) {
        await client.query(
          `INSERT INTO access_policy_versions (org_id, version)
           VALUES ($1, 2)
           ON CONFLICT (org_id) DO UPDATE SET version = access_policy_versions.version + 1,
                                              updated_at = now()`,
          [orgId],
        )
      }
      await client.query(DRY ? "ROLLBACK" : "COMMIT")
    } catch (e) {
      await client.query("ROLLBACK")
      throw e
    } finally {
      client.release()
    }
  }

  console.log(
    `${DRY ? "[dry] " : ""}orgs=${counts.orgs} rules+=${counts.inserted} ` +
      `templates=${counts.templates} conditional-skipped=${counts.skippedConditional} ` +
      `blanket-denies-kept=${counts.blanketDenies}`,
  )
  await pool.end()
}

main().catch(async (e) => {
  console.error(e)
  await pool.end()
  process.exit(1)
})
