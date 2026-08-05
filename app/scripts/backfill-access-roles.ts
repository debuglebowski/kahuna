/**
 * One-off backfill bringing existing orgs onto the access model, with ZERO change
 * in what anyone can do. Four steps, all idempotent:
 *
 *  1. Seed the preset roles per org (Owner / Admin / Member / Automation).
 *  2. Assign each BetterAuth membership its matching preset, so today's
 *     owner/admin/member behaviour is reproduced by rules rather than by
 *     `policy.ts:can()`.
 *  3. Assign every existing automation the full-access preset — automations ran as
 *     `system` before, so anything narrower would silently change behaviour.
 *  4. Stamp `items.created_by` from each lineage's first `InstanceCreated` event,
 *     which is what the `actorIs: "creator"` condition filters on.
 *
 * Deliberately raw SQL over the pool rather than the engine: it spans orgs, and
 * `AccessRoleService.ensureBuiltins` is per-OrgContext. The rule rows it writes are
 * identical to what `BUILTIN_ROLES` seeds — `backfill-access-roles.test.ts` asserts
 * the two agree, so this can't drift from the seed.
 *
 * Run: bun scripts/backfill-access-roles.ts
 */
import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

/** Every resource type a preset grants over. Must match ALL_RESOURCES in
 *  engine/services/AccessRoleService.ts. */
const RESOURCES = [
  "org",
  "concept",
  "record",
  "field",
  "dashboard",
  "view",
  "automation",
  "bucket",
  "task",
  "note",
  "member",
] as const

/** Must match BUILTIN_ROLES (asserted by server/access-backfill.test.ts).
 *
 *  `member` withholds `configure` and `delete`, which are already admin-gated at the
 *  RPC boundary today — granting them would widen. It also withholds **`view`**:
 *  read access is the default layer's job (the `visibility` column), and a blanket
 *  `view` rule would outrank it and expose every admin-only concept. */
const PRESETS = [
  {
    key: "admin",
    name: "Admin",
    description: "Full access, including org configuration.",
    position: 1,
    actions: ["*"],
  },
  {
    key: "member",
    name: "Member",
    description: "Creates and edits; cannot configure or delete. Reads what is visible.",
    position: 2,
    actions: ["create", "edit", "archive", "share"],
  },
  {
    key: "automation_full",
    name: "Full access",
    description: "What automations and syncs had before access control: everything.",
    position: 3,
    actions: ["*"],
  },
] as const

/** Category and landing zone, kept out of PRESETS so the action lists above stay
 *  literally comparable with `BUILTIN_ROLES` (see `access-backfill.test.ts`). */
const KIND: Record<string, "user" | "automation"> = { automation_full: "automation" }
const AUTO_ASSIGN = new Set(["member", "automation_full"])

const AUTOMATION_ACTOR_PREFIX = "system:automation:"

const main = async () => {
  // Orgs that have any engine data. `bauth_organization` is the authority on which
  // orgs exist, but an org with no concepts has nothing to govern yet — the seed
  // will handle it on first use.
  const orgs = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM concepts
     UNION SELECT DISTINCT organization_id AS org_id FROM bauth_member
     ORDER BY org_id`,
  )
  console.log(`${orgs.rowCount} org(s)`)

  let rolesSeeded = 0
  let assigned = 0
  let automationsAssigned = 0

  for (const { org_id } of orgs.rows) {
    const roleIdByKey = new Map<string, string>()

    for (const preset of PRESETS) {
      const existing = await pool.query<{ id: string }>(
        "SELECT id FROM access_roles WHERE org_id = $1 AND key = $2 LIMIT 1",
        [org_id, preset.key],
      )
      if (existing.rows[0]) {
        roleIdByKey.set(preset.key, existing.rows[0].id)
        continue
      }
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO access_roles
           (org_id, key, name, description, managed, kind, auto_assign, position)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7) RETURNING id`,
        [
          org_id,
          preset.key,
          preset.name,
          preset.description,
          KIND[preset.key] ?? "user",
          AUTO_ASSIGN.has(preset.key),
          preset.position,
        ],
      )
      const roleId = inserted.rows[0]!.id
      roleIdByKey.set(preset.key, roleId)
      for (const resourceType of RESOURCES) {
        await pool.query(
          `INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type)
           VALUES ($1, $2, 'allow', $3, $4)`,
          [org_id, roleId, preset.actions, resourceType],
        )
      }
      rolesSeeded++
    }

    // Step 2 — memberships. Everyone gets `member`; an `admin` membership ALSO gets
    // the Admin role. An OWNER gets neither on that account — owner is a membership
    // flag whose session resolves unrestricted, so a role would add nothing and a
    // role named "Owner" would be a second, editable source of truth for the one
    // thing no rule may touch.
    const members = await pool.query<{ user_id: string; role: string }>(
      "SELECT user_id, role FROM bauth_member WHERE organization_id = $1",
      [org_id],
    )
    for (const m of members.rows) {
      const key = m.role === "admin" ? "admin" : "member"
      const roleId = roleIdByKey.get(key)!
      const res = await pool.query(
        `INSERT INTO access_role_actors (org_id, role_id, actor_id)
         VALUES ($1, $2, $3) ON CONFLICT (role_id, actor_id) DO NOTHING`,
        [org_id, roleId, m.user_id],
      )
      assigned += res.rowCount ?? 0
    }

    // Step 3 — automations. The actor string must match `actorFor` in
    // server/automations.ts, or the runner resolves an empty policy and every run
    // starts failing.
    const automations = await pool.query<{ id: string }>(
      "SELECT id FROM automations WHERE org_id = $1",
      [org_id],
    )
    const automationRoleId = roleIdByKey.get("automation_full")!
    for (const a of automations.rows) {
      const res = await pool.query(
        `INSERT INTO access_role_actors (org_id, role_id, actor_id)
         VALUES ($1, $2, $3) ON CONFLICT (role_id, actor_id) DO NOTHING`,
        [org_id, automationRoleId, `${AUTOMATION_ACTOR_PREFIX}${a.id}`],
      )
      automationsAssigned += res.rowCount ?? 0
    }

    // Bump the policy generation so any running process picks all of this up.
    await pool.query(
      `INSERT INTO access_policy_versions (org_id, version, updated_at)
       VALUES ($1, 1, now())
       ON CONFLICT (org_id) DO UPDATE SET version = access_policy_versions.version + 1,
                                         updated_at = now()`,
      [org_id],
    )
  }

  // Step 4 — attribute lineages. The first `InstanceCreated` in a lineage is who
  // made the record; later versions don't change that. Only rows still null are
  // touched, so a re-run is a no-op and a manual correction is never clobbered.
  const attributed = await pool.query(
    `UPDATE items i SET created_by = src.actor
     FROM (
       SELECT DISTINCT ON (inst.item_id) inst.item_id, e.actor
       FROM events e
       JOIN instances inst ON inst.id = e.subject_id AND inst.org_id = e.org_id
       WHERE e.event_type = 'InstanceCreated' AND e.actor IS NOT NULL
       ORDER BY inst.item_id, e.id ASC
     ) src
     WHERE i.id = src.item_id AND i.created_by IS NULL`,
  )

  console.log(
    `roles seeded: ${rolesSeeded}  members assigned: ${assigned}  ` +
      `automations assigned: ${automationsAssigned}  items attributed: ${attributed.rowCount}`,
  )
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
