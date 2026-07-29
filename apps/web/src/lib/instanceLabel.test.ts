import { describe, expect, it } from "vitest"
import type { Field, Instance } from "../../rpc/contract"
import { instanceLabel } from "./instanceLabel"

const inst = (state: Record<string, unknown>): Instance =>
  ({
    id: "i1",
    conceptId: "c1",
    itemId: "it1",
    state,
    version: 1,
    versionStatus: "published",
    versionSeq: 1,
    publishedAt: null,
    createdAt: new Date(),
    archivedAt: null,
  }) as Instance

const field = (id: string, kind: Field["kind"]): Field =>
  ({
    id,
    conceptId: "c1",
    name: id,
    kind,
    formula: null,
    config: {},
    managedBy: null,
    icon: null,
    position: 0,
    archivedAt: null,
  }) as Field

const NAME = field("f_name", "text")
const BODY = field("f_body", "richtext")

describe("instanceLabel", () => {
  it("uses the title field's value when the concept designates one", () => {
    expect(instanceLabel(inst({ f_name: "Acme" }), [NAME], "f_name")).toBe("Acme")
  })

  it("guesses the first non-empty text field when no title field is set", () => {
    expect(instanceLabel(inst({ f_name: "Acme" }), [NAME])).toBe("Acme")
  })

  it("is (untitled) with nothing to show", () => {
    expect(instanceLabel(inst({}), [NAME])).toBe("(untitled)")
    expect(instanceLabel(inst({ f_name: "" }), [NAME], "f_name")).toBe("(untitled)")
  })
})

// A single-record concept's record IS the concept, so its page must read "Company",
// not "(untitled)" — there is no list of siblings to distinguish it from, and a
// freshly created record is empty by construction (the toggle creates it).
describe("instanceLabel fallbackLabel", () => {
  it("replaces (untitled) when the title field is empty", () => {
    expect(instanceLabel(inst({ f_name: "" }), [NAME], "f_name", "Company")).toBe("Company")
    expect(instanceLabel(inst({}), [NAME], "f_name", "Company")).toBe("Company")
  })

  it("replaces (untitled) on the no-title-field guess path too", () => {
    expect(instanceLabel(inst({}), [NAME, BODY], null, "Company")).toBe("Company")
  })

  it("never wins over an actual value", () => {
    expect(instanceLabel(inst({ f_name: "Acme" }), [NAME], "f_name", "Company")).toBe("Acme")
    expect(instanceLabel(inst({ f_name: "Acme" }), [NAME], null, "Company")).toBe("Acme")
  })

  // Concept names can't be blank in practice, but a whitespace-only one must not
  // produce an empty header — that reads as a rendering bug, not a missing value.
  it("ignores a blank fallback", () => {
    expect(instanceLabel(inst({}), [NAME], "f_name", "   ")).toBe("(untitled)")
    expect(instanceLabel(inst({}), [NAME], "f_name", "")).toBe("(untitled)")
  })
})
