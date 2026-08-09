import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AccessRoleService } from "../services/AccessRoleService"
import { newOrgId, testLayer } from "./harness"

/**
 * ── EVERY ROLE READ RETURNS A WHOLE ROLE ─────────────────────────────────────
 *
 * `sql<AccessRoleRow>` is an ASSERTION, not a check: a SELECT that forgets a
 * column still typechecks, and `toRole` happily maps the missing one to
 * `undefined`. The RPC contract declares `fullAccess: Schema.Boolean`, so the
 * hole surfaces only in the browser, as a decode failure on the page that asked
 * — which is exactly how `rolesOf` shipped without `full_access` and broke
 * /settings/profile.
 *
 * Hence: assert the shape on every read path that returns a role, not just one.
 */
describe("role reads", () => {
  const ACTOR = "user-roles"

  it.effect("rolesOf returns the same whole role that list and getByKey do", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService

      yield* roles.ensureBuiltins
      const admin = yield* roles.getByKey("admin")
      const member = yield* roles.getByKey("member")
      yield* roles.assign(admin!.id, ACTOR)

      // The managed roles disagree on how MUCH they grant, so a seed that silently
      // stopped writing rules cannot pass by coincidence. `full_access` used to be
      // the discriminator; it is gone, because Admin is now just a role holding more
      // rules than Member rather than a role with a special flag.
      const adminRules = yield* roles.rulesOf(admin!.id)
      const memberRules = yield* roles.rulesOf(member!.id)
      expect(adminRules.length).toBeGreaterThan(memberRules.length)
      expect(adminRules.flatMap((r) => r.actions)).not.toContain("*")

      const listed = (yield* roles.list()).find((r) => r.id === admin!.id)
      const held = yield* roles.rolesOf(ACTOR)
      expect(held.map((r) => r.id)).toEqual([admin!.id])
      expect(held[0]).toEqual(listed)
      expect(held[0]).toEqual(admin)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })
})
