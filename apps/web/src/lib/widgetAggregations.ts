import { LABELS_KEY } from "../../rpc/contract"
import type { Instance, SidebarCondition } from "./api"

export { LABELS_KEY }

/**
 * Pure aggregation helpers for dashboard widgets. No React / DOM — kept
 * unit-testable like `routeEnvelope`. Widget components feed already-loaded
 * instances in; these reduce them to numbers/series.
 */

export const labelsOf = (state: Record<string, unknown>): string[] =>
  Array.isArray(state[LABELS_KEY]) ? (state[LABELS_KEY] as string[]) : []

/** All conditions AND-combined. `eq` = field value equals (or array contains);
 *  `hasLabel` = instance carries the label id. Mirrors the sidebar's matcher. */
export const matchInstance = (inst: Instance, conds: readonly SidebarCondition[]): boolean =>
  conds.every((c) => {
    if (c.op === "hasLabel") return labelsOf(inst.state).includes(String(c.value))
    const v = inst.state[c.field]
    return Array.isArray(v) ? v.includes(c.value) : v === c.value
  })

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
): number => instances.filter((i) => matchInstance(i, conds)).length

export const sumField = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  fieldId: string,
): number =>
  instances.reduce((acc, i) => {
    if (!matchInstance(i, conds)) return acc
    const n = toNumber(i.state[fieldId])
    return n == null ? acc : acc + n
  }, 0)

export const avgField = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  fieldId: string,
): number | null => {
  const nums = instances
    .filter((i) => matchInstance(i, conds))
    .map((i) => toNumber(i.state[fieldId]))
    .filter((n): n is number => n != null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export interface GroupBucket {
  readonly key: string
  readonly count: number
}

/** Group matching instances by a field id, or by label (`__labels` fans one
 *  bucket per label id; multi-value fields fan out too). Buckets sorted by count
 *  desc. Missing scalar values fall into a "—" bucket; no-label instances are
 *  skipped. Keys for label grouping are label ids (caller maps id → name). */
export const groupBy = (
  instances: readonly Instance[],
  conds: readonly SidebarCondition[],
  key: string,
): GroupBucket[] => {
  const counts = new Map<string, number>()
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const i of instances) {
    if (!matchInstance(i, conds)) continue
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
): number | null => {
  if (agg === "count") return countInstances(instances, conds)
  if (!fieldId) return null
  return agg === "sum" ? sumField(instances, conds, fieldId) : avgField(instances, conds, fieldId)
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
