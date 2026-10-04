import type { Concept, Field, RecordVersion } from "@kahunalabs/contract"
import { describe, expect, it } from "vitest"
import { EXIT } from "./errors.ts"
import { findConcept, findField, labelOf, parseFieldAssignments } from "./resolve.ts"

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
