import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
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
})
