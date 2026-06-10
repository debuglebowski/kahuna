import { describe, expect, it } from "vitest"
import type { Instance, SidebarCondition } from "./api"
import { LABELS_KEY, matchCondition, matchInstance } from "./conditions"

const inst = (state: Record<string, unknown>): Instance => {
  const id = Math.random().toString(36).slice(2)
  return {
    id,
    conceptId: "c1",
    itemId: id,
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
})

describe("matchInstance combine modes", () => {
  const i = inst({ stage: "open", n: 1 })
  const hit = c("stage", "eq", "open")
  const miss = c("n", "eq", 99)

  it("defaults to all (AND)", () => {
    expect(matchInstance(i, [hit, miss])).toBe(false)
    expect(matchInstance(i, [hit, hit])).toBe(true)
    expect(matchInstance(i, [])).toBe(true)
  })

  it("any (OR) needs one hit; an empty set still matches", () => {
    expect(matchInstance(i, [hit, miss], { match: "any" })).toBe(true)
    expect(matchInstance(i, [miss, miss], { match: "any" })).toBe(false)
    expect(matchInstance(i, [], { match: "any" })).toBe(true)
  })
})
