import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { AccessRoleService } from "../services/AccessRoleService"
import { PolicyService } from "../services/PolicyService"
import { newOrgId, testLayer } from "./harness"

/**
 * Layer 1 — one person's overrides, a role row with `personal_for` set
 * (`db/schema.ts:960`). P2 wired the precedence (`personal_for IS NOT NULL` ⇒
 * 0); P5 is the first thing that actually creates, hides and guards one.
 */
describe("personal roles (Layer 1)", () => {
  const ACTOR = "user-personal"

  it.effect("getPersonalRole is null until ensurePersonalRole creates one", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      expect(yield* roles.getPersonalRole(ACTOR)).toBeNull()
      const created = yield* roles.ensurePersonalRole(ACTOR)
      expect(created.name).toBe("Personal overrides")
      expect(created.kind).toBe("user")
      expect(created.managed).toBe(false)
      expect(yield* roles.getPersonalRole(ACTOR)).toEqual(created)
    }).pipe(Effect.provide(testLayer(org)))
  })

  it.effect("ensurePersonalRole is idempotent — the same row, not a duplicate", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const first = yield* roles.ensurePersonalRole(ACTOR)
      const second = yield* roles.ensurePersonalRole(ACTOR)
      expect(second).toEqual(first)
      const held = yield* roles.rolesOf(ACTOR)
      // Excluded from rolesOf (see below) — but not double-assigned either;
      // reaching in with actorsOf proves there is exactly one row, not two.
      expect(yield* roles.actorsOf(first.id)).toEqual([ACTOR])
      expect(held.some((r) => r.id === first.id)).toBe(false)
    }).pipe(Effect.provide(testLayer(org)))
  })

  it.effect("is hidden from list() and rolesOf() — it has its own section, not a pill", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins
      const admin = yield* roles.getByKey("admin")
      yield* roles.assign(admin!.id, ACTOR)
      const personal = yield* roles.ensurePersonalRole(ACTOR)

      const listed = yield* roles.list()
      expect(listed.some((r) => r.id === personal.id)).toBe(false)
      expect(listed.some((r) => r.id === admin!.id)).toBe(true)

      const held = yield* roles.rolesOf(ACTOR)
      expect(held.map((r) => r.id)).toEqual([admin!.id])
    }).pipe(Effect.provide(testLayer(org)))
  })

  it.effect("assign() refuses to hand someone's personal role to anyone else", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const personal = yield* roles.ensurePersonalRole(ACTOR)
      const outcome = yield* Effect.exit(roles.assign(personal.id, "someone-else"))
      expect(Exit.isFailure(outcome)).toBe(true)
      // And nothing was written — a refused assign must not half-apply.
      expect(yield* roles.actorsOf(personal.id)).toEqual([ACTOR])
    }).pipe(Effect.provide(testLayer(org)))
  })

  it.effect("assign() re-assigning the SAME actor to their own personal role is fine", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const personal = yield* roles.ensurePersonalRole(ACTOR)
      yield* roles.unassign(personal.id, ACTOR)
      expect(yield* roles.actorsOf(personal.id)).toEqual([])
      yield* roles.assign(personal.id, ACTOR)
      expect(yield* roles.actorsOf(personal.id)).toEqual([ACTOR])
    }).pipe(Effect.provide(testLayer(org)))
  })

  it.effect("resolves at precedence 0 — above every ordinary role", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const policies = yield* PolicyService
      yield* roles.ensureBuiltins
      const admin = yield* roles.getByKey("admin")
      yield* roles.assign(admin!.id, ACTOR)
      const personal = yield* roles.ensurePersonalRole(ACTOR)
      yield* roles.addRule({
        roleId: personal.id,
        effect: "deny",
        actions: ["view"],
        resourceType: "concept",
      })

      const policy = yield* policies.resolve(org, ACTOR)
      const byRole = new Map(policy.rules.map((r) => [r.roleId, r.precedence]))
      expect(byRole.get(personal.id)).toBe(0)
      expect(byRole.get(admin!.id)).toBeGreaterThan(0)
    }).pipe(Effect.provide(testLayer(org)))
  })

  it.effect("reorderHeld sets position by index and skips ids not held", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const a = yield* roles.create({ name: "A" })
      const b = yield* roles.create({ name: "B" })
      const c = yield* roles.create({ name: "C" })
      yield* roles.assign(a.id, ACTOR)
      yield* roles.assign(b.id, ACTOR)
      yield* roles.assign(c.id, ACTOR)

      // Reverse order, plus a well-formed id the actor never held — silently
      // skipped (a malformed id, by contrast, fails at the DB layer like any
      // other roleId-taking call — not this function's concern to validate).
      yield* roles.reorderHeld(ACTOR, [c.id, randomUUID(), b.id, a.id])
      const held = yield* roles.rolesOf(ACTOR)
      expect(held.map((r) => r.id)).toEqual([c.id, b.id, a.id])
    }).pipe(Effect.provide(testLayer(org)))
  })
})
