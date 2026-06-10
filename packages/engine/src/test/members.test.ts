import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { DashboardBody, DashboardWidget } from "../domain/types"
import { MemberService } from "../services/MemberService"
import { newOrgId, testLayer } from "./harness"

const list: DashboardWidget = {
  type: "list",
  id: "w1",
  title: null,
  layout: { x: 0, y: 0, w: 6, h: 4 },
  conceptId: "c1",
  conditions: [{ field: "f1", op: "eq", value: "alice" }],
}

describe("member pages + deactivation (MemberService)", () => {
  it.effect("getPage returns an empty canvas for a never-customised member", () =>
    Effect.gen(function* () {
      const members = yield* MemberService
      const page = yield* members.getPage("alice")
      expect(page.userId).toBe("alice")
      expect(page.body.widgets).toEqual([])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("updatePage upserts the CALLER's page; unknown widget types drop on read", () =>
    Effect.gen(function* () {
      const members = yield* MemberService
      const bogus = {
        type: "bogus",
        id: "x",
        layout: { x: 0, y: 0, w: 1, h: 1 },
      } as unknown as DashboardWidget
      const body: DashboardBody = { widgets: [list, bogus] }
      const saved = yield* members.updatePage(body)
      expect(saved.userId).toBe("alice")
      expect(saved.body.widgets.map((w) => w.id)).toEqual(["w1"])
      // Second write replaces, not duplicates (one page per member).
      const cleared = yield* members.updatePage({ widgets: [] })
      expect(cleared.body.widgets).toEqual([])
      expect((yield* members.getPage("alice")).body.widgets).toEqual([])
    }).pipe(Effect.provide(testLayer(newOrgId(), "alice"))),
  )

  it.effect("pages are org-scoped: the same user reads as empty from another org", () =>
    Effect.gen(function* () {
      const a = newOrgId()
      const b = newOrgId()
      yield* Effect.flatMap(MemberService, (m) => m.updatePage({ widgets: [list] })).pipe(
        Effect.provide(testLayer(a, "alice")),
      )
      const fromB = yield* Effect.flatMap(MemberService, (m) => m.getPage("alice")).pipe(
        Effect.provide(testLayer(b, "bob")),
      )
      expect(fromB.body.widgets).toEqual([])
    }),
  )

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

  it.effect("purgeMemberData drops the member's page and marker", () =>
    Effect.gen(function* () {
      const members = yield* MemberService
      yield* members.updatePage({ widgets: [list] })
      yield* members.deactivate("alice")
      yield* members.purgeMemberData("alice")
      expect((yield* members.getPage("alice")).body.widgets).toEqual([])
      expect(yield* members.listDeactivations()).toEqual([])
    }).pipe(Effect.provide(testLayer(newOrgId(), "alice"))),
  )
})
