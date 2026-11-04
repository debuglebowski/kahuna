import { type DashboardBody, toTreeBody } from "@kahunalabs/contract"
import { describe, expect, it } from "vitest"

const note = (id: string) => ({ id, type: "note", title: null }) as never

describe("toTreeBody", () => {
  it("upgrades a legacy flat body into a col root, dropping legacy keys", () => {
    const legacy: DashboardBody = { widgets: [note("a"), note("b")], cols: 12, rowHeight: 30 }
    expect(toTreeBody(legacy)).toEqual({ direction: "col", children: [note("a"), note("b")] })
  })

  it("upgrades an empty legacy body to an empty tree", () => {
    expect(toTreeBody({})).toEqual({ direction: "col", children: [] })
  })

  it("passes a tree body through, defaulting direction", () => {
    expect(toTreeBody({ direction: "row", children: [note("a")] })).toEqual({
      direction: "row",
      children: [note("a")],
    })
    expect(toTreeBody({ children: [] }).direction).toBe("col")
  })
})
