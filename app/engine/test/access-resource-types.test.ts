import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decide } from "../domain/access"
import { AccessRoleService } from "../services/AccessRoleService"
import { PolicyService } from "../services/PolicyService"
import { newOrgId, testLayer } from "./harness"

/**
 * ── `role` AND `member` ARE REAL RESOURCE TYPES NOW ──────────────────────────
 *
 * Role/rule editing and the member roster used to be reachable only through
 * blanket org-`configure` — there was nothing narrower to grant, so "may manage
 * people" and "may manage permissions" could never be separated from each other or
 * from schema/settings administration. `server/rpc.ts`'s thirteen role/rule
 * handlers and two member handlers now decide against `{type:"role"}` /
 * `{type:"member"}` instead of `{type:"org"}`.
 *
 * The property worth pinning is SEPARABILITY: holding `configure` on one of these
 * three must not imply holding it on either of the others. A test that only checked
 * "the new type grants something" would pass even if `org` secretly still covered
 * everything (the exact bug this phase exists to fix).
 */
describe("role, member and org are three separately grantable configure targets", () => {
  const ACTOR = "user-resource-types"

  it.effect("configure on `role` does not imply configure on `member` or `org`", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const policies = yield* PolicyService

      const ops = yield* roles.create({ name: "Ops — permissions only" })
      yield* roles.assign(ops.id, ACTOR)
      yield* roles.addRule({
        roleId: ops.id,
        effect: "allow",
        actions: ["configure"],
        resourceType: "role",
      })

      const policy = yield* policies.resolve(org, ACTOR)
      const has = (type: "role" | "member" | "org") =>
        decide(policy, "configure", { type }, false, { unconditionalOnly: true })

      expect(has("role")).toBe(true)
      expect(has("member")).toBe(false)
      expect(has("org")).toBe(false)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("configure on `member` does not imply configure on `role` or `org`", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const policies = yield* PolicyService

      const people = yield* roles.create({ name: "People ops — roster only" })
      yield* roles.assign(people.id, ACTOR)
      yield* roles.addRule({
        roleId: people.id,
        effect: "allow",
        actions: ["configure"],
        resourceType: "member",
      })

      const policy = yield* policies.resolve(org, ACTOR)
      const has = (type: "role" | "member" | "org") =>
        decide(policy, "configure", { type }, false, { unconditionalOnly: true })

      expect(has("member")).toBe(true)
      expect(has("role")).toBe(false)
      expect(has("org")).toBe(false)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  /**
   * THE MIGRATION'S PROMISE. Every role that held `allow *` on `org` before this
   * phase must hold the same on `role` and `member` afterward — `db/migrations/
   * 0013_role_and_member_resources.sql` backfills existing orgs; `ensureBuiltins`
   * (via `ALL_RESOURCES`) covers every org seeded from here on. If either drops
   * `role`/`member` from its wildcard, Admin silently loses the Roles page and the
   * ability to add or remove members the next time an org is provisioned.
   */
  it.effect("a role holding `*` on org holds `*` on role and member too", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const policies = yield* PolicyService
      yield* roles.ensureBuiltins
      const admin = yield* roles.getByKey("admin")
      yield* roles.assign(admin!.id, ACTOR)

      const policy = yield* policies.resolve(org, ACTOR)
      const has = (type: "role" | "member" | "org") =>
        decide(policy, "configure", { type }, false, { unconditionalOnly: true })

      expect(has("org")).toBe(true)
      expect(has("role")).toBe(true)
      expect(has("member")).toBe(true)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })
})
