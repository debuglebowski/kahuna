import type { Concept, Field, RecordVersion } from "@kahunalabs/contract"
import { describe, expect, it } from "vitest"
import { toRow } from "./commands/record.ts"
import { EXIT } from "./errors.ts"
import {
  assignsMoney,
  coerceValue,
  fileNames,
  findConcept,
  findField,
  labelOf,
  parseFieldAssignments,
} from "./resolve.ts"

const concept = (over: Partial<Concept>): Concept =>
  ({
    id: "c1",
    slug: "vendor",
    name: "Vendor",
    titleFieldId: null,
    versioningEnabled: false,
    singleRecord: false,
    ...over,
  }) as Concept

const field = (over: Partial<Field>): Field =>
  ({ id: "f1", conceptId: "c1", name: "Name", kind: "text", config: {}, ...over }) as Field

describe("finding a concept", () => {
  const all = [
    concept({ id: "c1", slug: "vendor", name: "Vendor" }),
    concept({ id: "c2", slug: "venue", name: "Venue" }),
    concept({ id: "c3", slug: "person", name: "Person" }),
  ]

  it("takes an exact slug, name or id before considering a prefix", () => {
    expect(findConcept(all, "vendor").id).toBe("c1")
    expect(findConcept(all, "Vendor").id).toBe("c1")
    expect(findConcept(all, "c2").id).toBe("c2")
  })

  it("accepts an unambiguous prefix", () => {
    expect(findConcept(all, "per").id).toBe("c3")
  })

  it("REFUSES an ambiguous prefix and names the candidates", () => {
    // Picking one silently is how a script edits the wrong concept for a month.
    try {
      findConcept(all, "ven")
      expect.unreachable("should have thrown")
    } catch (e) {
      const err = e as { message: string; hint?: string; exitCode: number }
      expect(err.message).toContain("matches 2")
      expect(err.hint).toContain("vendor")
      expect(err.hint).toContain("venue")
      expect(err.exitCode).toBe(EXIT.usage)
    }
  })

  it("lists what exists when nothing matches", () => {
    try {
      findConcept(all, "nope")
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain("vendor, venue, person")
      expect((e as { exitCode: number }).exitCode).toBe(EXIT.notFound)
    }
  })
})

describe("finding a field", () => {
  const fields = [
    field({ id: "f1", name: "Name" }),
    field({ id: "f2", name: "Notes" }),
    field({ id: "f3", name: "Status", kind: "enum" }),
  ]

  it("prefers an exact name over a prefix", () => {
    expect(findField(fields, "Name").id).toBe("f1")
    expect(findField(fields, "stat").id).toBe("f3")
  })

  it("refuses an ambiguous prefix", () => {
    expect(() => findField(fields, "N")).toThrow(/matches 2/)
  })
})

describe("the display label", () => {
  const v = (state: Record<string, unknown>): RecordVersion =>
    ({ id: "v1", state }) as unknown as RecordVersion

  it("uses the concept's title field", () => {
    const c = concept({ titleFieldId: "f1" })
    expect(labelOf(v({ f1: "Acme" }), c, [field({ id: "f1" })])).toBe("Acme")
  })

  it("falls back to the id — never to an empty string", () => {
    // A blank label renders as a row nobody can identify or report.
    const c = concept({ titleFieldId: "f1" })
    expect(labelOf(v({ f1: "  " }), c, [field({ id: "f1" })])).toBe("v1")
    expect(labelOf(v({}), concept({}), [])).toBe("v1")
  })
})

describe("--field name=value", () => {
  const fields = [
    field({ id: "f1", name: "Name", kind: "text" }),
    field({ id: "f2", name: "Headcount", kind: "number" }),
    field({ id: "f3", name: "Active", kind: "bool" }),
    field({ id: "f4", name: "Meta", kind: "json" }),
  ]

  it("keys by FIELD ID, not by the typed name", () => {
    expect(parseFieldAssignments(fields, ["Name=Acme"])).toEqual({ f1: "Acme" })
  })

  it("coerces by the field's kind, not by guessing from the text", () => {
    // "1" in a text field must stay a string, or a jsonb column quietly holds
    // the wrong type and filters stop matching with no error anywhere.
    expect(parseFieldAssignments(fields, ["Name=1"])).toEqual({ f1: "1" })
    expect(parseFieldAssignments(fields, ["Headcount=12"])).toEqual({ f2: 12 })
    expect(parseFieldAssignments(fields, ["Active=yes"])).toEqual({ f3: true })
    expect(parseFieldAssignments(fields, ['Meta={"a":1}'])).toEqual({ f4: { a: 1 } })
  })

  it("treats an empty value as a clear", () => {
    expect(parseFieldAssignments(fields, ["Name="])).toEqual({ f1: null })
  })

  it("rejects a value the field cannot hold", () => {
    expect(() => parseFieldAssignments(fields, ["Headcount=lots"])).toThrow(/not a number/)
    expect(() => parseFieldAssignments(fields, ["Active=maybe"])).toThrow(/true\/false/)
    expect(() => parseFieldAssignments(fields, ["Meta={oops"])).toThrow(/valid JSON/)
  })

  it("rejects a pair with no '='", () => {
    expect(() => parseFieldAssignments(fields, ["Name"])).toThrow(/name=value/)
  })

  it("takes the first '=' so values may contain one", () => {
    expect(parseFieldAssignments(fields, ["Name=a=b"])).toEqual({ f1: "a=b" })
  })
})

describe("money values", () => {
  const cost = field({ id: "m", name: "Annual cost", kind: "money" })
  const money = (text: string, defaultCurrency?: string | null | "unavailable") =>
    coerceValue(cost, text, { defaultCurrency })

  it("reads an amount with a code on either side, any case", () => {
    expect(money("1200 SEK")).toEqual({ amount: 1200, currency: "SEK" })
    expect(money("1200sek")).toEqual({ amount: 1200, currency: "SEK" })
    expect(money("EUR 99.5")).toEqual({ amount: 99.5, currency: "EUR" })
    expect(money("-12 usd")).toEqual({ amount: -12, currency: "USD" })
  })

  it("accepts a comma or space ONLY between thousands", () => {
    expect(money("1,200.50 EUR")).toEqual({ amount: 1200.5, currency: "EUR" })
    expect(money("1 200 000 SEK")).toEqual({ amount: 1_200_000, currency: "SEK" })
    // 1200,50 is 1200.5 in Sweden and 120050 to a naive strip — refuse both.
    expect(() => money("1200,50 SEK")).toThrow(/not an amount/)
    expect(() => money("1,20 SEK")).toThrow(/not an amount/)
  })

  it("takes the org default currency for a bare amount", () => {
    expect(money("1200", "SEK")).toEqual({ amount: 1200, currency: "SEK" })
    // A code that is typed wins over the default.
    expect(money("1200 EUR", "SEK")).toEqual({ amount: 1200, currency: "EUR" })
  })

  it("refuses a bare amount with no default — never guesses USD", () => {
    expect(() => money("1200", null)).toThrow(/has no currency/)
    expect(() => money("1200")).toThrow(/has no currency/)
    try {
      money("1200", "unavailable")
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/no org default currency setting/)
    }
  })

  it("accepts the stored shape as JSON, validated", () => {
    expect(money('{"amount":5,"currency":"nok"}')).toEqual({ amount: 5, currency: "NOK" })
    expect(money('{"amount":5}', "SEK")).toEqual({ amount: 5, currency: "SEK" })
    expect(() => money('{"amount":"5","currency":"SEK"}')).toThrow(/numeric amount/)
    expect(() => money('{"amount":5,"currency":"kronor"}')).toThrow(/currency code/)
  })

  it("rejects junk and clears on empty", () => {
    expect(() => money("lots")).toThrow(/not an amount/)
    expect(() => money("$1200")).toThrow(/not an amount/)
    expect(money("")).toBeNull()
  })

  it("knows when a command needs the default at all", () => {
    const fields = [field({ id: "f1", name: "Name" }), cost]
    expect(assignsMoney(fields, ["Name=x"])).toBe(false)
    expect(assignsMoney(fields, ["annual cost=1"])).toBe(true)
    expect(assignsMoney(fields, ["Nope=1"])).toBe(false)
  })
})

describe("richtext values", () => {
  const scope = field({ id: "r", name: "ISMS scope", kind: "richtext" })

  it("turns plain text into a {doc, text} envelope", () => {
    expect(parseFieldAssignments([scope], ["ISMS scope=hello"])).toEqual({
      r: {
        doc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
        },
        text: "hello",
      },
    })
  })

  it("passes raw {doc,text} JSON through, re-deriving text", () => {
    const pm = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
    }
    expect(coerceValue(scope, JSON.stringify({ doc: pm, text: "" }))).toEqual({
      doc: pm,
      text: "x",
    })
  })

  it("refuses JSON that is not rich text, but keeps brace-led prose", () => {
    expect(() => coerceValue(scope, '{"a":1}')).toThrow(/not rich text/)
    expect((coerceValue(scope, "{draft} notes") as { text: string }).text).toBe("{draft} notes")
  })
})

describe("@file values", () => {
  const fields = [
    field({ id: "c", name: "Content", kind: "richtext" }),
    field({ id: "n", name: "Handle", kind: "text" }),
    field({ id: "h", name: "Headcount", kind: "number" }),
  ]
  const files: Record<string, string> = {
    "policy.md": "# Policy\n\n- one\n- two\n",
    "n.txt": "12\n\n",
  }
  const readFile = (p: string) => {
    const f = files[p]
    if (f === undefined) throw new Error("ENOENT")
    return f
  }

  it("reads the value from the file, for any kind, minus trailing newlines", () => {
    const out = parseFieldAssignments(fields, ["Content=@policy.md", "Headcount=@n.txt"], {
      readFile,
    })
    expect(
      (out.c as { doc: { content: Array<{ type: string }> } }).doc.content.map((n) => n.type),
    ).toEqual(["heading", "bulletList"])
    expect(out.h).toBe(12)
  })

  it("writes a literal leading @ when doubled", () => {
    expect(parseFieldAssignments(fields, ["Handle=@@normain"], { readFile })).toEqual({
      n: "@normain",
    })
  })

  it("fails loudly on a missing file, saying how to escape", () => {
    try {
      parseFieldAssignments(fields, ["Handle=@normain"], { readFile })
      expect.unreachable()
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(EXIT.notFound)
      expect((e as { hint?: string }).hint).toMatch(/@@/)
    }
  })
})

describe("file properties", () => {
  const ref = (filename: string) => ({
    id: `id-${filename}`,
    filename,
    mimeType: null,
    sizeBytes: 1,
    createdBy: null,
    createdAt: new Date(0),
  })
  const files = field({ id: "ff", name: "Attachments", kind: "file", config: { multiple: true } })
  const one = field({ id: "fo", name: "Signed", kind: "file" })

  it("prints a file value as its filenames — list or single, absent = empty", () => {
    expect(fileNames([ref("a.pdf"), ref("b.pdf")])).toBe("a.pdf, b.pdf")
    expect(fileNames(ref("s.pdf"))).toBe("s.pdf")
    expect(fileNames(undefined)).toBe("")
    expect(fileNames("not-a-ref")).toBe("")
  })

  it("record rows show filenames in a table, the refs (with ids) in JSON", () => {
    const version = {
      id: "v1",
      recordId: "r1",
      conceptId: "c1",
      state: { ff: [ref("a.pdf"), ref("b.pdf")], fo: ref("s.pdf") },
      archivedAt: null,
    } as unknown as RecordVersion
    const table = toRow(version, concept({}), [files, one], "table")
    expect(table.Attachments).toBe("a.pdf, b.pdf")
    expect(table.Signed).toBe("s.pdf")
    const json = toRow(version, concept({}), [files, one], "json")
    expect((json.Attachments as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "id-a.pdf",
      "id-b.pdf",
    ])
  })

  it("refuses --field on a file property and points at attachment upload", () => {
    try {
      parseFieldAssignments([files], ["Attachments=a.pdf"])
      expect.unreachable()
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(EXIT.usage)
      expect(String((e as { hint?: string }).hint)).toContain("attachment upload")
    }
  })
})

describe("multiple fields and enums", () => {
  const category = field({
    id: "fc",
    name: "Category",
    kind: "enum",
    config: { options: ["Legal", "Finance", "HR"], multiple: true },
  })
  const status = field({
    id: "fs",
    name: "Status",
    kind: "enum",
    config: { options: ["Open", "Closed"] },
  })
  const tags = field({ id: "ft", name: "Tags", kind: "text", config: { multiple: true } })
  const scores = field({ id: "fn", name: "Scores", kind: "number", config: { multiple: true } })
  const costs = field({ id: "fm", name: "Costs", kind: "money", config: { multiple: true } })

  it("sends a list for a multiple field, even with one item", () => {
    expect(parseFieldAssignments([category], ["Category=Legal"])).toEqual({ fc: ["Legal"] })
  })

  it("accepts a,b — a; b — and a JSON array", () => {
    expect(coerceValue(category, "Legal,HR")).toEqual(["Legal", "HR"])
    expect(coerceValue(category, "Legal; HR")).toEqual(["Legal", "HR"])
    expect(coerceValue(category, '["Legal","HR"]')).toEqual(["Legal", "HR"])
  })

  it("splits on ; when present, so commas survive inside items (export round-trip)", () => {
    expect(coerceValue(tags, "a, b; c")).toEqual(["a, b", "c"])
    expect(coerceValue(tags, '["x, y"]')).toEqual(["x, y"])
  })

  it("drops blank items and keeps [non-json] text", () => {
    expect(coerceValue(tags, "a,,b,")).toEqual(["a", "b"])
    expect(coerceValue(tags, "[draft] notes")).toEqual(["[draft] notes"])
  })

  it("coerces each item by the field's kind", () => {
    expect(coerceValue(scores, "1, 2.5")).toEqual([1, 2.5])
    expect(coerceValue(scores, '[1, "2"]')).toEqual([1, 2])
    expect(() => coerceValue(scores, "1,lots")).toThrow(/not a number/)
    expect(coerceValue(tags, "[1]")).toEqual(["1"])
    expect(() => coerceValue(tags, "[null]")).toThrow(/null/)
  })

  it("money splits only on ; — a comma is a thousands separator", () => {
    expect(coerceValue(costs, "1,200 SEK; 5 EUR")).toEqual([
      { amount: 1200, currency: "SEK" },
      { amount: 5, currency: "EUR" },
    ])
    expect(coerceValue(costs, '[{"amount":3,"currency":"usd"}]')).toEqual([
      { amount: 3, currency: "USD" },
    ])
    try {
      coerceValue(costs, "1200 SEK, 5 EUR")
      expect.unreachable()
    } catch (e) {
      expect(String((e as { hint?: string }).hint)).toContain(";")
    }
  })

  it("an empty value still clears; [] is an explicit empty list", () => {
    expect(coerceValue(category, "")).toBeNull()
    expect(coerceValue(category, "[]")).toEqual([])
  })

  it("validates enum items against options, forgiving case", () => {
    expect(coerceValue(category, "legal, finance")).toEqual(["Legal", "Finance"])
    expect(coerceValue(status, "closed")).toBe("Closed")
    try {
      coerceValue(category, "Legal,Ops")
      expect.unreachable()
    } catch (e) {
      const err = e as { message: string; hint?: string; exitCode: number }
      expect(err.message).toContain('"Ops"')
      expect(err.message).toContain("Category")
      expect(err.hint).toContain("Legal, Finance, HR")
      expect(err.exitCode).toBe(EXIT.usage)
    }
    expect(() => coerceValue(status, "Pending")).toThrow(/not an option/)
  })

  it("leaves a single (non-multiple) text field a plain string", () => {
    expect(coerceValue(field({ kind: "text" }), "a,b")).toBe("a,b")
  })
})
