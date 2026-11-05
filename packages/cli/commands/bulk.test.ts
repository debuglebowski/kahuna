import type { Field } from "@kahunalabs/contract"
import { describe, expect, it } from "vitest"
import { coerceCell, listCell } from "./bulk.ts"

const category = {
  id: "fc",
  conceptId: "c1",
  name: "Category",
  kind: "enum",
  config: { options: ["Legal", "Finance"], multiple: true },
} as unknown as Field

describe("record import cells on a multiple field", () => {
  it("a CSV cell splits like --field", () => {
    expect(coerceCell(category, "Legal; Finance", {})).toEqual(["Legal", "Finance"])
    expect(coerceCell(category, "Legal,Finance", {})).toEqual(["Legal", "Finance"])
  })

  it("a JSON import's array cell is validated, not trusted", () => {
    expect(coerceCell(category, ["legal"], {})).toEqual(["Legal"])
    expect(() => coerceCell(category, ["Ops"], {})).toThrow(/not an option/)
  })

  it("an empty cell clears", () => {
    expect(coerceCell(category, "", {})).toBeNull()
  })
})

describe("record export of list values round-trips through import", () => {
  const costs = {
    ...category,
    id: "fm",
    name: "Costs",
    kind: "money",
    config: { multiple: true },
  } as unknown as Field
  const tags = {
    ...category,
    id: "ft",
    name: "Tags",
    kind: "text",
    config: { multiple: true },
  } as unknown as Field

  it("money items export as amounts, not [object Object]", () => {
    const items = [
      { amount: 1200.5, currency: "SEK" },
      { amount: 5, currency: "EUR" },
    ]
    expect(listCell(items)).toBe("1200.5 SEK; 5 EUR")
    expect(coerceCell(costs, listCell(items), {})).toEqual(items)
  })

  it("an item containing ; exports as a JSON array", () => {
    const items = ["a; b", "c"]
    expect(coerceCell(tags, listCell(items), {})).toEqual(items)
  })

  it("plain items join with ;", () => {
    expect(listCell(["Legal", "Finance"])).toBe("Legal; Finance")
  })
})
