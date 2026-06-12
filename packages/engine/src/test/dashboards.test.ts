import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { DashboardBody, DashboardWidget } from "../domain/types"
import { DashboardService } from "../services/DashboardService"
import { newOrgId, testLayer } from "./harness"

const metric: DashboardWidget = {
  type: "metric",
  id: "w1",
  title: null,
  layout: { x: 0, y: 0, w: 3, h: 2 },
  conceptId: "c1",
  conditions: [],
  agg: "count",
}

describe("dashboards (DashboardService)", () => {
  it.effect("list seeds a single org-shared Home dashboard; idempotent", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const first = yield* dash.list()
      expect(first.length).toBe(1)
      const home = first[0]!
      expect(home.ownerId).toBeNull()
      expect(home.name).toBe("Home")
      expect(home.body.widgets).toEqual([])
      // Calling again never double-seeds.
      const second = yield* dash.list()
      expect(second.length).toBe(1)
      expect(second[0]!.id).toBe(home.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("update merges the body; unknown widget types are dropped on read", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const bogus = {
        type: "bogus",
        id: "x",
        layout: { x: 0, y: 0, w: 1, h: 1 },
      } as unknown as DashboardWidget
      const body: DashboardBody = { widgets: [metric, bogus] }
      const updated = yield* dash.update({ id: home.id, body })
      // toDashboardBody filters the unrecognised widget, keeps the metric.
      expect(updated.body.widgets.map((w) => w.id)).toEqual(["w1"])

      const missing = yield* dash.update({ id: newOrgId(), body }).pipe(Effect.flip)
      expect(missing._tag).toBe("DashboardNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("org-global widget types (tasks/members/welcome) round-trip intact", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const widgets: DashboardWidget[] = [
        {
          type: "tasks",
          id: "t1",
          title: null,
          layout: { x: 0, y: 0, w: 6, h: 5 },
          assignee: "me",
          showComposer: false,
        },
        {
          type: "members",
          id: "m1",
          title: null,
          layout: { x: 6, y: 0, w: 4, h: 5 },
          showToolbar: false,
        },
        { type: "welcome", id: "g1", title: null, layout: { x: 0, y: 5, w: 6, h: 2 } },
      ]
      const updated = yield* dash.update({ id: home.id, body: { widgets } })
      // KNOWN_WIDGETS must recognise the new types or toDashboardBody drops them.
      expect(updated.body.widgets).toEqual(widgets)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("owner scoping: a member never sees another member's personal dashboard", () =>
    Effect.gen(function* () {
      const org = newOrgId()
      const mine = yield* Effect.gen(function* () {
        const dash = yield* DashboardService
        return yield* dash.create({ name: "Mine", scope: "personal", body: { widgets: [] } })
      }).pipe(Effect.provide(testLayer(org, "alice")))

      // Bob, same org, sees the shared Home but not Alice's personal one.
      const bobList = yield* Effect.flatMap(DashboardService, (d) => d.list()).pipe(
        Effect.provide(testLayer(org, "bob")),
      )
      expect(bobList.some((d) => d.id === mine.id)).toBe(false)
      expect(bobList.every((d) => d.ownerId === null)).toBe(true)
    }),
  )

  it.effect("delete: the last shared dashboard is protected; a personal one deletes", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const protectedErr = yield* dash.remove(home.id).pipe(Effect.flip)
      expect(protectedErr._tag).toBe("DashboardProtected")

      const personal = yield* dash.create({ name: "P", scope: "personal", body: { widgets: [] } })
      const removed = yield* dash.remove(personal.id)
      expect(removed.id).toBe(personal.id)
      expect((yield* dash.list()).some((d) => d.id === personal.id)).toBe(false)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("reorder sets positions in the caller's visible list", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const a = yield* dash.create({ name: "A", scope: "org", body: { widgets: [] } })
      const reordered = yield* dash.reorder([
        { id: a.id, position: 0 },
        { id: home.id, position: 1 },
      ])
      expect(reordered.map((d) => d.id)).toEqual([a.id, home.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("optimistic concurrency: a stale expectedUpdatedAt conflicts", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const stale = new Date(home.updatedAt.getTime() - 1000)
      const conflict = yield* dash
        .update({ id: home.id, name: "X", expectedUpdatedAt: stale })
        .pipe(Effect.flip)
      expect(conflict._tag).toBe("DashboardConflict")
      // The current etag goes through; an absent etag also bypasses the check.
      const ok = yield* dash.update({
        id: home.id,
        name: "Renamed",
        expectedUpdatedAt: home.updatedAt,
      })
      expect(ok.name).toBe("Renamed")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
