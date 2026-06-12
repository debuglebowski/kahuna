import { describe, expect, it } from "vitest"
import type { DashboardBody } from "./api"
import { addWidget, newWidget, referencedConceptIds } from "./dashboards"

const empty: DashboardBody = { widgets: [] }

describe("newWidget placement", () => {
  it("places the first widget at the origin", () => {
    expect(newWidget(empty, "metric").layout).toMatchObject({ x: 0, y: 0, w: 3, h: 2 })
  })

  it("flows widgets left-to-right across the row, then wraps", () => {
    let body = empty
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 5; i++) {
      const w = newWidget(body, "metric") // 3-wide → 4 fit a 12-col row
      xs.push(w.layout.x)
      ys.push(w.layout.y)
      body = addWidget(body, w)
    }
    expect(xs).toEqual([0, 3, 6, 9, 0]) // 5th wraps to a new row
    expect(ys).toEqual([0, 0, 0, 0, 2])
  })

  it("fills a gap beside a wider widget on the same row", () => {
    const body = addWidget(empty, newWidget(empty, "list")) // 6-wide at x0
    expect(newWidget(body, "metric").layout).toMatchObject({ x: 6, y: 0 })
  })
})

describe("newWidget shapes", () => {
  it("gives the org-global widgets their default sizes", () => {
    expect(newWidget(empty, "tasks").layout).toMatchObject({ w: 6, h: 5 })
    expect(newWidget(empty, "members").layout).toMatchObject({ w: 4, h: 5 })
    expect(newWidget(empty, "welcome").layout).toMatchObject({ w: 6, h: 2 })
  })

  it("never puts conceptId on org-global widgets (spread bypasses excess checks)", () => {
    for (const type of ["tasks", "members", "welcome"] as const) {
      expect("conceptId" in newWidget(empty, type)).toBe(false)
    }
  })

  it("keeps conceptId (null) on concept-scoped widgets", () => {
    for (const type of ["metric", "list", "breakdown", "attention", "trend", "activity"] as const) {
      const w = newWidget(empty, type)
      expect("conceptId" in w && w.conceptId).toBeNull()
    }
  })
})

describe("referencedConceptIds", () => {
  it("ignores org-global widgets and collects only concept-scoped ids", () => {
    let body = empty
    for (const type of ["tasks", "members", "welcome"] as const) {
      body = addWidget(body, newWidget(body, type))
    }
    const metric = { ...newWidget(body, "metric"), conceptId: "c1" }
    body = addWidget(body, metric)
    expect(referencedConceptIds(body)).toEqual(["c1"])
  })
})
