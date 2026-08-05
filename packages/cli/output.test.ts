import { describe, expect, it } from "vitest"
import { renderCsv, renderTable } from "./output.ts"

describe("table", () => {
  it("aligns columns to the widest cell, header included", () => {
    const out = renderTable([
      { name: "Acme", city: "Oslo" },
      { name: "Umbrella Corporation", city: "Ås" },
    ])
    const [header, first] = out.split("\n")
    expect(header?.startsWith("NAME")).toBe(true)
    // Every row's second column must start at the same offset.
    expect(first?.indexOf("Oslo")).toBe(out.split("\n")[2]?.indexOf("Ås"))
  })

  it("renders null and undefined as empty, not as the words", () => {
    expect(renderTable([{ a: null, b: undefined, c: 0 }])).toContain("0")
    expect(renderTable([{ a: null }])).not.toMatch(/null/)
  })

  it("serialises objects rather than printing [object Object]", () => {
    expect(renderTable([{ a: { x: 1 } }])).toContain('{"x":1}')
  })

  it("returns nothing for no rows, so a pipe gets no phantom header", () => {
    expect(renderTable([])).toBe("")
  })
})

describe("csv", () => {
  it("quotes commas, quotes and newlines — and doubles inner quotes", () => {
    const out = renderCsv([{ a: "x,y", b: 'say "hi"', c: "one\ntwo" }])
    expect(out.split("\n")[1]).toBe('"x,y","say ""hi""","one')
  })

  it("keeps a stable column order across ragged rows", () => {
    const out = renderCsv([{ a: 1 }, { b: 2 }])
    expect(out.split("\n")[0]).toBe("a,b")
    expect(out.split("\n")[1]).toBe("1,")
    expect(out.split("\n")[2]).toBe(",2")
  })

  it("emits a header even with no rows, so the shape survives an empty result", () => {
    expect(renderCsv([], ["a", "b"])).toBe("a,b")
  })
})
