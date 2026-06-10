import { describe, expect, it } from "vitest"
import type { DashboardBody } from "./api"
import { addWidget, newWidget } from "./dashboards"

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
