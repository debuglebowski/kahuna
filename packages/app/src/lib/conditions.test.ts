import { describe, expect, it } from "vitest"
import type { RecordVersion, SidebarCondition } from "./api"
import { LABELS_KEY, matchCondition, matchRecordVersion } from "./conditions"

const inst = (state: Record<string, unknown>): RecordVersion => {
  const id = Math.random().toString(36).slice(2)
  return {
    id,
    conceptId: "c1",
    recordId: id,
    state,
    version: 0,
    versionStatus: "published",
    versionSeq: 1,
    publishedAt: new Date(0),
    createdAt: new Date(0),
    archivedAt: null,
  }
}

const c = (field: string, op: SidebarCondition["op"], value: unknown = null): SidebarCondition => ({
  field,
  op,
  value,
})

describe("matchCondition ops", () => {
  it("eq/neq: scalar, array containment, string↔number coercion", () => {
    const i = inst({ stage: "open", n: 5, tags: ["a", "b"] })
    expect(matchCondition(i, c("stage", "eq", "open"))).toBe(true)
    expect(matchCondition(i, c("stage", "neq", "open"))).toBe(false)
    expect(matchCondition(i, c("tags", "eq", "b"))).toBe(true)
    expect(matchCondition(i, c("tags", "neq", "z"))).toBe(true)
    expect(matchCondition(i, c("n", "eq", "5"))).toBe(true) // URL round-trip
  })

  it("contains: case-insensitive substring, arrays match any element", () => {
    const i = inst({ name: "Acme Renewal", tags: ["priority", "q3"] })
    expect(matchCondition(i, c("name", "contains", "renew"))).toBe(true)
    expect(matchCondition(i, c("name", "contains", "xyz"))).toBe(false)
    expect(matchCondition(i, c("tags", "contains", "PRIO"))).toBe(true)
    expect(matchCondition(i, c("missing", "contains", "x"))).toBe(false)
  })

  it("empty/notEmpty: null, undefined, empty string and empty array are empty", () => {
    const i = inst({ a: "", b: null, d: [], e: "x", f: 0 })
    for (const k of ["a", "b", "d", "missing"]) {
      expect(matchCondition(i, c(k, "empty"))).toBe(true)
      expect(matchCondition(i, c(k, "notEmpty"))).toBe(false)
    }
    expect(matchCondition(i, c("e", "notEmpty"))).toBe(true)
    expect(matchCondition(i, c("f", "notEmpty"))).toBe(true) // 0 is a value
  })

  it("ordered ops: numeric, money amount, and ISO date comparison", () => {
    const i = inst({ n: 10, m: { amount: 250, currency: "EUR" }, d: "2026-06-15" })
    expect(matchCondition(i, c("n", "gt", 5))).toBe(true)
    expect(matchCondition(i, c("n", "lte", 10))).toBe(true)
    expect(matchCondition(i, c("n", "lt", 10))).toBe(false)
    expect(matchCondition(i, c("m", "gte", 250))).toBe(true)
    expect(matchCondition(i, c("m", "gt", "300"))).toBe(false)
    expect(matchCondition(i, c("d", "gt", "2026-06-01"))).toBe(true)
    expect(matchCondition(i, c("d", "lt", "2026-06-01"))).toBe(false)
    expect(matchCondition(i, c("missing", "gt", 1))).toBe(false)
  })

  it("between: inclusive bounds, open-ended when a bound is empty", () => {
    const i = inst({ n: 10, d: "2026-06-15" })
    expect(matchCondition(i, c("n", "between", [5, 15]))).toBe(true)
    expect(matchCondition(i, c("n", "between", [10, 10]))).toBe(true)
    expect(matchCondition(i, c("n", "between", [11, 20]))).toBe(false)
    expect(matchCondition(i, c("n", "between", ["", 20]))).toBe(true)
    expect(matchCondition(i, c("n", "between", [20, ""]))).toBe(false)
    expect(matchCondition(i, c("d", "between", ["2026-06-01", "2026-06-30"]))).toBe(true)
    expect(matchCondition(i, c("missing", "between", [1, 2]))).toBe(false)
  })

  it("in/notIn: value-list membership, multi-value fields intersect", () => {
    const i = inst({ stage: "open", tags: ["a", "b"] })
    expect(matchCondition(i, c("stage", "in", ["open", "won"]))).toBe(true)
    expect(matchCondition(i, c("stage", "in", ["won"]))).toBe(false)
    expect(matchCondition(i, c("stage", "notIn", ["won"]))).toBe(true)
    expect(matchCondition(i, c("tags", "in", ["b", "z"]))).toBe(true)
    expect(matchCondition(i, c("tags", "notIn", ["a"]))).toBe(false)
  })

  it("isMe: matches the ctx user id; never matches without one", () => {
    const i = inst({ owner: "u1" })
    expect(matchCondition(i, c("owner", "isMe"), { me: "u1" })).toBe(true)
    expect(matchCondition(i, c("owner", "isMe"), { me: "u2" })).toBe(false)
    expect(matchCondition(i, c("owner", "isMe"))).toBe(false)
  })

  it("label ops read the synthetic labels key", () => {
    const i = inst({ [LABELS_KEY]: ["urgent", "vip"] })
    expect(matchCondition(i, c(LABELS_KEY, "hasLabel", "vip"))).toBe(true)
    expect(matchCondition(i, c(LABELS_KEY, "notHasLabel", "vip"))).toBe(false)
    expect(matchCondition(i, c(LABELS_KEY, "notHasLabel", "cold"))).toBe(true)
  })

  it("eq sees through computed values (decay band / momentum label)", () => {
    const i = inst({ decay: { days: 12, band: "cooling" }, mom: { label: "heating", recent: 3 } })
    expect(matchCondition(i, c("decay", "eq", "cooling"))).toBe(true)
    expect(matchCondition(i, c("decay", "neq", "cold"))).toBe(true)
    expect(matchCondition(i, c("mom", "eq", "heating"))).toBe(true)
  })

  it("rich text ops see through the { doc, text } envelope to its plain text", () => {
    const rich = (text: string) => ({
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      text,
    })
    const i = inst({ body: rich("Quarterly Renewal notes"), blank: rich("") })
    expect(matchCondition(i, c("body", "contains", "renewal"))).toBe(true)
    expect(matchCondition(i, c("body", "contains", "paragraph"))).toBe(false) // not the doc JSON
    expect(matchCondition(i, c("body", "eq", "Quarterly Renewal notes"))).toBe(true)
    expect(matchCondition(i, c("body", "notEmpty"))).toBe(true)
    expect(matchCondition(i, c("blank", "empty"))).toBe(true)
    expect(matchCondition(i, c("blank", "notEmpty"))).toBe(false)
  })
})

describe("matchRecordVersion combine modes", () => {
  const i = inst({ stage: "open", n: 1 })
  const hit = c("stage", "eq", "open")
  const miss = c("n", "eq", 99)

  it("defaults to all (AND)", () => {
    expect(matchRecordVersion(i, [hit, miss])).toBe(false)
    expect(matchRecordVersion(i, [hit, hit])).toBe(true)
    expect(matchRecordVersion(i, [])).toBe(true)
  })

  it("any (OR) needs one hit; an empty set still matches", () => {
    expect(matchRecordVersion(i, [hit, miss], { match: "any" })).toBe(true)
    expect(matchRecordVersion(i, [miss, miss], { match: "any" })).toBe(false)
    expect(matchRecordVersion(i, [], { match: "any" })).toBe(true)
  })
})

describe("transition ops (changedTo / changedFrom)", () => {
  const won = inst({ stage: "won", value: 5000 })

  it("changedTo holds only when the field actually moved INTO the value", () => {
    // The bug these ops exist to prevent: an unrelated edit on a record that is
    // ALREADY won must not read as "the deal was just won".
    expect(matchCondition(won, c("stage", "changedTo", "won"), { prev: { stage: "won" } })).toBe(
      false,
    )
    expect(matchCondition(won, c("stage", "changedTo", "won"), { prev: { stage: "nego" } })).toBe(
      true,
    )
    // Moved, but not to the value we asked about.
    expect(matchCondition(won, c("stage", "changedTo", "lost"), { prev: { stage: "nego" } })).toBe(
      false,
    )
  })

  it("changedFrom looks at the previous value", () => {
    expect(
      matchCondition(won, c("stage", "changedFrom", "nego"), { prev: { stage: "nego" } }),
    ).toBe(true)
    expect(
      matchCondition(won, c("stage", "changedFrom", "open"), { prev: { stage: "nego" } }),
    ).toBe(false)
  })

  it("an empty value means 'changed at all, in this direction'", () => {
    expect(matchCondition(won, c("stage", "changedTo"), { prev: { stage: "nego" } })).toBe(true)
    expect(matchCondition(won, c("stage", "changedTo"), { prev: { stage: "won" } })).toBe(false)
    // Newly SET (absent before) still counts as changed-to-something.
    expect(matchCondition(won, c("stage", "changedTo"), { prev: {} })).toBe(true)
    // Cleared: changedTo wants a non-empty after, changedFrom does not care.
    const cleared = inst({ stage: null })
    expect(matchCondition(cleared, c("stage", "changedTo"), { prev: { stage: "won" } })).toBe(false)
    expect(matchCondition(cleared, c("stage", "changedFrom"), { prev: { stage: "won" } })).toBe(
      true,
    )
  })

  it("never matches without a prev state — so filter bars and widgets are safe", () => {
    expect(matchCondition(won, c("stage", "changedTo", "won"))).toBe(false)
    expect(matchCondition(won, c("stage", "changedFrom", "nego"), { prev: null })).toBe(false)
    // And it composes with the normal combine modes.
    expect(matchRecordVersion(won, [c("stage", "changedTo", "won")], { match: "all" })).toBe(false)
  })

  it("coerces like the other ops (numbers through a JSON round-trip)", () => {
    expect(matchCondition(won, c("value", "changedTo", "5000"), { prev: { value: 100 } })).toBe(
      true,
    )
  })
})
