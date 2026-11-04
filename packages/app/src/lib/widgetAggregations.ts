import { LABELS_KEY } from "@kahunalabs/contract"
import type { RecordVersion, SidebarCondition } from "./api"
import { labelsOf, type MatchOpts, matchRecordVersion } from "./conditions"

export { LABELS_KEY, labelsOf, matchRecordVersion }

/**
 * Pure aggregation helpers for dashboard widgets. No React / DOM — kept
 * unit-testable like `routeEnvelope`. Widget components feed already-loaded
 * record versions in; these reduce them to numbers/series. Condition matching lives
 * in `conditions.ts` (the evaluator shared with the concept list + sidebar).
 */

/** Coerce a stored field value to a finite number, else null (skips it). */
const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  // money fields store { amount, currency }.
  if (v && typeof v === "object" && "amount" in v)
    return toNumber((v as { amount: unknown }).amount)
  return null
}

export const countRecords = (
  recordVersions: readonly RecordVersion[],
  conds: readonly SidebarCondition[],
  opts?: MatchOpts,
): number => recordVersions.filter((i) => matchRecordVersion(i, conds, opts)).length

export const sumField = (
  recordVersions: readonly RecordVersion[],
  conds: readonly SidebarCondition[],
  fieldId: string,
  opts?: MatchOpts,
): number =>
  recordVersions.reduce((acc, i) => {
    if (!matchRecordVersion(i, conds, opts)) return acc
    const n = toNumber(i.state[fieldId])
    return n == null ? acc : acc + n
  }, 0)

export const avgField = (
  recordVersions: readonly RecordVersion[],
  conds: readonly SidebarCondition[],
  fieldId: string,
  opts?: MatchOpts,
): number | null => {
  const nums = recordVersions
    .filter((i) => matchRecordVersion(i, conds, opts))
    .map((i) => toNumber(i.state[fieldId]))
    .filter((n): n is number => n != null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export type Agg = "count" | "sum" | "avg"

/** A group's tally. `sum`/`n` are present only when grouped with a measure
 *  field: `sum` totals its numeric values, `n` counts the records that had one
 *  (the avg denominator — a blank amount is skipped, not a zero). */
export interface GroupBucket {
  readonly key: string
  readonly count: number
  readonly sum?: number
  readonly n?: number
}

/** A bucket's measured value. `null` = avg over no numeric values. */
export const bucketValue = (b: GroupBucket, agg: Agg = "count"): number | null => {
  if (agg === "count") return b.count
  if (agg === "sum") return b.sum ?? 0
  return b.n ? (b.sum ?? 0) / b.n : null
}

/** Distinct currency codes stored on a money field's values (first-seen order).
 *  Empty for non-money fields. More than one = a sum mixes currencies. */
export const currenciesOf = (
  recordVersions: readonly RecordVersion[],
  fieldId: string,
): string[] => {
  const out = new Set<string>()
  for (const i of recordVersions) {
    const v = i.state[fieldId]
    for (const x of Array.isArray(v) ? v : [v]) {
      const c = x && typeof x === "object" ? (x as { currency?: unknown }).currency : null
      if (typeof c === "string" && c) out.add(c.toUpperCase())
    }
  }
  return [...out]
}

/** Synthetic bucket key for the collapsed "Other" tail (see `collapseOther`). */
export const OTHER_KEY = "__other"

/** Re-order breakdown buckets: by value (input order), by display label, or by
 *  a field's configured option order (unknown keys keep label order, at the
 *  end). `labelOf` maps a bucket key to its display name. */
export const sortBuckets = (
  buckets: ReadonlyArray<GroupBucket>,
  sort: "count" | "label" | "field",
  opts?: { labelOf?: (key: string) => string; order?: ReadonlyArray<string> },
): GroupBucket[] => {
  if (sort === "count") return [...buckets]
  const labelOf = opts?.labelOf ?? ((k: string) => k)
  const byLabel = (a: GroupBucket, b: GroupBucket) => labelOf(a.key).localeCompare(labelOf(b.key))
  if (sort === "label") return [...buckets].sort(byLabel)
  const pos = new Map((opts?.order ?? []).map((k, i) => [k, i] as const))
  return [...buckets].sort((a, b) => {
    const pa = pos.get(a.key)
    const pb = pos.get(b.key)
    if (pa != null && pb != null) return pa - pb
    if (pa != null) return -1
    if (pb != null) return 1
    return byLabel(a, b)
  })
}

/** Collapse the tail past `max` buckets into one "Other" bucket (OTHER_KEY).
 *  Non-positive/absent max, or nothing to collapse, returns the input as-is. */
export const collapseOther = (
  buckets: ReadonlyArray<GroupBucket>,
  max: number | null | undefined,
): GroupBucket[] => {
  if (!max || max <= 0 || buckets.length <= max) return [...buckets]
  const head = buckets.slice(0, max)
  const tail = buckets.slice(max)
  const count = tail.reduce((s, b) => s + b.count, 0)
  // Measured buckets fold sum + n (not values), so an avg "Other" is weighted.
  if (!tail.some((b) => b.sum != null)) return [...head, { key: OTHER_KEY, count }]
  const sum = tail.reduce((s, b) => s + (b.sum ?? 0), 0)
  const n = tail.reduce((s, b) => s + (b.n ?? 0), 0)
  return [...head, { key: OTHER_KEY, count, sum, n }]
}

/** The subset of record versions that already existed at `cutoffMs` — the baseline
 *  population for a metric's "vs N days ago" delta. Approximate by design:
 *  archived/deleted drift is invisible to a created-at cutoff. */
export const createdOnOrBefore = (
  recordVersions: readonly RecordVersion[],
  cutoffMs: number,
): RecordVersion[] => recordVersions.filter((i) => new Date(i.createdAt).getTime() <= cutoffMs)

/** What a breakdown measures per group: sum/avg of a number/money field.
 *  Absent (or agg count) = plain record counts. */
export interface GroupMeasure {
  readonly agg: Agg
  readonly fieldId: string
}

/** Group matching record versions by a field id, or by label (`__labels` fans one
 *  bucket per label id; multi-value fields fan out too — a record's amount then
 *  counts toward each of its groups). Buckets sorted by measured value desc
 *  (count without a measure; null avgs last). Missing scalar values fall into a
 *  "—" bucket; no-label record versions are skipped. Keys for label grouping are
 *  label ids (caller maps id → name). */
export const groupBy = (
  recordVersions: readonly RecordVersion[],
  conds: readonly SidebarCondition[],
  key: string,
  opts?: MatchOpts,
  measure?: GroupMeasure | null,
): GroupBucket[] => {
  const m = measure && measure.agg !== "count" && measure.fieldId ? measure : null
  const acc = new Map<string, { count: number; sum: number; n: number }>()
  const bump = (k: string, amount: number | null) => {
    const b = acc.get(k) ?? { count: 0, sum: 0, n: 0 }
    b.count++
    if (amount != null) {
      b.sum += amount
      b.n++
    }
    acc.set(k, b)
  }
  for (const i of recordVersions) {
    if (!matchRecordVersion(i, conds, opts)) continue
    const amount = m ? toNumber(i.state[m.fieldId]) : null
    if (key === LABELS_KEY) {
      for (const lid of labelsOf(i.state)) bump(lid, amount)
    } else {
      const v = i.state[key]
      const vals = Array.isArray(v) ? v : [v]
      for (const x of vals)
        bump(x === undefined || x === null || x === "" ? "—" : String(x), amount)
    }
  }
  const buckets: GroupBucket[] = [...acc.entries()].map(([k, b]) =>
    m ? { key: k, count: b.count, sum: b.sum, n: b.n } : { key: k, count: b.count },
  )
  const agg = m?.agg ?? "count"
  const val = (b: GroupBucket) => bucketValue(b, agg) ?? Number.NEGATIVE_INFINITY
  return buckets.sort((a, b) => val(b) - val(a))
}

/** Per-group value series across [fromMs, toMs] — the breakdown table's trend
 *  sparkline + delta. Created-at based, like `metricSeries`: at each evenly-spaced
 *  sample time it re-groups the record versions that already existed then. Every key
 *  that ever appears gets a full-length series (zero-filled for samples before it
 *  first shows up). The final sample lands on `toMs`, so each series' last value
 *  is the current count and `last − first` is the window's delta. `from`/`to` are
 *  passed in (not read from the clock) so this stays pure/testable; `points` is
 *  clamped to ≥ 2. */
export const groupSeries = (
  recordVersions: readonly RecordVersion[],
  conds: readonly SidebarCondition[],
  key: string,
  fromMs: number,
  toMs: number,
  points: number,
  opts?: MatchOpts,
  measure?: GroupMeasure | null,
): Map<string, number[]> => {
  const n = Math.max(2, Math.floor(points))
  const step = (toMs - fromMs) / (n - 1)
  const series = new Map<string, number[]>()
  const agg = measure?.agg ?? "count"
  for (let i = 0; i < n; i++) {
    const cutoff = i === n - 1 ? toMs : fromMs + step * i
    const counts = new Map(
      groupBy(createdOnOrBefore(recordVersions, cutoff), conds, key, opts, measure).map((b) => [
        b.key,
        bucketValue(b, agg) ?? 0,
      ]),
    )
    // A key first seen at sample i was 0 for the i earlier samples.
    for (const k of counts.keys()) if (!series.has(k)) series.set(k, new Array(i).fill(0))
    for (const [k, arr] of series) arr.push(counts.get(k) ?? 0)
  }
  return series
}

/** Bucket matching record versions by an enum field's value for the Kanban board.
 *  Key "" collects unset values (the synthetic "no value" column); a `multiple`
 *  enum contributes its FIRST value (a card sits in exactly one column).
 *  Insertion order within a bucket preserves the input order. */
export const kanbanBuckets = (
  recordVersions: readonly RecordVersion[],
  conds: readonly SidebarCondition[],
  groupKey: string,
  opts?: MatchOpts,
): Map<string, RecordVersion[]> => {
  const buckets = new Map<string, RecordVersion[]>()
  for (const i of recordVersions) {
    if (!matchRecordVersion(i, conds, opts)) continue
    const v = i.state[groupKey]
    const first = Array.isArray(v) ? v[0] : v
    const key = first === undefined || first === null || first === "" ? "" : String(first)
    const list = buckets.get(key)
    if (list) list.push(i)
    else buckets.set(key, [i])
  }
  return buckets
}

/** Synthetic state key holding a record version's current computed bands, keyed by
 *  field id (the engine's decay-tick marker; mirror of `LABELS_KEY`). */
export const BANDS_KEY = "__bands"

/** A record version's current band for a computed field. Prefers the read-time
 *  decorated value (`state[fieldId].band|label`, always current) over the
 *  hourly `__bands` marker. Returns undefined when not computed yet. */
export const bandOf = (inst: RecordVersion, fieldId: string): string | undefined => {
  const v = inst.state[fieldId]
  if (v && typeof v === "object") {
    const o = v as { band?: unknown; label?: unknown }
    if (o.band != null) return String(o.band) // decay
    if (o.label != null) return String(o.label) // momentum
  }
  const marks = inst.state[BANDS_KEY]
  if (marks && typeof marks === "object") {
    const b = (marks as Record<string, unknown>)[fieldId]
    if (b != null) return String(b)
  }
  return undefined
}

/** Days-since for a decay field (drives the stale-queue ordering); else null. */
export const daysOf = (inst: RecordVersion, fieldId: string): number | null => {
  const v = inst.state[fieldId]
  if (v && typeof v === "object" && typeof (v as { days?: unknown }).days === "number") {
    return (v as { days: number }).days
  }
  return null
}

/** Count record versions per band for a computed field (decay or momentum). */
export const bandRollup = (
  recordVersions: readonly RecordVersion[],
  fieldId: string,
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const i of recordVersions) {
    const b = bandOf(i, fieldId)
    if (b) counts[b] = (counts[b] ?? 0) + 1
  }
  return counts
}

/** Record versions currently in one of `bands` for a computed field, most-stale first
 *  (highest decay `days`). The attention "needs a nudge" queue. */
export const staleRecords = (
  recordVersions: readonly RecordVersion[],
  fieldId: string,
  bands: readonly string[],
): RecordVersion[] => {
  const set = new Set(bands)
  return recordVersions
    .filter((i) => {
      const b = bandOf(i, fieldId)
      return b != null && set.has(b)
    })
    .sort((a, b) => (daysOf(b, fieldId) ?? 0) - (daysOf(a, fieldId) ?? 0))
}

/** Compute a Metric widget's value from loaded record versions. `null` = no data. */
export const metricValue = (
  recordVersions: readonly RecordVersion[],
  agg: "count" | "sum" | "avg",
  conds: readonly SidebarCondition[],
  fieldId?: string | null,
  opts?: MatchOpts,
): number | null => {
  if (agg === "count") return countRecords(recordVersions, conds, opts)
  if (!fieldId) return null
  return agg === "sum"
    ? sumField(recordVersions, conds, fieldId, opts)
    : avgField(recordVersions, conds, fieldId, opts)
}

/** A Metric sparkline series: the metric value sampled at `points` evenly-spaced
 *  times across [fromMs, toMs], each computed over the record versions that already
 *  existed at that time (created-at based — the same approximation as the
 *  "vs N days ago" delta). The final sample lands exactly on `toMs`. `from`/`to`
 *  are passed in (not read from the clock) so this stays pure/testable. `points`
 *  is clamped to ≥ 2; null samples count as 0 so the line is always continuous. */
export const metricSeries = (
  recordVersions: readonly RecordVersion[],
  agg: "count" | "sum" | "avg",
  conds: readonly SidebarCondition[],
  fieldId: string | null | undefined,
  fromMs: number,
  toMs: number,
  points: number,
  opts?: MatchOpts,
): number[] => {
  const n = Math.max(2, Math.floor(points))
  const step = (toMs - fromMs) / (n - 1)
  const series: number[] = []
  for (let i = 0; i < n; i++) {
    const cutoff = i === n - 1 ? toMs : fromMs + step * i
    series.push(
      metricValue(createdOnOrBefore(recordVersions, cutoff), agg, conds, fieldId, opts) ?? 0,
    )
  }
  return series
}

export interface TrendPoint {
  readonly bucket: string
  readonly count: number
}

const DAY_MS = 86_400_000
const floorDayUTC = (ms: number): number => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
const floorWeekUTC = (ms: number): number => {
  const day = floorDayUTC(ms)
  const dow = new Date(day).getUTCDay() // 0=Sun … 6=Sat
  return day - ((dow + 6) % 7) * DAY_MS // back to the Monday
}

/** Bucket events by day/week across [fromMs, toMs], zero-filling empty buckets so
 *  the trend line is continuous. Bucket keys are `YYYY-MM-DD` (the bucket start).
 *  `from`/`to` are passed in (not read from the clock) so this stays pure/testable. */
export const timeBucket = (
  events: ReadonlyArray<{ readonly occurredAt: Date | string | number }>,
  bucket: "day" | "week",
  fromMs: number,
  toMs: number,
): TrendPoint[] => {
  const step = bucket === "week" ? 7 * DAY_MS : DAY_MS
  const floor = bucket === "week" ? floorWeekUTC : floorDayUTC
  const counts = new Map<number, number>()
  for (let t = floor(fromMs); t <= floor(toMs); t += step) counts.set(t, 0)
  for (const e of events) {
    const ms = new Date(e.occurredAt).getTime()
    if (Number.isNaN(ms)) continue
    const b = floor(ms)
    if (counts.has(b)) counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, count]) => ({ bucket: new Date(t).toISOString().slice(0, 10), count }))
}

/** Days for a `since` token (Trend window). */
export const sinceDays = (since: "7d" | "30d" | "90d"): number =>
  since === "7d" ? 7 : since === "30d" ? 30 : 90
