import { describe, expect, it } from "vitest"
import { LABELS_KEY } from "../../rpc/contract"
import type { Instance, SidebarCondition } from "./api"
import {
  avgField,
  BANDS_KEY,
  bandOf,
  bandRollup,
  countInstances,
  groupBy,
  matchInstance,
  metricValue,
  staleInstances,
  sumField,
} from "./widgetAggregations"

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

const eq = (field: string, value: unknown): SidebarCondition => ({ field, op: "eq", value })
const hasLabel = (value: string): SidebarCondition => ({ field: LABELS_KEY, op: "hasLabel", value })

describe("matchInstance", () => {
  it("ANDs all conditions; eq matches scalar or array containment", () => {
    const i = inst({ stage: "open", tags: ["a", "b"] })
    expect(matchInstance(i, [eq("stage", "open")])).toBe(true)
    expect(matchInstance(i, [eq("stage", "won")])).toBe(false)
    expect(matchInstance(i, [eq("tags", "b")])).toBe(true)
    expect(matchInstance(i, [eq("stage", "open"), eq("tags", "z")])).toBe(false)
    expect(matchInstance(i, [])).toBe(true)
  })

  it("hasLabel reads the synthetic labels key", () => {
    const i = inst({ [LABELS_KEY]: ["urgent", "vip"] })
    expect(matchInstance(i, [hasLabel("vip")])).toBe(true)
    expect(matchInstance(i, [hasLabel("cold")])).toBe(false)
    expect(matchInstance(inst({}), [hasLabel("vip")])).toBe(false)
  })
})

describe("count / sum / avg", () => {
  const data = [
    inst({ stage: "open", amount: 10 }),
    inst({ stage: "open", amount: "20" }), // numeric string coerces
    inst({ stage: "won", amount: 5 }),
    inst({ stage: "open", amount: { amount: 7, currency: "USD" } }), // money field
    inst({ stage: "open", amount: "n/a" }), // non-numeric, skipped
  ]

  it("count respects the filter", () => {
    expect(countInstances(data, [])).toBe(5)
    expect(countInstances(data, [eq("stage", "open")])).toBe(4)
  })

  it("sum coerces strings + money, skips non-numeric", () => {
    expect(sumField(data, [eq("stage", "open")], "amount")).toBe(37) // 10 + 20 + 7
    expect(sumField(data, [], "amount")).toBe(42) // + 5
  })

  it("avg returns null when no numeric values match", () => {
    expect(avgField(data, [eq("stage", "open")], "amount")).toBeCloseTo(37 / 3)
    expect(avgField([], [], "amount")).toBeNull()
    expect(avgField([inst({ amount: "x" })], [], "amount")).toBeNull()
  })

  it("metricValue dispatches on agg; sum/avg need a field", () => {
    expect(metricValue(data, "count", [eq("stage", "won")])).toBe(1)
    expect(metricValue(data, "sum", [], "amount")).toBe(42)
    expect(metricValue(data, "sum", [])).toBeNull() // no field id
  })
})

describe("groupBy", () => {
  it("groups by a scalar field, missing → '—', sorted by count desc", () => {
    const data = [
      inst({ stage: "open" }),
      inst({ stage: "open" }),
      inst({ stage: "won" }),
      inst({}), // missing → "—"
    ]
    expect(groupBy(data, [], "stage")).toEqual([
      { key: "open", count: 2 },
      { key: "won", count: 1 },
      { key: "—", count: 1 },
    ])
  })

  it("fans out multi-value fields and respects the filter", () => {
    const data = [inst({ stage: "open", tags: ["a", "b"] }), inst({ stage: "won", tags: ["a"] })]
    expect(groupBy(data, [eq("stage", "open")], "tags")).toEqual([
      { key: "a", count: 1 },
      { key: "b", count: 1 },
    ])
  })

  it("groups by label id (one bucket per label), skipping no-label instances", () => {
    const data = [
      inst({ [LABELS_KEY]: ["urgent", "vip"] }),
      inst({ [LABELS_KEY]: ["urgent"] }),
      inst({}),
    ]
    expect(groupBy(data, [], LABELS_KEY)).toEqual([
      { key: "urgent", count: 2 },
      { key: "vip", count: 1 },
    ])
  })
})

describe("computed bands (attention)", () => {
  const F = "decayfield"

  it("bandOf prefers the decorated value over the __bands marker", () => {
    const i = inst({ [F]: { days: 20, band: "cooling" }, [BANDS_KEY]: { [F]: "cold" } })
    expect(bandOf(i, F)).toBe("cooling")
  })

  it("bandOf reads momentum label, and falls back to the __bands marker", () => {
    expect(bandOf(inst({ [F]: { label: "heating", recent: 5, prior: 2 } }), F)).toBe("heating")
    expect(bandOf(inst({ [BANDS_KEY]: { [F]: "cold" } }), F)).toBe("cold")
    expect(bandOf(inst({}), F)).toBeUndefined()
  })

  it("bandRollup counts per band", () => {
    const data = [
      inst({ [F]: { days: 2, band: "fresh" } }),
      inst({ [F]: { days: 18, band: "cooling" } }),
      inst({ [F]: { days: 40, band: "cold" } }),
      inst({ [F]: { days: 35, band: "cold" } }),
    ]
    expect(bandRollup(data, F)).toEqual({ fresh: 1, cooling: 1, cold: 2 })
  })

  it("staleInstances filters by band and sorts most-stale (days desc) first", () => {
    const a = inst({ [F]: { days: 18, band: "cooling" } })
    const b = inst({ [F]: { days: 50, band: "cold" } })
    const c = inst({ [F]: { days: 3, band: "fresh" } })
    const out = staleInstances([a, b, c], F, ["cooling", "cold"])
    expect(out.map((i) => i.id)).toEqual([b.id, a.id]) // fresh excluded; cold(50) before cooling(18)
  })
})
