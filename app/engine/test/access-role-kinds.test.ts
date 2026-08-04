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
   * A direct share carries no role, so turning a role off must not touch it.
   * Someone given one record keeps it when the role that showed them the concept
   * goes away — the same reason "No" is the ABSENCE of an allow rather than a deny.
   */
  it.effect("deactivation leaves a direct share alone", () => {
    const org = newOrgId()
    const shared = "11111111-1111-1111-1111-111111111111"
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const policies = yield* PolicyService
      const sql = yield* PgClient.PgClient
      yield* roles.ensureBuiltins

      const member = yield* roles.getByKey("member")
      yield* roles.assign(member!.id, PERSON)
      // A share: the same row shape with `actor_id` instead of `role_id`. Written
      // directly because that is the distinction under test.
      yield* sql`
        INSERT INTO access_rules (org_id, actor_id, effect, actions, resource_type, resource_id)
        VALUES (${org}, ${PERSON}, 'allow', ${["view"]}, 'record', ${shared})`
      yield* policies.bump(org)

      yield* roles.update({ id: member!.id, active: false })
      const after = yield* policies.resolve(org, PERSON)
      expect(after.rules.map((r) => r.resourceId)).toEqual([shared])
    }).pipe(Effect.provide(testLayer(org, PERSON)))
  })
})
