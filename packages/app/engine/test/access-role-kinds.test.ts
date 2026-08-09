import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { AccessRoleService } from "../services/AccessRoleService"
import { PolicyService } from "../services/PolicyService"
import { newOrgId, testLayer } from "./harness"

/**
 * ── CATEGORY, LANDING ZONE, AND THE OFF SWITCH ───────────────────────────────
 *
 * Three properties of `access_roles` that are each one column wide and each fail
 * silently if they slip:
 *
 *  - `kind` splits people roles from automation roles. If assignment stops checking
 *    it, the split is decoration and the managed automation role — which holds a
 *    blanket `*` — becomes a privilege escalation available from a dropdown.
 *  - `auto_assign` is where a new actor lands. It replaced a hardcoded key lookup,
 *    so nothing pins it any more except these tests.
 *  - `active` is the reversible off switch a managed role has instead of delete. It
 *    is enforced in ONE place (`PolicyService.loadRules`); enforce it anywhere else
 *    and existing holders keep their access while the UI says the role is off.
 */
describe("role kinds, auto-assign and deactivation", () => {
  const PERSON = "user-kinds"
  const BOT = "system:automation:kinds"

  /**
   * THE KIND GUARD. Both directions, because only checking one of them still lets
   * the dangerous half through.
   */
  it.effect("an automation role cannot be given to a person", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins
      const bot = yield* roles.getByKey("automation_full")

      const outcome = yield* Effect.exit(roles.assign(bot!.id, PERSON))
      expect(Exit.isFailure(outcome)).toBe(true)

      // And nothing was written — a refused assign must not half-apply.
      const held = yield* roles.rolesOf(PERSON)
      expect(held.map((r) => r.key)).not.toContain("automation_full")
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })

  it.effect("a people role cannot be given to an automation", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")

      const outcome = yield* Effect.exit(roles.assign(member!.id, BOT))
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })

  it.effect("the seeded categories are what the two landing zones read", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins

      const forPeople = yield* roles.autoAssignFor("user")
      const forBots = yield* roles.autoAssignFor("automation")

      // Exactly one of each, and never the other category's.
      expect(forPeople.map((r) => r.key)).toEqual(["member"])
      expect(forBots.map((r) => r.key)).toEqual(["automation_full"])
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })

  it.effect("auto-assign is a flag, not a key — any number of roles may carry it", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins

      const extra = yield* roles.create({ name: "Everyone also gets this" })
      yield* roles.update({ id: extra.id, autoAssign: true })

      const forPeople = yield* roles.autoAssignFor("user")
      expect(forPeople.map((r) => r.id)).toContain(extra.id)
      expect(forPeople.length).toBe(2)
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })

  /**
   * THE OFF SWITCH. The assertion that matters is about the POLICY, not the row: a
   * test that only checked `active === false` would pass against an implementation
   * that greys the row out and grants everything as before.
   */
  it.effect("a deactivated role grants nothing to someone already holding it", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const policies = yield* PolicyService
      yield* roles.ensureBuiltins

      const member = yield* roles.getByKey("member")
      yield* roles.assign(member!.id, PERSON)
      const before = yield* policies.resolve(org, PERSON)
      expect(before.rules.length).toBeGreaterThan(0)

      yield* roles.update({ id: member!.id, active: false })
      const after = yield* policies.resolve(org, PERSON)
      expect(after.rules).toEqual([])

      // Reversible, and it restores exactly what was there — the assignment was
      // never dropped, which is the whole difference from deleting.
      yield* roles.update({ id: member!.id, active: true })
      const back = yield* policies.resolve(org, PERSON)
      expect(back.rules.length).toBe(before.rules.length)
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })

  it.effect("a deactivated role is not handed to new actors either", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")

      yield* roles.update({ id: member!.id, active: false })
      const forPeople = yield* roles.autoAssignFor("user")
      expect(forPeople).toEqual([])
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })

  /**
   * THE DEAD COLUMN IS GONE. Sharing was removed — every rule now comes from a role,
   * which is what makes a fixed (role position, chain depth) precedence a complete
   * ordering. `access_rules.actor_id` was kept unread through a rollback window and
   * dropped in 0022; this asserts the column itself, because a rule that cannot name
   * a person is a stronger guarantee than one the loader merely declines to read.
   */
  it.effect("access_rules cannot name a person at all — the column is gone", () =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const cols = yield* sql<{ readonly column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'access_rules'`
      expect(cols.map((c) => c.column_name)).not.toContain("actor_id")
      expect(cols.map((c) => c.column_name)).toContain("role_id")
    }).pipe(Effect.provide(testLayer(newOrgId(), PERSON))),
  )
})
