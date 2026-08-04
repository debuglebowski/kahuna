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
      const owner = yield* roles.getByKey("owner")
      const member = yield* roles.getByKey("member")
      yield* roles.assign(owner!.id, ACTOR)

      // The presets disagree on `full_access`, so a dropped column cannot pass by
      // coincidentally matching the default.
      expect(owner!.fullAccess).toBe(true)
      expect(member!.fullAccess).toBe(false)

      const listed = (yield* roles.list()).find((r) => r.id === owner!.id)
      const held = yield* roles.rolesOf(ACTOR)
      expect(held.map((r) => r.id)).toEqual([owner!.id])
      expect(held[0]).toEqual(listed)
      expect(held[0]).toEqual(owner)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })
})
