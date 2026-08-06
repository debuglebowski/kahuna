import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { AccessRoleService } from "../services/AccessRoleService"
import { PolicyService } from "../services/PolicyService"
import { newOrgId, testLayer } from "./harness"

/**
 * ── ROLE INHERITANCE (P6) ─────────────────────────────────────────────────────
 *
 * `PolicyService.loadRules`'s recursive CTE has walked `based_on` since P2 — but
 * with no write path, every chain was empty and `scripts/verify-precedence-noop.ts`
 * could prove it a no-op. `update`'s `basedOn` is the first thing that ever sets
 * the column, so this is the first time the walk does anything at all.
 */
describe("role based-on: the write path and its guards", () => {
  const ACTOR = "user-inherit"

  it.effect("setting basedOn to a valid same-kind role succeeds and reads back", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const base = yield* roles.create({ name: "Base" })
      const child = yield* roles.create({ name: "Child" })
      expect(child.basedOn).toBeNull()

      const updated = yield* roles.update({ id: child.id, basedOn: base.id })
      expect(updated?.basedOn).toBe(base.id)
      const listed = (yield* roles.list()).find((r) => r.id === child.id)
      expect(listed?.basedOn).toBe(base.id)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("clearing basedOn (null) needs no guard and always succeeds", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const base = yield* roles.create({ name: "Base" })
      const child = yield* roles.create({ name: "Child" })
      yield* roles.update({ id: child.id, basedOn: base.id })
      const cleared = yield* roles.update({ id: child.id, basedOn: null })
      expect(cleared?.basedOn).toBeNull()
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("refuses a self-reference", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const solo = yield* roles.create({ name: "Solo" })
      const outcome = yield* Effect.exit(roles.update({ id: solo.id, basedOn: solo.id }))
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("refuses a direct 2-cycle", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const a = yield* roles.create({ name: "A" })
      const b = yield* roles.create({ name: "B" })
      yield* roles.update({ id: a.id, basedOn: b.id })
      // B based on A would close A -> B -> A.
      const outcome = yield* Effect.exit(roles.update({ id: b.id, basedOn: a.id }))
      expect(Exit.isFailure(outcome)).toBe(true)
      // And it wasn't half-applied.
      const listed = (yield* roles.list()).find((r) => r.id === b.id)
      expect(listed?.basedOn).toBeNull()
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("refuses a longer cycle, not just a direct one", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const a = yield* roles.create({ name: "A" })
      const b = yield* roles.create({ name: "B" })
      const c = yield* roles.create({ name: "C" })
      // A -> B -> C
      yield* roles.update({ id: a.id, basedOn: b.id })
      yield* roles.update({ id: b.id, basedOn: c.id })
      // C -> A would close the loop three hops later.
      const outcome = yield* Effect.exit(roles.update({ id: c.id, basedOn: a.id }))
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("refuses a kind mismatch — a people role can't be based on an automation one", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const person = yield* roles.create({ name: "Person role", kind: "user" })
      const bot = yield* roles.create({ name: "Bot role", kind: "automation" })
      const outcome = yield* Effect.exit(roles.update({ id: person.id, basedOn: bot.id }))
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("refuses a personal role as the target — Layer 1 is one person's, not reusable", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const ordinary = yield* roles.create({ name: "Ordinary" })
      const personal = yield* roles.ensurePersonalRole(ACTOR)
      const outcome = yield* Effect.exit(roles.update({ id: ordinary.id, basedOn: personal.id }))
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("refuses a nonexistent target", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const solo = yield* roles.create({ name: "Solo" })
      const outcome = yield* Effect.exit(
        roles.update({ id: solo.id, basedOn: "00000000-0000-0000-0000-000000000000" }),
      )
      expect(Exit.isFailure(outcome)).toBe(true)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect(
    "a resolved policy adds chain DEPTH to precedence — the CTE walk actually runs now",
    () => {
      const org = newOrgId()
      return Effect.gen(function* () {
        const roles = yield* AccessRoleService
        const policies = yield* PolicyService
        const base = yield* roles.create({ name: "Base" })
        const child = yield* roles.create({ name: "Child" })
        // `task` isn't a TEMPLATED type, so a blanket (untargeted) rule is allowed —
        // `concept`/`record`/etc. refuse one outright (`BlanketRuleRefused`), which
        // is orthogonal to what this test is actually checking.
        yield* roles.addRule({
          roleId: base.id,
          effect: "allow",
          actions: ["view"],
          resourceType: "task",
        })
        yield* roles.assign(child.id, ACTOR)
        yield* roles.update({ id: child.id, basedOn: base.id })

        const policy = yield* policies.resolve(org, ACTOR)
        const inherited = policy.rules.find((r) => r.roleId === base.id)
        const own = policy.rules.find((r) => r.roleId === child.id)
        // `child` holds no rules of its own, so only the inherited one appears —
        // but it must resolve ONE MORE than `child`'s own precedence would be
        // (depth 1: `access_role_actors.position` defaults to 0, so a direct hold
        // is precedence 100 — see `PolicyService.loadRules`), which is what makes
        // "the role's own value always beats what it inherits" true even for a
        // role that inherits everything.
        expect(inherited).toBeDefined()
        expect(own).toBeUndefined()
        expect(inherited?.precedence).toBe(101)
      }).pipe(Effect.provide(testLayer(org, ACTOR)))
    },
  )
})
