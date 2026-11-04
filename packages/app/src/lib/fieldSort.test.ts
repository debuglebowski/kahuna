import { describe, expect, it } from "vitest"
import type { Field } from "./api"
import { compareFieldValues, sortRecordsByField } from "./fieldSort"

const field = (kind: Field["kind"], config: Record<string, unknown> = {}): Field =>
  ({ id: "f", name: "F", kind, config }) as unknown as Field

const sortVals = (f: Field | undefined, vals: unknown[], dir: "asc" | "desc" = "asc") =>
  sortRecordsByField(
    vals.map((v) => ({ state: { f: v } })),
    f,
    "f",
    dir,
  ).map((r) => r.state.f)

describe("compareFieldValues", () => {
  it("numbers compare by value, not string", () => {
    expect(sortVals(field("number"), [200, 1000, 30])).toEqual([30, 200, 1000])
    expect(sortVals(field("number"), [200, 1000, 30], "desc")).toEqual([1000, 200, 30])
  })

  it("money compares by amount", () => {
    const m = (amount: number) => ({ amount, currency: "SEK" })
    expect(sortVals(field("money"), [m(200), m(1000), m(30)], "desc")).toEqual([
      m(1000),
      m(200),
      m(30),
    ])
  })

  it("dates compare chronologically", () => {
    expect(sortVals(field("date"), ["2026-03-03", "2025-12-01", "2026-01-09"])).toEqual([
      "2025-12-01",
      "2026-01-09",
      "2026-03-03",
    ])
  })

  it("enums follow option order", () => {
    const f = field("enum", { options: ["lead", "qualified", "won"] })
    expect(sortVals(f, ["won", "lead", "qualified"])).toEqual(["lead", "qualified", "won"])
  })

  it("text collates naturally", () => {
    expect(sortVals(field("text"), ["item 10", "Item 2", "item 1"])).toEqual([
      "item 1",
      "Item 2",
      "item 10",
    ])
  })

  it("empties sort last in both directions", () => {
    expect(sortVals(field("number"), [null, 2, "", 1])).toEqual([1, 2, null, ""])
    expect(sortVals(field("number"), [null, 2, 1], "desc")).toEqual([2, 1, null])
    expect(compareFieldValues(field("number"), null, undefined)).toBe(0)
  })
})
