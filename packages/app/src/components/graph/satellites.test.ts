import { describe, expect, it } from "vitest"
import { placeSatellites, SATELLITE_GAP } from "./satellites"

const parent = { x: 0, y: 0, w: 100, h: 40 }
const size = { w: 60, h: 24 }

describe("placeSatellites", () => {
  it("goes right of the parent, vertically centred, when free", () => {
    const p = placeSatellites([{ id: "a", box: parent, size }], [parent])
    expect(p.get("a")).toEqual({ x: 100 + SATELLITE_GAP, y: 8 })
  })

  it("falls back to below when the right side is taken", () => {
    const blocker = { x: 120, y: -20, w: 80, h: 80 }
    const p = placeSatellites([{ id: "a", box: parent, size }], [parent, blocker])
    expect(p.get("a")).toEqual({ x: 20, y: 40 + SATELLITE_GAP })
  })

  it("keeps two parents' satellites from landing on each other", () => {
    const other = { x: 100 + SATELLITE_GAP + 60 + 30, y: 0, w: 100, h: 40 }
    const p = placeSatellites(
      [
        { id: "a", box: parent, size },
        { id: "b", box: other, size },
      ],
      [parent, other],
    )
    const a = p.get("a")
    const b = p.get("b")
    expect(a && b && (a.x + size.w <= b.x || b.x + size.w <= a.x || a.y !== b.y)).toBe(true)
  })

  it("still places it (right) when every side is blocked", () => {
    const wall = { x: -500, y: -500, w: 1100, h: 1000 }
    const p = placeSatellites([{ id: "a", box: parent, size }], [wall])
    expect(p.get("a")).toEqual({ x: 100 + SATELLITE_GAP, y: 8 })
  })
})
