import { describe, expect, it } from "vitest"
import type { Concept } from "../../rpc/contract"
import { conceptBySlug } from "./singleRecord"

const concept = (patch: Partial<Concept> = {}): Concept =>
  ({
    id: "c1",
    slug: "company",
    name: "Company",
    pluralName: null,
    description: null,
    icon: null,
    color: null,
    managedBy: null,
    staticLabelIds: [],
    defaultLabelIds: [],
    versioningEnabled: false,
    editReach: "draft",
    singleRecord: true,
    recordView: null,
    titleFieldId: null,
    archivedAt: null,
    ...patch,
  }) as Concept

describe("conceptBySlug", () => {
  it("resolves a live single-record concept by its slug", () => {
    expect(conceptBySlug([concept()], "company")?.id).toBe("c1")
  })

  it("is undefined while the concept list is still loading", () => {
    expect(conceptBySlug(undefined, "company")).toBeUndefined()
  })

  it("is undefined for an unknown slug", () => {
    expect(conceptBySlug([concept()], "nope")).toBeUndefined()
  })

  // The `/c/` address only exists while the mode is on — a concept switched back to
  // a list has many records and no single one to render, so the route must 404
  // rather than pick one arbitrarily.
  it("refuses a concept that is not single-record", () => {
    expect(conceptBySlug([concept({ singleRecord: false })], "company")).toBeUndefined()
  })

  it("refuses an archived concept", () => {
    expect(conceptBySlug([concept({ archivedAt: new Date() })], "company")).toBeUndefined()
  })

  // Slugs are per-concept and immutable, so a rename leaves the URL working — the
  // match is on slug, never on name.
  it("matches on slug, not name", () => {
    expect(conceptBySlug([concept({ name: "Renamed Co" })], "company")?.id).toBe("c1")
    expect(conceptBySlug([concept()], "Company")).toBeUndefined()
  })
})
