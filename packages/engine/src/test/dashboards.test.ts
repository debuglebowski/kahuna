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
      expect((updated.body.widgets ?? []).map((w) => w.id)).toEqual(["w1"])

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

  it.effect("appended widget types (goal … files) round-trip intact", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const layout = { x: 0, y: 0, w: 4, h: 3 }
      const widgets: DashboardWidget[] = [
        {
          type: "goal",
          id: "g1",
          title: null,
          layout,
          conceptId: "c1",
          conditions: [],
          agg: "count",
          target: 100,
          direction: "reach",
        },
        {
          type: "shortcuts",
          id: "s1",
          title: null,
          layout,
          items: [{ id: "i1", kind: "url", ref: "https://example.com", label: "Docs" }],
        },
        {
          type: "note",
          id: "n1",
          title: null,
          layout,
          content: { doc: { type: "doc", content: [] }, text: "hello" },
          appearance: "info",
        },
        { type: "kanban", id: "k1", title: null, layout, conditions: [], groupBy: "f1" },
        {
          type: "calendar",
          id: "cal1",
          title: null,
          layout,
          mode: "month",
          sources: [{ conceptId: "c1", dateField: "f2" }],
        },
        {
          type: "gantt",
          id: "ga1",
          title: null,
          layout,
          conditions: [],
          scale: "week",
          startField: "f3",
        },
        { type: "files", id: "fi1", title: null, layout, scope: "org" },
      ]
      const updated = yield* dash.update({ id: home.id, body: { widgets } })
      expect(updated.body.widgets).toEqual(widgets)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("auto-layout TREE body persists + reads back intact (nested groups)", () =>
    Effect.gen(function* () {
      const dash = yield* DashboardService
      const home = (yield* dash.list())[0]!
      const tree: DashboardBody = {
        direction: "row",
        children: [
          {
            id: "w1",
            type: "note",
            title: null,
            w: { unit: "fr", value: 1 },
            h: { unit: "tiles", value: 10 },
            content: { doc: { type: "doc", content: [] }, text: "" },
          },
          {
            id: "g1",
            type: "group",
            direction: "col",
            w: { unit: "fr", value: 2 },
            h: { unit: "fr", value: 1 },
            children: [
              {
                id: "w2",
                type: "metric",
                title: null,
                conceptId: "c1",
                conditions: [],
                agg: "count",
                w: { unit: "pct", value: 50, min: 4, max: 20 },
                h: { unit: "fr", value: 1 },
              },
            ],
          },
        ],
      }
      const updated = yield* dash.update({ id: home.id, body: tree })
      // The tree document survives storage + the defensive read coercion.
      expect(updated.body.direction).toBe("row")
      expect(updated.body.children).toEqual(tree.children)
      expect(updated.body.widgets).toBeUndefined()
      // A fresh read sees the same tree (not just the write echo).
      const reread = (yield* dash.list()).find((d) => d.id === home.id)!
      expect(reread.body.children).toEqual(tree.children)
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
