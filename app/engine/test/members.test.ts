import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AccessRoleService } from "../services/AccessRoleService"
import { MemberService } from "../services/MemberService"
import { newOrgId, testLayer } from "./harness"

describe("member deactivation + prefs (MemberService)", () => {
  it.effect("deactivate marks idempotently; reactivate clears", () =>
    Effect.gen(function* () {
      const members = yield* MemberService
      const first = yield* members.deactivate("bob")
      expect(first.userId).toBe("bob")
      // Re-deactivating keeps the original timestamp (no conflict error).
      const again = yield* members.deactivate("bob")
      expect(again.deactivatedAt.getTime()).toBe(first.deactivatedAt.getTime())
      expect((yield* members.listDeactivations()).map((d) => d.userId)).toEqual(["bob"])

      yield* members.reactivate("bob")
      expect(yield* members.listDeactivations()).toEqual([])
      // Reactivating a non-deactivated user is a no-op.
      yield* members.reactivate("bob")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purgeMemberData drops the member's prefs and marker", () =>
    Effect.gen(function* () {
      const members = yield* MemberService
      yield* members.updateViewPrefs({
        defaultView: "focus",
        byConcept: {},
        customByConcept: {},
      })
      yield* members.deactivate("alice")
      yield* members.purgeMemberData("alice")
      expect((yield* members.getViewPrefs()).body.defaultView).toBeNull()
      expect(yield* members.listDeactivations()).toEqual([])
    }).pipe(Effect.provide(testLayer(newOrgId(), "alice"))),
  )

  // A purged-then-re-added person must not silently inherit their old personal
  // overrides — the same hazard `access_role_actors` cleanup exists to prevent
  // for ordinary roles, one row over.
  it.effect("purgeMemberData drops the member's personal role too", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const members = yield* MemberService
      const personal = yield* roles.ensurePersonalRole("carol")
      yield* roles.addRule({
        roleId: personal.id,
        effect: "deny",
        actions: ["view"],
        resourceType: "concept",
      })

      yield* members.purgeMemberData("carol")

      expect(yield* roles.getPersonalRole("carol")).toBeNull()
      // Cascaded, not orphaned: the rule and the assignment go with the role.
      expect(yield* roles.rulesOf(personal.id)).toEqual([])
      expect(yield* roles.actorsOf(personal.id)).toEqual([])
    }).pipe(Effect.provide(testLayer(newOrgId(), "carol"))),
  )
})
