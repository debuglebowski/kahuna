import { describe, expect, it } from "vitest"
import type { DashboardBody } from "./api"
import {
  findNode,
  formatMetric,
  formatWidgetNumber,
  insertNode,
  isGroup,
  isWide,
  migrate,
  moveNode,
  type NormBody,
  type NormGroup,
  type NormNode,
  type NormWidget,
  newGroup,
  newWidget,
  nodeStyle,
  parentOf,
  referencedConceptIds,
  removeNode,
  reorderNode,
  serialize,
  sizeVariant,
  subtreeIds,
  unwrapGroup,
  updateNode,
} from "./dashboards"

const TILE = { x: 10, y: 8 }

/** A note widget with the given id and optional size. */
const w = (id: string, size?: Partial<Pick<NormWidget, "w" | "h">>): NormWidget =>
  ({
    id,
    type: "note",
    title: null,
    w: { unit: "fr", value: 1 },
    h: { unit: "fr", value: 1 },
    ...size,
  }) as NormWidget

const grp = (id: string, direction: "row" | "col", children: NormNode[]): NormGroup => ({
  id,
  type: "group",
  direction,
  w: { unit: "fr", value: 1 },
  h: { unit: "fr", value: 1 },
  children,
})

describe("migrate", () => {
  it("dumps a legacy flat widget list into a col root, dropping layout", () => {
    const legacy: DashboardBody = {
      widgets: [
        { id: "a", type: "note", title: null, layout: { x: 0, y: 0, w: 6, h: 4 } },
      ] as DashboardBody["widgets"],
    }
    const out = migrate(legacy)
    expect(out.direction).toBe("col")
    expect(out.children).toHaveLength(1)
    const node = out.children[0] as NormWidget
    expect(node.id).toBe("a")
    expect(node.w).toEqual({ unit: "fr", value: 1 })
    expect(node.h).toEqual({ unit: "fr", value: 1 })
    expect("layout" in node).toBe(false)
  })

  it("passes a tree body through, filling missing sizes", () => {
    const body: DashboardBody = {
      direction: "row",
      children: [
        { id: "g", type: "group", direction: "col", children: [] },
        { id: "n", type: "note", title: null },
      ],
    }
    const out = migrate(body)
    expect(out.direction).toBe("row")
    expect(out.children[0]).toMatchObject({ id: "g", type: "group", w: { unit: "fr", value: 1 } })
    expect(out.children[1]).toMatchObject({ id: "n", w: { unit: "fr", value: 1 } })
  })

  it("treats an empty body as an empty col root", () => {
    expect(migrate({})).toEqual({ direction: "col", children: [] })
  })

  it("round-trips through serialize", () => {
    const body: NormBody = { direction: "row", children: [w("a"), grp("g", "col", [w("b")])] }
    expect(migrate(serialize(body))).toEqual(body)
  })
})

describe("tree operations", () => {
  const body: NormBody = {
    direction: "col",
    children: [w("a"), grp("g", "row", [w("b"), w("c")])],
  }

  it("finds nodes at any depth", () => {
    expect(findNode(body, "a")?.id).toBe("a")
    expect(findNode(body, "c")?.id).toBe("c")
    expect(findNode(body, "nope")).toBeNull()
  })

  it("reports a node's parent group (null = root)", () => {
    expect(parentOf(body, "a")).toBeNull()
    expect(parentOf(body, "b")).toBe("g")
    expect(parentOf(body, "missing")).toBeUndefined()
  })

  it("inserts into the root or a named group", () => {
    const r1 = insertNode(body, null, w("z"))
    expect(r1.children.map((n) => n.id)).toEqual(["a", "g", "z"])
    const r2 = insertNode(body, "g", w("z"))
    expect((findNode(r2, "g") as NormGroup).children.map((n) => n.id)).toEqual(["b", "c", "z"])
  })

  it("removes a node anywhere", () => {
    expect((findNode(removeNode(body, "b"), "g") as NormGroup).children.map((n) => n.id)).toEqual([
      "c",
    ])
    expect(removeNode(body, "g").children.map((n) => n.id)).toEqual(["a"])
  })

  it("updates a node by id", () => {
    const out = updateNode(body, "b", (n) => ({ ...n, title: "hi" }))
    expect((findNode(out, "b") as NormWidget).title).toBe("hi")
  })

  it("reorders within siblings, clamped at the ends", () => {
    expect(reorderNode(body, "b", 1)) // b after c
    expect(
      (findNode(reorderNode(body, "b", 1), "g") as NormGroup).children.map((n) => n.id),
    ).toEqual(["c", "b"])
    // already first → no-op
    expect(
      (findNode(reorderNode(body, "b", -1), "g") as NormGroup).children.map((n) => n.id),
    ).toEqual(["b", "c"])
  })
})

describe("moveNode + unwrapGroup (restructuring)", () => {
  // root: [ a, g1[ b, g2[ c ] ] ]
  const body = (): NormBody => ({
    direction: "col",
    children: [w("a"), grp("g1", "row", [w("b"), grp("g2", "col", [w("c")])])],
  })

  it("moves a node into another group", () => {
    const out = moveNode(body(), "a", "g2")
    expect(parentOf(out, "a")).toBe("g2")
    expect(out.children.map((n) => n.id)).toEqual(["g1"]) // a left the root
  })

  it("moves a node back to the root", () => {
    const out = moveNode(body(), "c", null)
    expect(parentOf(out, "c")).toBeNull()
    expect((findNode(out, "g2") as NormGroup).children).toHaveLength(0)
  })

  it("positions before a sibling when given beforeId (drag-to-position)", () => {
    // move `a` into g1, before `b`
    const out = moveNode(body(), "a", "g1", "b")
    expect((findNode(out, "g1") as NormGroup).children.map((n) => n.id)).toEqual(["a", "b", "g2"])
  })

  it("reorders within the same parent via beforeId", () => {
    // root is [a, g1]; move a before... there's no sibling after, so put g1 before a
    const out = moveNode(body(), "g1", null, "a")
    expect(out.children.map((n) => n.id)).toEqual(["g1", "a"])
  })

  it("refuses to move a group into itself or a descendant (no orphaning)", () => {
    expect(moveNode(body(), "g1", "g1")).toEqual(body()) // into self → no-op
    expect(moveNode(body(), "g1", "g2")).toEqual(body()) // into own descendant → no-op
  })

  it("is a no-op when the target is already the parent", () => {
    const b = body()
    expect(moveNode(b, "b", "g1")).toBe(b)
  })

  it("subtreeIds collects the whole subtree", () => {
    const g1 = findNode(body(), "g1") as NormGroup
    expect(subtreeIds(g1).sort()).toEqual(["b", "c", "g1", "g2"])
  })

  it("unwraps a group, promoting children into its parent at its position", () => {
    const out = unwrapGroup(body(), "g1")
    // g1 dissolved at root → its children (b, g2) take its slot after a
    expect(out.children.map((n) => n.id)).toEqual(["a", "b", "g2"])
    expect(findNode(out, "c")?.id).toBe("c") // nested child survives
  })
})

describe("nodeStyle (flex resolution)", () => {
  it("fr on the main axis grows; cross tiles set an explicit size", () => {
    // row parent → main = width
    const s = nodeStyle(
      w("a", { w: { unit: "fr", value: 2 }, h: { unit: "tiles", value: 5 } }),
      "row",
      TILE,
    )
    expect(s.flexGrow).toBe(2)
    expect(s.flexShrink).toBe(1)
    expect(s.flexBasis).toBe(0)
    expect(s.height).toBe("40px") // 5 tiles × 8px
  })

  it("fixed tiles on the main axis set a px flex-basis; cross fr stretches", () => {
    const s = nodeStyle(
      w("a", { w: { unit: "tiles", value: 6 }, h: { unit: "fr", value: 1 } }),
      "row",
      TILE,
    )
    expect(s).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: "60px", alignSelf: "stretch" })
  })

  it("pct main → percentage flex-basis", () => {
    const s = nodeStyle(w("a", { w: { unit: "pct", value: 50 } }), "row", TILE)
    expect(s.flexBasis).toBe("50%")
  })

  it("min/max (tiles) clamp the main axis", () => {
    const s = nodeStyle(w("a", { w: { unit: "fr", value: 1, min: 4, max: 10 } }), "row", TILE)
    expect(s.minWidth).toBe("40px")
    expect(s.maxWidth).toBe("100px")
  })

  it("swaps main/cross for a col parent", () => {
    // col parent → main = height
    const s = nodeStyle(
      w("a", { w: { unit: "tiles", value: 6 }, h: { unit: "fr", value: 3 } }),
      "col",
      TILE,
    )
    expect(s.flexGrow).toBe(3) // height fr grows
    expect(s.width).toBe("60px") // width tiles is the cross size
  })
})

describe("node construction", () => {
  it("new widgets fill their slot and carry type defaults", () => {
    const m = newWidget("metric")
    expect(m).toMatchObject({ type: "metric", agg: "count", w: { unit: "fr", value: 1 } })
    expect(isGroup(m)).toBe(false)
  })

  it("new groups are empty row containers that fill", () => {
    const g = newGroup("row")
    expect(g).toMatchObject({ type: "group", direction: "row", children: [] })
    expect(isGroup(g)).toBe(true)
  })

  it("never puts conceptId on org-global widgets", () => {
    for (const type of ["tasks", "members", "welcome", "shortcuts", "note", "calendar"] as const) {
      expect("conceptId" in newWidget(type)).toBe(false)
    }
  })
})

describe("referencedConceptIds", () => {
  it("walks the tree, collecting concept-scoped ids only", () => {
    const body: NormBody = {
      direction: "col",
      children: [
        grp("g", "row", [
          { ...newWidget("metric"), id: "m", conceptId: "c1" } as NormWidget,
          { ...newWidget("list"), id: "l", conceptId: "c2" } as NormWidget,
        ]),
        // tasks conceptId is a filter, not a data scope → ignored
        { ...newWidget("tasks"), id: "t", conceptId: "c9" } as NormWidget,
      ],
    }
    expect(referencedConceptIds(body).sort()).toEqual(["c1", "c2"])
  })
})

describe("display helpers", () => {
  it("formats integers with separators and decimals at 2dp", () => {
    expect(formatWidgetNumber(1234567)).toBe((1234567).toLocaleString())
  })

  it("formats the metric per the configured number format", () => {
    expect(formatMetric(0.42, "percent")).toBe(
      (0.42).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 }),
    )
    expect(formatMetric(5, "currency", "NOPE")).toBe("5 NOPE")
  })

  it("derives size variants from pixel measurements", () => {
    expect(sizeVariant(120)).toBe("sm")
    expect(sizeVariant(250)).toBe("md")
    expect(sizeVariant(400)).toBe("lg")
    expect(isWide(420)).toBe(true)
    expect(isWide(300)).toBe(false)
  })
})
