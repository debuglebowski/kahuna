/**
 * Give every existing actor the roles the auto-assign flag now says they should hold.
 *
 * Phase 2 of making roles categorised and self-serve. Where a new actor lands used to
 * be a hardcoded key lookup (`membership.ts` mapped `bauth_member.role` onto the
 * preset of the same name, `createAutomation` reached for `automation_full`); it is
 * now `access_roles.auto_assign`, settable on any number of roles. Existing actors
 * predate the flag, so nothing has ever applied it to them.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ──────────────────────────────────────
 *
 * Access is one layer and fails closed: absent a rule, nothing on a concept, record,
 * dashboard, view or automation is granted. An actor holding no role therefore sees
 * an EMPTY app, and the failure is invisible to the admin looking at their own screen.
 * P4 flips the last fallback (`configure`/`delete` on the untemplated types) the same
 * way, so this must be correct BEFORE that lands.
 *
 * ── ADDITIVE, RE-RUNNABLE, AND IT NEVER TAKES ANYTHING AWAY ──────────────────
 *
 * Only inserts, and only assignments — never a rule, never a role, never an unassign.
 * A role someone was deliberately given is not this script's business, and "should
 * everyone get this?" says nothing about what one person was granted. So running it
 * twice is a no-op and running it on a healthy database changes nothing.
 *
 * THE KIND GUARD is reproduced here rather than imported: an `automation` role goes
 * only to `system:automation:*` actors and a `user` role only to people. The engine
 * refuses a mismatch on `assign`, but this script writes raw SQL for cross-org
 * iteration, so it has to hold the line itself.
 *
 * Run: bun scripts/backfill-auto-roles.ts [--dry]
 */

import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://kingsmaker:kingsmaker@localhost:5544/kingsmaker"
const pool = new Pool({ connectionString })

const DRY = process.argv.includes("--dry")

const AUTOMATION_ACTOR_PREFIX = "system:automation:"

interface RoleRow {
  readonly id: string
  readonly key: string | null
  readonly name: string
  readonly kind: string
}

const main = async () => {
  // NOT `SELECT DISTINCT org_id FROM access_roles`. An org with NO roles is the worst
  // case this script exists to find — every actor in it resolves an empty policy —
  // and sourcing the list from the role table makes exactly that org invisible. Ask
  // the tables that say an org has actors in it instead.
  const orgs = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM access_roles
     UNION SELECT DISTINCT organization_id FROM bauth_member
     UNION SELECT DISTINCT org_id FROM automations
     ORDER BY org_id`,
  )
  console.log(`${orgs.rowCount} org(s)${DRY ? " (dry run)" : ""}`)

  let peopleAssigned = 0
  let botsAssigned = 0
  let orgsWithNoLandingZone = 0
  let unprovisioned = 0

  for (const { org_id } of orgs.rows) {
    const roles = await pool.query<RoleRow>(
      `SELECT id, key, name, kind FROM access_roles
        WHERE org_id = $1 AND auto_assign = true AND active = true`,
      [org_id],
    )
    const forPeople = roles.rows.filter((r) => r.kind !== "automation")
    const forBots = roles.rows.filter((r) => r.kind === "automation")

    // Nothing flagged is not necessarily an error — someone may have turned the
    // landing zone off on purpose — but it IS the shape of the bug this script exists
    // to prevent, so it is never silent. Report per category and only where there is
    // actually something to land: an org with no automations does not need a bot role.
    const counts = await pool.query<{ members: string; automations: string }>(
      `SELECT (SELECT count(*) FROM bauth_member WHERE organization_id = $1) AS members,
              (SELECT count(*) FROM automations WHERE org_id = $1) AS automations`,
      [org_id],
    )
    const hasMembers = Number(counts.rows[0]?.members ?? 0) > 0
    const hasAutomations = Number(counts.rows[0]?.automations ?? 0) > 0

    // An org with NO roles at all has simply never been provisioned — `ensureBuiltins`
    // seeds it lazily on first touch, and the flag comes with it. Reporting that as
    // "new members land nowhere" would bury the real finding, which is an org that HAS
    // roles and still no landing zone: that one someone has to fix by hand.
    const total = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM access_roles WHERE org_id = $1`,
      [org_id],
    )
    if (Number(total.rows[0]?.n ?? 0) === 0) {
      if (hasMembers || hasAutomations) {
        unprovisioned++
        // Only ADMIN memberships actually break here: owners hold the bypass, and
        // members get their roles when `ensureBuiltins` seeds the org on first use.
        // An admin in a role-less org loses org configuration the moment the
        // `configure` fallback closes, so it is named rather than counted.
        const admins = await pool.query<{ user_id: string }>(
          `SELECT user_id FROM bauth_member WHERE organization_id = $1 AND role = 'admin'`,
          [org_id],
        )
        for (const a of admins.rows)
          console.warn(
            `  ${org_id}: admin ${a.user_id} is in an org with NO roles — run ` +
              `scripts/backfill-access-roles.ts to seed it, then re-run this`,
          )
      }
      continue
    }

    if (forPeople.length === 0 && hasMembers) {
      orgsWithNoLandingZone++
      console.warn(`  ${org_id}: no auto-assign role for people — new members land nowhere`)
    }
    if (forBots.length === 0 && hasAutomations) {
      orgsWithNoLandingZone++
      console.warn(`  ${org_id}: no auto-assign automation role — its automations cannot run`)
    }

    // ── THE MEMBERSHIP MIRROR ────────────────────────────────────────────────
    //
    // `owner`/`admin` membership points at the managed role of the same name
    // (`membership.ts`), but that only runs on join and on a role change — a
    // membership set before the sync existed was never mirrored. Harmless while
    // `configure` fell back to the membership tier; the moment that fallback closes,
    // an unmirrored ADMIN silently loses org configuration.
    //
    // An unmirrored OWNER is fine — the owner bypass does not need a role — which is
    // exactly why this is easy to miss by looking at one's own screen.
    const mirrored = await pool.query<{ user_id: string; role: string; role_id: string }>(
      `SELECT m.user_id, m.role, ro.id AS role_id
         FROM bauth_member m
         JOIN access_roles ro ON ro.org_id = m.organization_id AND ro.key = m.role
        WHERE m.organization_id = $1 AND m.role IN ('owner', 'admin')`,
      [org_id],
    )
    for (const row of mirrored.rows) {
      if (DRY) {
        const held = await pool.query(
          `SELECT 1 FROM access_role_actors WHERE org_id = $1 AND role_id = $2 AND actor_id = $3`,
          [org_id, row.role_id, row.user_id],
        )
        if (held.rowCount === 0) peopleAssigned++
        continue
      }
      const res = await pool.query(
        `INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
         VALUES ($1, $2, $3, 'system:backfill-auto-roles')
         ON CONFLICT (role_id, actor_id) DO NOTHING`,
        [org_id, row.role_id, row.user_id],
      )
      peopleAssigned += res.rowCount ?? 0
    }

    // People. `bauth_member` is the authority on who is a member; deactivated ones
    // are included on purpose, since reactivating must not require a second pass.
    if (forPeople.length > 0) {
      const members = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM bauth_member WHERE organization_id = $1`,
        [org_id],
      )
      for (const role of forPeople) {
        for (const m of members.rows) {
          if (DRY) {
            const held = await pool.query(
              `SELECT 1 FROM access_role_actors
                WHERE org_id = $1 AND role_id = $2 AND actor_id = $3`,
              [org_id, role.id, m.user_id],
            )
            if (held.rowCount === 0) peopleAssigned++
            continue
          }
          const res = await pool.query(
            `INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
             VALUES ($1, $2, $3, 'system:backfill-auto-roles')
             ON CONFLICT (role_id, actor_id) DO NOTHING`,
            [org_id, role.id, m.user_id],
          )
          peopleAssigned += res.rowCount ?? 0
        }
      }
    }

    // Automations. Only ones that still exist — a deleted automation's actor must
    // not be resurrected, which is why this reads `automations` and not the
    // assignment table.
    if (forBots.length > 0) {
      const autos = await pool.query<{ id: string }>(
        `SELECT id FROM automations WHERE org_id = $1`,
        [org_id],
      )
      for (const role of forBots) {
        for (const a of autos.rows) {
          const actorId = `${AUTOMATION_ACTOR_PREFIX}${a.id}`
          if (DRY) {
            const held = await pool.query(
              `SELECT 1 FROM access_role_actors
                WHERE org_id = $1 AND role_id = $2 AND actor_id = $3`,
              [org_id, role.id, actorId],
            )
            if (held.rowCount === 0) botsAssigned++
            continue
          }
          const res = await pool.query(
            `INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
             VALUES ($1, $2, $3, 'system:backfill-auto-roles')
             ON CONFLICT (role_id, actor_id) DO NOTHING`,
            [org_id, role.id, actorId],
          )
          botsAssigned += res.rowCount ?? 0
        }
      }
    }

    // Assignments change what a policy resolves to, and the cache is keyed on this
    // version — without the bump a live process serves the old answer forever.
    if (!DRY && (peopleAssigned > 0 || botsAssigned > 0)) {
      await pool.query(
        `INSERT INTO access_policy_versions (org_id, version, updated_at)
         VALUES ($1, 1, now())
         ON CONFLICT (org_id)
         DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now()`,
        [org_id],
      )
    }
  }

  console.log(
    `${DRY ? "would assign" : "assigned"}: ${peopleAssigned} to people, ${botsAssigned} to automations`,
  )
  if (orgsWithNoLandingZone > 0)
    console.log(`${orgsWithNoLandingZone} org(s) HAVE roles but no landing zone — fix by hand`)
  if (unprovisioned > 0)
    console.log(`${unprovisioned} org(s) have no roles yet; ensureBuiltins seeds them on first use`)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
