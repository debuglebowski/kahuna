import { describe, expect, it } from "vitest"
import { buildUsageForest } from "./dashboardGrouping"
import { migrate, referencedDashboardIds } from "./dashboards"

describe("referencedDashboardIds", () => {
  it("collects recordDashboardId from list/kanban widgets, nested in groups", () => {
    const body = migrate({
      direction: "col",
      children: [
        { id: "w1", type: "list", title: null, conditions: [], recordDashboardId: "rd1" },
        {
          id: "g",
          type: "group",
          direction: "row",
          children: [
            {
              id: "w2",
              type: "kanban",
              title: null,
              conditions: [],
              groupBy: "s",
              recordDashboardId: "rd2",
            },
            { id: "w3", type: "metric", title: null, conditions: [], agg: "count" },
          ],
        },
      ],
    } as object)
    expect(referencedDashboardIds(body).sort()).toEqual(["rd1", "rd2"])
  })

  it("returns [] when no widget pins a record dashboard", () => {
    const body = migrate({
      direction: "col",
      children: [{ id: "w1", type: "list", title: null, conditions: [] }],
    } as object)
    expect(referencedDashboardIds(body)).toEqual([])
  })

  it("resolves the concept's default view when a list opens rows with the default", () => {
    // "Open rows with: Default record view" → recordDashboardId unset, conceptId set.
    const body = migrate({
      direction: "col",
      children: [{ id: "w1", type: "list", title: null, conditions: [], conceptId: "cA" }],
    } as object)
    const defaults = new Map([["cA", "viewA"]])
    expect(referencedDashboardIds(body, defaults)).toEqual(["viewA"])
    // Without the map (or no default for the concept) there's no edge.
    expect(referencedDashboardIds(body)).toEqual([])
    expect(referencedDashboardIds(body, new Map())).toEqual([])
  })
})

describe("buildUsageForest", () => {
  it("nests a referenced dashboard beneath its referencer", () => {
    const forest = buildUsageForest([
      { id: "companies", refs: ["company"] },
      { id: "company", refs: [] },
    ])
    expect(forest).toHaveLength(1)
    expect(forest[0]!.id).toBe("companies")
    expect(forest[0]!.children.map((c) => c.id)).toEqual(["company"])
  })

  it("shows a multi-parent dashboard under each parent (duplication)", () => {
    const forest = buildUsageForest([
      { id: "a", refs: ["shared"] },
      { id: "b", refs: ["shared"] },
      { id: "shared", refs: [] },
    ])
    expect(forest.map((n) => n.id)).toEqual(["a", "b"])
    expect(forest[0]!.children[0]!.id).toBe("shared")
    expect(forest[1]!.children[0]!.id).toBe("shared")
  })

  it("puts unreferenced dashboards at the root, referenced ones only nested", () => {
    const forest = buildUsageForest([
      { id: "page", refs: ["rec"] },
      { id: "rec", refs: [] },
      { id: "lonely", refs: [] },
    ])
    expect(forest.map((n) => n.id).sort()).toEqual(["lonely", "page"])
  })

  it("drops dangling + self refs", () => {
    const forest = buildUsageForest([
      { id: "a", refs: ["a", "ghost", "b"] },
      { id: "b", refs: [] },
    ])
    expect(forest.map((n) => n.id)).toEqual(["a"]) // b is referenced → only nested
    expect(forest[0]!.children.map((c) => c.id)).toEqual(["b"])
  })

  it("never hides a cycle-only node (no root) and breaks the loop", () => {
    // a↔b mutual cycle: both are referenced, so neither is a root. The node must
    // still surface (as its own root) with the back-edge cut.
    const forest = buildUsageForest([
      { id: "a", refs: ["b"] },
      { id: "b", refs: ["a"] },
    ])
    expect(forest.map((n) => n.id)).toEqual(["a"])
    const b = forest[0]!.children[0]!
    expect(b.id).toBe("b")
    expect(b.children).toHaveLength(0) // back-edge b→a cut by the cycle guard
  })
})
