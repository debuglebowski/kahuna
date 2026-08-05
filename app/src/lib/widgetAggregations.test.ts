import { LABELS_KEY } from "@kingsmaker/contract"
import { describe, expect, it } from "vitest"
import type { RecordVersion, SidebarCondition } from "./api"
import {
  avgField,
  BANDS_KEY,
  bandOf,
  bandRollup,
  collapseOther,
  countRecords,
  createdOnOrBefore,
  groupBy,
  groupSeries,
  kanbanBuckets,
  matchRecordVersion,
  metricSeries,
  metricValue,
  OTHER_KEY,
  sortBuckets,
  staleRecords,
  sumField,
  timeBucket,
} from "./widgetAggregations"

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

const eq = (field: string, value: unknown): SidebarCondition => ({ field, op: "eq", value })
const hasLabel = (value: string): SidebarCondition => ({ field: LABELS_KEY, op: "hasLabel", value })

describe("matchRecordVersion", () => {
  it("ANDs all conditions; eq matches scalar or array containment", () => {
    const i = inst({ stage: "open", tags: ["a", "b"] })
    expect(matchRecordVersion(i, [eq("stage", "open")])).toBe(true)
    expect(matchRecordVersion(i, [eq("stage", "won")])).toBe(false)
    expect(matchRecordVersion(i, [eq("tags", "b")])).toBe(true)
    expect(matchRecordVersion(i, [eq("stage", "open"), eq("tags", "z")])).toBe(false)
    expect(matchRecordVersion(i, [])).toBe(true)
  })

  it("hasLabel reads the synthetic labels key", () => {
    const i = inst({ [LABELS_KEY]: ["urgent", "vip"] })
    expect(matchRecordVersion(i, [hasLabel("vip")])).toBe(true)
    expect(matchRecordVersion(i, [hasLabel("cold")])).toBe(false)
    expect(matchRecordVersion(inst({}), [hasLabel("vip")])).toBe(false)
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
    expect(countRecords(data, [])).toBe(5)
    expect(countRecords(data, [eq("stage", "open")])).toBe(4)
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

  it("groups by label id (one bucket per label), skipping no-label recordVersions", () => {
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

describe("sortBuckets / collapseOther (breakdown)", () => {
  const buckets = [
    { key: "open", count: 5 },
    { key: "won", count: 3 },
    { key: "lost", count: 2 },
  ]

  it("count keeps the input order; label sorts by display name", () => {
    expect(sortBuckets(buckets, "count").map((b) => b.key)).toEqual(["open", "won", "lost"])
    expect(sortBuckets(buckets, "label").map((b) => b.key)).toEqual(["lost", "open", "won"])
  })

  it("label sorts by the resolved name, not the raw key", () => {
    const names: Record<string, string> = { open: "Zeta", won: "Alpha", lost: "Mid" }
    const out = sortBuckets(buckets, "label", { labelOf: (k) => names[k] ?? k })
    expect(out.map((b) => b.key)).toEqual(["won", "lost", "open"])
  })

  it("field follows the configured order; unknown keys trail in label order", () => {
    const data = [...buckets, { key: "—", count: 1 }]
    const out = sortBuckets(data, "field", { order: ["won", "lost", "open"] })
    expect(out.map((b) => b.key)).toEqual(["won", "lost", "open", "—"])
  })

  it("collapseOther folds the tail into one Other bucket; no-op when within max", () => {
    expect(collapseOther(buckets, 1)).toEqual([
      { key: "open", count: 5 },
      { key: OTHER_KEY, count: 5 },
    ])
    expect(collapseOther(buckets, 2)).toEqual([
      { key: "open", count: 5 },
      { key: "won", count: 3 },
      { key: OTHER_KEY, count: 2 },
    ])
    expect(collapseOther(buckets, 3)).toEqual(buckets)
    expect(collapseOther(buckets, null)).toEqual(buckets)
  })
})

describe("createdOnOrBefore (metric delta baseline)", () => {
  it("keeps only recordVersions that existed at the cutoff", () => {
    const old = { ...inst({}), createdAt: new Date("2026-01-01") }
    const recent = { ...inst({}), createdAt: new Date("2026-06-01") }
    const out = createdOnOrBefore([old, recent], Date.parse("2026-03-01"))
    expect(out.map((i) => i.id)).toEqual([old.id])
  })
})

describe("metricSeries (sparkline)", () => {
  it("samples the cumulative metric across the window, ending on `to`", () => {
    const a = { ...inst({}), createdAt: new Date("2026-01-01") }
    const b = { ...inst({}), createdAt: new Date("2026-01-11") }
    // 3 samples over [Jan 1, Jan 21]: Jan 1 (a only), Jan 11 (a+b), Jan 21 (a+b).
    const out = metricSeries(
      [a, b],
      "count",
      [],
      null,
      Date.parse("2026-01-01"),
      Date.parse("2026-01-21"),
      3,
    )
    expect(out).toEqual([1, 2, 2])
  })

  it("clamps points to at least 2", () => {
    const a = { ...inst({}), createdAt: new Date("2026-01-01") }
    const out = metricSeries(
      [a],
      "count",
      [],
      null,
      Date.parse("2026-01-01"),
      Date.parse("2026-02-01"),
      1,
    )
    expect(out).toEqual([1, 1])
  })
})

describe("groupSeries (breakdown table trend/delta)", () => {
  const at = (stage: string, day: string): RecordVersion => ({
    ...inst({ stage }),
    createdAt: new Date(day),
  })

  it("re-groups the cumulative population at each sample, ending on `to`", () => {
    // open: Jan 1 + Jan 11; won: Jan 11. 3 samples over [Jan 1, Jan 21].
    const data = [at("open", "2026-01-01"), at("open", "2026-01-11"), at("won", "2026-01-11")]
    const out = groupSeries(
      data,
      [],
      "stage",
      Date.parse("2026-01-01"),
      Date.parse("2026-01-21"),
      3,
    )
    expect(out.get("open")).toEqual([1, 2, 2])
    expect(out.get("won")).toEqual([0, 1, 1]) // zero-filled before it first appears
  })

  it("respects the filter and clamps points to at least 2", () => {
    const data = [at("open", "2026-01-01"), at("won", "2026-01-01")]
    // Window sits entirely after creation, so both samples see the one open row.
    const out = groupSeries(
      data,
      [eq("stage", "open")],
      "stage",
      Date.parse("2026-01-15"),
      Date.parse("2026-02-01"),
      1,
    )
    expect(out.get("open")).toEqual([1, 1])
    expect(out.has("won")).toBe(false)
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

  it("staleRecords filters by band and sorts most-stale (days desc) first", () => {
    const a = inst({ [F]: { days: 18, band: "cooling" } })
    const b = inst({ [F]: { days: 50, band: "cold" } })
    const c = inst({ [F]: { days: 3, band: "fresh" } })
    const out = staleRecords([a, b, c], F, ["cooling", "cold"])
    expect(out.map((i) => i.id)).toEqual([b.id, a.id]) // fresh excluded; cold(50) before cooling(18)
  })
})

describe("timeBucket", () => {
  it("buckets events by day, zero-filling gaps and dropping out-of-range", () => {
    const from = Date.UTC(2024, 0, 1)
    const to = Date.UTC(2024, 0, 3)
    const events = [
      { occurredAt: new Date("2024-01-01T05:00:00Z") },
      { occurredAt: new Date("2024-01-01T20:00:00Z") },
      { occurredAt: new Date("2024-01-03T01:00:00Z") },
      { occurredAt: new Date("2023-12-31T23:00:00Z") }, // before window → dropped
    ]
    expect(timeBucket(events, "day", from, to)).toEqual([
      { bucket: "2024-01-01", count: 2 },
      { bucket: "2024-01-02", count: 0 },
      { bucket: "2024-01-03", count: 1 },
    ])
  })

  it("buckets by week to the containing Monday", () => {
    // 2024-01-03 is a Wednesday → its week bucket starts Mon 2024-01-01.
    const from = Date.UTC(2024, 0, 1)
    const to = Date.UTC(2024, 0, 5)
    const out = timeBucket([{ occurredAt: new Date("2024-01-03T12:00:00Z") }], "week", from, to)
    expect(out).toEqual([{ bucket: "2024-01-01", count: 1 }])
  })
})

describe("kanbanBuckets", () => {
  it('buckets by enum value, folding unset into the "" bucket', () => {
    const a = inst({ stage: "open" })
    const b = inst({ stage: "won" })
    const c = inst({ stage: "open" })
    const d = inst({}) // unset
    const e = inst({ stage: "" }) // empty string counts as unset too
    const out = kanbanBuckets([a, b, c, d, e], [], "stage")
    expect(out.get("open")?.map((i) => i.id)).toEqual([a.id, c.id])
    expect(out.get("won")?.map((i) => i.id)).toEqual([b.id])
    expect(out.get("")?.map((i) => i.id)).toEqual([d.id, e.id])
  })

  it("applies the condition filter and takes the first value of a multi enum", () => {
    const a = inst({ stage: ["open", "won"], region: "eu" })
    const b = inst({ stage: "open", region: "us" })
    const c = inst({ stage: [], region: "eu" }) // empty list = unset
    const out = kanbanBuckets([a, b, c], [{ field: "region", op: "eq", value: "eu" }], "stage")
    expect(out.get("open")?.map((i) => i.id)).toEqual([a.id])
    expect(out.get("")?.map((i) => i.id)).toEqual([c.id])
    expect(out.has("won")).toBe(false)
  })
})
