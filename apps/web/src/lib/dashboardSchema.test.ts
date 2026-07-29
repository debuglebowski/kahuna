import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DashboardBody, DashboardWidget } from "../../rpc/contract"
import {
  bucketIdsIn,
  bucketsIn,
  migrate,
  type NormWidget,
  newWidget,
  retypeWidget,
} from "./dashboards"

// Proves the RECURSIVE contract schema (the actual codec the RPC layer runs on
// save/read) round-trips a nested group tree — the highest-risk piece, since a
// recursive Effect schema can silently mis-encode nesting.
describe("DashboardBody schema codec (recursive tree)", () => {
  const tree = {
    direction: "row" as const,
    children: [
      {
        id: "w1",
        type: "note" as const,
        title: null,
        w: { unit: "fr" as const, value: 1 },
        h: { unit: "tiles" as const, value: 10 },
      },
      {
        id: "g1",
        type: "group" as const,
        direction: "col" as const,
        w: { unit: "fr" as const, value: 2 },
        h: { unit: "fr" as const, value: 1 },
        children: [
          {
            id: "w2",
            type: "metric" as const,
            title: null,
            conceptId: "c1",
            conditions: [],
            agg: "count" as const,
            w: { unit: "fr" as const, value: 1 },
            h: { unit: "fr" as const, value: 1 },
          },
          {
            id: "g2",
            type: "group" as const,
            direction: "row" as const,
            w: { unit: "fr" as const, value: 1 },
            h: { unit: "fr" as const, value: 1 },
            children: [
              {
                id: "w3",
                type: "note" as const,
                title: null,
                w: { unit: "pct" as const, value: 50, min: 4, max: 20 },
                h: { unit: "fr" as const, value: 1 },
              },
            ],
          },
        ],
      },
    ],
  }

  it("decodes then re-encodes a 3-level tree losslessly", () => {
    const decoded = Schema.decodeUnknownSync(DashboardBody)(tree)
    const encoded = Schema.encodeSync(DashboardBody)(decoded)
    expect(encoded).toEqual(tree)
  })

  // Analytics is the one widget whose config is a provider query (not a
  // conceptId), including the nested record-filter struct.
  it("round-trips an analytics widget with a record filter losslessly", () => {
    const body = {
      direction: "col" as const,
      children: [
        {
          id: "a1",
          type: "analytics" as const,
          title: null,
          provider: "posthog" as const,
          metric: "active_users" as const,
          interval: "week" as const,
          since: "30d" as const,
          event: "$pageview",
          breakdown: "plan",
          chart: "area" as const,
          showDelta: true,
          recordFilter: { fieldId: "f1", property: "email" },
          w: { unit: "fr" as const, value: 1 },
          h: { unit: "fr" as const, value: 1 },
        },
      ],
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    expect(Schema.encodeSync(DashboardBody)(decoded)).toEqual(body)
  })

  // The custom-query escape hatch: raw provider SQL persisted in the body, with
  // the structured knobs it subsumes left absent.
  it("round-trips a custom-query analytics widget losslessly", () => {
    const body = {
      direction: "col" as const,
      children: [
        {
          id: "a2",
          type: "analytics" as const,
          title: "Browsers",
          provider: "posthog" as const,
          metric: "custom" as const,
          query:
            "SELECT toStartOfDay(timestamp) AS bucket, count() AS value\nFROM events\nWHERE timestamp >= {from} AND timestamp < {to}\nGROUP BY bucket",
          interval: "day" as const,
          since: "7d" as const,
          chart: "table" as const,
          w: { unit: "fr" as const, value: 1 },
          h: { unit: "fr" as const, value: 1 },
        },
      ],
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    expect(Schema.encodeSync(DashboardBody)(decoded)).toEqual(body)
  })

  it("round-trips a tabs group (display/label/active/tabBar) losslessly", () => {
    const body = {
      direction: "col" as const,
      children: [
        {
          id: "t1",
          type: "group" as const,
          direction: "col" as const,
          display: "tabs" as const,
          label: "Views",
          active: "p2",
          tabBar: "left" as const,
          w: { unit: "fr" as const, value: 1 },
          h: { unit: "fr" as const, value: 1 },
          children: [
            {
              id: "p1",
              type: "group" as const,
              direction: "col" as const,
              label: "One",
              children: [],
            },
            {
              id: "p2",
              type: "group" as const,
              direction: "col" as const,
              label: "Two",
              children: [],
            },
          ],
        },
      ],
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    expect(Schema.encodeSync(DashboardBody)(decoded)).toEqual(body)
  })

  it("decodes a group with no display flag (back-compat — absent = flow)", () => {
    const body = {
      direction: "col",
      children: [{ id: "g", type: "group", direction: "row", children: [] }],
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    const grp = decoded.children?.[0] as { display?: unknown }
    expect(grp.display).toBeUndefined()
  })

  it("still decodes a legacy flat body (back-compat read)", () => {
    const legacy = {
      widgets: [{ id: "a", type: "note", title: null, layout: { x: 0, y: 0, w: 6, h: 4 } }],
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(legacy)
    expect(decoded.widgets?.[0]?.id).toBe("a")
    expect(decoded.children).toBeUndefined()
  })

  it("rejects a malformed node (bad unit) — the codec actually validates", () => {
    const bad = {
      direction: "row",
      children: [{ id: "x", type: "note", title: null, w: { unit: "bogus", value: 1 } }],
    }
    expect(() => Schema.decodeUnknownSync(DashboardBody)(bad)).toThrow()
  })
})

// Guards the contract↔engine hand-sync: every widget type must (a) be in the
// contract union and (b) be constructible by `newWidget` with a body the codec
// accepts. Adding a type to one place but not the other fails here. The engine
// `DashboardWidget` union is kept in lock-step by its own typecheck (rows.ts /
// use-cases.ts consume it), so the contract count standing in for both is sound.
describe("DashboardWidget union completeness (hand-sync guard)", () => {
  // The full set of widget types. Adding a type means adding it here AND to the
  // contract union, the engine union, `newWidget`, and the variant catalog.
  const ALL_WIDGET_TYPES = [
    "metric",
    "list",
    "breakdown",
    "attention",
    "trend",
    "activity",
    "analytics",
    "tasks",
    "members",
    "welcome",
    "goal",
    "shortcuts",
    "note",
    "kanban",
    "calendar",
    "gantt",
    "files",
    "document",
    "record-details",
    "record-connections",
    "record-graph",
    "record-labels",
    "record-versions",
    "record-notes",
    "record-tasks",
    "record-activity",
  ] as const

  it("the contract union has exactly one member per known widget type", () => {
    const members = (DashboardWidget as unknown as { members: ReadonlyArray<unknown> }).members
    expect(members).toHaveLength(ALL_WIDGET_TYPES.length)
  })

  it("every type builds a widget the contract body codec accepts (and round-trips)", () => {
    const body = {
      direction: "col" as const,
      children: ALL_WIDGET_TYPES.map((t) => newWidget(t)),
    }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    expect(decoded.children).toHaveLength(ALL_WIDGET_TYPES.length)
    // Re-encode must not throw and must keep every node.
    const encoded = Schema.encodeSync(DashboardBody)(decoded)
    expect(encoded.children).toHaveLength(ALL_WIDGET_TYPES.length)
    // Each widget's discriminant survives the round-trip.
    const types = new Set((encoded.children ?? []).map((c) => (c as { type: string }).type))
    for (const t of ALL_WIDGET_TYPES) expect(types.has(t)).toBe(true)
  })
})

// The Files widget's own file store: a `widget`-scope widget carries a `bucketId`
// that must survive the codec and every body-level operation, since losing it
// strands the uploads (nothing else records the bucket).
describe("Files widget bucket (widget scope)", () => {
  const filesWidget = (over: Record<string, unknown> = {}) => ({
    ...newWidget("files"),
    scope: "widget" as const,
    bucketId: "b1",
    ...over,
  })

  it("round-trips widget scope with its bucket", () => {
    const body = { direction: "col" as const, children: [filesWidget({ bucketShared: false })] }
    const decoded = Schema.decodeUnknownSync(DashboardBody)(body)
    const w = decoded.children?.[0] as { scope: string; bucketId: string; bucketShared: boolean }
    expect(w.scope).toBe("widget")
    expect(w.bucketId).toBe("b1")
    expect(w.bucketShared).toBe(false)
    const encoded = Schema.encodeSync(DashboardBody)(decoded)
    expect(encoded.children?.[0]).toMatchObject({ scope: "widget", bucketId: "b1" })
  })

  it("finds buckets anywhere in the tree, ignoring other scopes", () => {
    const body = migrate({
      direction: "col",
      children: [
        filesWidget({ id: "f1", bucketId: "b1" }),
        // A bucket nested in a group is still at stake on delete…
        {
          id: "g1",
          type: "group",
          direction: "row",
          children: [filesWidget({ id: "f2", bucketId: "b2" })],
        },
        // …while these hold no files of their own.
        filesWidget({ id: "f3", scope: "org", bucketId: null }),
        newWidget("note"),
      ],
    } as never)
    expect(bucketIdsIn(body.children).sort()).toEqual(["b1", "b2"])
  })

  // The delete prompt's wording turns on this: keeping a shared bucket's files
  // leaves them listable org-wide, keeping a private one's leaves them orphaned.
  it("reports each bucket's sharing (absent flag = shared)", () => {
    const nodes = migrate({
      direction: "col",
      children: [
        filesWidget({ id: "f1", bucketId: "b1" }),
        filesWidget({ id: "f2", bucketId: "b2", bucketShared: false }),
      ],
    } as never).children
    expect([...bucketsIn(nodes)].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "b1", shared: true },
      { id: "b2", shared: false },
    ])
  })

  // The editor must prompt before this happens (withBucketPrompt) — retyping
  // drops the bucket, and nothing else records it.
  it("retyping away loses the bucket (why the editor asks first)", () => {
    const asNote = retypeWidget(filesWidget({ bucketShared: false }) as NormWidget, "note")
    expect(bucketIdsIn([asNote])).toEqual([])
    expect(bucketIdsIn([retypeWidget(asNote, "files")])).toEqual([])
  })
})
