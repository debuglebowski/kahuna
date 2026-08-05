import { describe, expect, it } from "vitest"
import { csvToObjects, parseCsv } from "./csv.ts"
import { renderCsv } from "./output.ts"

describe("parsing", () => {
  it("splits plain rows", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual({
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    })
  })

  it("keeps commas, quotes and newlines that are inside quotes", () => {
    const { rows } = parseCsv('a,b\n"x,y","say ""hi"""\n')
    expect(rows[0]).toEqual(["x,y", 'say "hi"'])
    const multiline = parseCsv('a\n"one\ntwo"')
    expect(multiline.rows[0]?.[0]).toBe("one\ntwo")
  })

  it("handles CRLF and a bare CR", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]])
    expect(parseCsv("a\r1\r2").rows).toEqual([["1"], ["2"]])
  })

  it("does not invent a row from a trailing newline", () => {
    // The classic way an importer adds one blank record per run.
    expect(parseCsv("a\n1\n").rows).toHaveLength(1)
  })

  it("strips a BOM so the first column name is not '\\ufeffid'", () => {
    // Excel writes one, and the header would otherwise never match a field.
    expect(parseCsv("﻿id,name\n1,x").header).toEqual(["id", "name"])
  })

  it("pads short rows instead of dropping their columns", () => {
    expect(csvToObjects("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }])
  })

  it("keeps an empty cell empty rather than shifting the row", () => {
    expect(csvToObjects("a,b,c\n1,,3")).toEqual([{ a: "1", b: "", c: "3" }])
  })
})

describe("round trip with the encoder", () => {
  it("survives every character that needs quoting", () => {
    // Encoder and parser are two halves of one format; testing them together is
    // what catches a quoting rule they BOTH get wrong.
    const rows = [
      { id: "1", name: 'Acme, "The" Corp', notes: "line one\nline two" },
      { id: "2", name: "", notes: "plain" },
    ]
    const csv = renderCsv(rows, ["id", "name", "notes"])
    expect(csvToObjects(csv)).toEqual(rows)
  })
})
