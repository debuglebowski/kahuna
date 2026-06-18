import { LABELS_KEY } from "../../rpc/contract"
import type { Instance, SidebarCondition } from "./api"
import { labelsOf, type MatchOpts, matchInstance } from "./conditions"

export { LABELS_KEY, labelsOf, matchInstance }

/**
 * Pure aggregation helpers for dashboard widgets. No React / DOM — kept
 * unit-testable like `routeEnvelope`. Widget components feed already-loaded
 * instances in; these reduce them to numbers/series. Condition matching lives
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

export const countInstances = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  opts?: MatchOpts,
): number => instances.filter((i) => matchInstance(i, conds, opts)).length

export const sumField = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  fieldId: string,
  opts?: MatchOpts,
): number =>
  instances.reduce((acc, i) => {
    if (!matchInstance(i, conds, opts)) return acc
    const n = toNumber(i.state[fieldId])
    return n == null ? acc : acc + n
  }, 0)

export const avgField = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  fieldId: string,
  opts?: MatchOpts,
): number | null => {
  const nums = instances
    .filter((i) => matchInstance(i, conds, opts))
    .map((i) => toNumber(i.state[fieldId]))
    .filter((n): n is number => n != null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export interface GroupBucket {
  readonly key: string
  readonly count: number
}

/** Synthetic bucket key for the collapsed "Other" tail (see `collapseOther`). */
export const OTHER_KEY = "__other"

/** Re-order breakdown buckets: by count (input order), by display label, or by
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
  const rest = buckets.slice(max).reduce((s, b) => s + b.count, 0)
  return [...head, { key: OTHER_KEY, count: rest }]
}

/** The subset of instances that already existed at `cutoffMs` — the baseline
 *  population for a metric's "vs N days ago" delta. Approximate by design:
 *  archived/deleted drift is invisible to a created-at cutoff. */
export const createdOnOrBefore = (instances: readonly Instance[], cutoffMs: number): Instance[] =>
  instances.filter((i) => new Date(i.createdAt).getTime() <= cutoffMs)

/** Group matching instances by a field id, or by label (`__labels` fans one
 *  bucket per label id; multi-value fields fan out too). Buckets sorted by count
 *  desc. Missing scalar values fall into a "—" bucket; no-label instances are
 *  skipped. Keys for label grouping are label ids (caller maps id → name). */
export const groupBy = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  key: string,
  opts?: MatchOpts,
): GroupBucket[] => {
  const counts = new Map<string, number>()
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const i of instances) {
    if (!matchInstance(i, conds, opts)) continue
    if (key === LABELS_KEY) {
      for (const lid of labelsOf(i.state)) bump(lid)
    } else {
      const v = i.state[key]
      const vals = Array.isArray(v) ? v : [v]
      for (const x of vals) bump(x === undefined || x === null || x === "" ? "—" : String(x))
    }
  }
  return [...counts.entries()]
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count)
}

/** Bucket matching instances by an enum field's value for the Kanban board.
 *  Key "" collects unset values (the synthetic "no value" column); a `multiple`
 *  enum contributes its FIRST value (a card sits in exactly one column).
 *  Insertion order within a bucket preserves the input order. */
export const kanbanBuckets = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  groupKey: string,
  opts?: MatchOpts,
): Map<string, Instance[]> => {
  const buckets = new Map<string, Instance[]>()
  for (const i of instances) {
    if (!matchInstance(i, conds, opts)) continue
    const v = i.state[groupKey]
    const first = Array.isArray(v) ? v[0] : v
    const key = first === undefined || first === null || first === "" ? "" : String(first)
    const list = buckets.get(key)
    if (list) list.push(i)
    else buckets.set(key, [i])
  }
  return buckets
}

/** Synthetic state key holding an instance's current computed bands, keyed by
 *  field id (the engine's decay-tick marker; mirror of `LABELS_KEY`). */
export const BANDS_KEY = "__bands"

/** An instance's current band for a computed field. Prefers the read-time
 *  decorated value (`state[fieldId].band|label`, always current) over the
 *  hourly `__bands` marker. Returns undefined when not computed yet. */
export const bandOf = (inst: Instance, fieldId: string): string | undefined => {
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
export const daysOf = (inst: Instance, fieldId: string): number | null => {
  const v = inst.state[fieldId]
  if (v && typeof v === "object" && typeof (v as { days?: unknown }).days === "number") {
    return (v as { days: number }).days
  }
  return null
}

/** Count instances per band for a computed field (decay or momentum). */
export const bandRollup = (
  instances: readonly Instance[],
  fieldId: string,
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const i of instances) {
    const b = bandOf(i, fieldId)
    if (b) counts[b] = (counts[b] ?? 0) + 1
  }
  return counts
}

/** Instances currently in one of `bands` for a computed field, most-stale first
 *  (highest decay `days`). The attention "needs a nudge" queue. */
export const staleInstances = (
  instances: readonly Instance[],
  fieldId: string,
  bands: readonly string[],
): Instance[] => {
  const set = new Set(bands)
  return instances
    .filter((i) => {
      const b = bandOf(i, fieldId)
      return b != null && set.has(b)
    })
    .sort((a, b) => (daysOf(b, fieldId) ?? 0) - (daysOf(a, fieldId) ?? 0))
}

/** Compute a Metric widget's value from loaded instances. `null` = no data. */
export const metricValue = (
  instances: readonly Instance[],
  agg: "count" | "sum" | "avg",
  conds: readonly SidebarCondition[],
  fieldId?: string | null,
  opts?: MatchOpts,
): number | null => {
  if (agg === "count") return countInstances(instances, conds, opts)
  if (!fieldId) return null
  return agg === "sum"
    ? sumField(instances, conds, fieldId, opts)
    : avgField(instances, conds, fieldId, opts)
}

/** A Metric sparkline series: the metric value sampled at `points` evenly-spaced
 *  times across [fromMs, toMs], each computed over the instances that already
 *  existed at that time (created-at based — the same approximation as the
 *  "vs N days ago" delta). The final sample lands exactly on `toMs`. `from`/`to`
 *  are passed in (not read from the clock) so this stays pure/testable. `points`
 *  is clamped to ≥ 2; null samples count as 0 so the line is always continuous. */
export const metricSeries = (
  instances: readonly Instance[],
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
    series.push(metricValue(createdOnOrBefore(instances, cutoff), agg, conds, fieldId, opts) ?? 0)
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
