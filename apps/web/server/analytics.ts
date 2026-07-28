import { createHash } from "node:crypto"
import { posthogConnectionForOrg, posthogCtxFor, posthogRequest } from "./posthog"
import { resolveOrg } from "./session"

/**
 * Aggregated analytics queries for the `analytics` dashboard widget.
 *
 * The widget sends a STRUCTURED query (metric + interval + window + optional
 * event/breakdown/record filter); this module translates it into HogQL and runs
 * it through the existing PostHog request helper. Structured-in/series-out keeps
 * the provider's query language out of saved dashboard bodies, so adding a
 * second provider is a branch here rather than a new widget type.
 *
 * Results are cached in-process with a short TTL: a dashboard open in N tabs
 * would otherwise issue N identical queries against a rate-limited API.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

export type AnalyticsMetric = "active_users" | "event_count"
export type AnalyticsInterval = "day" | "week" | "month"
export type AnalyticsSince = "7d" | "30d" | "90d"

export type AnalyticsQuery = {
  readonly provider: "posthog"
  readonly metric: AnalyticsMetric
  readonly interval: AnalyticsInterval
  readonly since: AnalyticsSince
  readonly event?: string | null
  readonly breakdown?: string | null
  /** Provider property to match, paired with `recordValue` (record dashboards). */
  readonly recordProperty?: string | null
  /** The current record's already-resolved identifying value. */
  readonly recordValue?: string | null
  /** Also fetch the preceding window of the same length (for a % delta). */
  readonly includePrior?: boolean
}

export type SeriesPoint = { readonly t: string; readonly value: number }
export type Series = { readonly name: string; readonly points: ReadonlyArray<SeriesPoint> }
export type AnalyticsResult = {
  readonly series: ReadonlyArray<Series>
  /** Totals for the current vs preceding window; null when `includePrior` is off. */
  readonly delta: { readonly cur: number; readonly prior: number } | null
}

const SINCE_DAYS: Record<AnalyticsSince, number> = { "7d": 7, "30d": 30, "90d": 90 }

/** HogQL bucket expression per interval. */
const BUCKET_FN: Record<AnalyticsInterval, string> = {
  day: "toStartOfDay",
  week: "toStartOfWeek",
  month: "toStartOfMonth",
}

/** The aggregate under the bucket. */
const METRIC_EXPR: Record<AnalyticsMetric, string> = {
  active_users: "count(DISTINCT distinct_id)",
  event_count: "count()",
}

const DAY_MS = 86_400_000

// ── query construction ────────────────────────────────────────────────────────

/**
 * Build the HogQL text + params. Every caller-supplied value (event name,
 * breakdown property, record value, dates) is bound as a PARAM — never
 * interpolated — so a property named `x') OR 1=1 --` can't alter the query.
 * Only the metric/interval keys reach the SQL text, and both are closed unions
 * resolved through a lookup table above.
 */
export const buildPosthogQuery = (
  q: AnalyticsQuery,
  window: { readonly from: Date; readonly to: Date },
): { readonly query: string; readonly params: Record<string, unknown> } => {
  const bucket = `${BUCKET_FN[q.interval]}(timestamp)`
  const params: Record<string, unknown> = {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  }
  const where = [`timestamp >= {from} AND timestamp < {to}`]
  if (q.event) {
    where.push("event = {event}")
    params.event = q.event
  }
  if (q.recordProperty && q.recordValue) {
    // `properties.<name>` can't be a bound identifier in HogQL, so the property
    // name is indexed dynamically off the properties map instead.
    where.push("properties[{recordProperty}] = {recordValue}")
    params.recordProperty = q.recordProperty
    params.recordValue = q.recordValue
  }
  const selects = [`${bucket} AS bucket`, `${METRIC_EXPR[q.metric]} AS value`]
  const groups = ["bucket"]
  if (q.breakdown) {
    selects.push("properties[{breakdown}] AS series")
    groups.push("series")
    params.breakdown = q.breakdown
  }
  const query = [
    `SELECT ${selects.join(", ")}`,
    "FROM events",
    `WHERE ${where.join(" AND ")}`,
    `GROUP BY ${groups.join(", ")}`,
    "ORDER BY bucket",
    "LIMIT 10000",
  ].join(" ")
  return { query, params }
}

type HogQLResponse = { results?: unknown[][]; columns?: string[] }

/** Column index by name, falling back to positional order. */
const colIdx = (cols: string[] | undefined, name: string, fallback: number): number => {
  const i = (cols ?? []).indexOf(name)
  return i === -1 ? fallback : i
}

/** Shape raw HogQL rows into named series. Rows are `[bucket, value, series?]`. */
export const rowsToSeries = (data: HogQLResponse, hasBreakdown: boolean): ReadonlyArray<Series> => {
  const bi = colIdx(data.columns, "bucket", 0)
  const vi = colIdx(data.columns, "value", 1)
  const si = colIdx(data.columns, "series", 2)
  const byName = new Map<string, SeriesPoint[]>()
  for (const row of data.results ?? []) {
    const rawBucket = row[bi]
    const t =
      rawBucket instanceof Date
        ? rawBucket.toISOString()
        : typeof rawBucket === "string"
          ? rawBucket
          : null
    if (!t) continue
    const name = hasBreakdown ? String(row[si] ?? "—") || "—" : "value"
    const points = byName.get(name) ?? []
    points.push({ t, value: Number(row[vi]) || 0 })
    byName.set(name, points)
  }
  return (
    [...byName.entries()]
      .map(([name, points]) => ({ name, points }))
      // Biggest series first so the chart's dominant band is the legend's first entry.
      .sort((a, b) => sumPoints(b.points) - sumPoints(a.points))
  )
}

const sumPoints = (points: ReadonlyArray<SeriesPoint>): number =>
  points.reduce((sum, p) => sum + p.value, 0)

// ── cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = Number(process.env.ANALYTICS_CACHE_TTL_MS ?? 60_000)
const cache = new Map<string, { at: number; value: AnalyticsResult }>()

/**
 * Cache key. MUST include the org AND the resolved record value — keying on the
 * query config alone would serve one record's numbers for another record's
 * widget (and one org's for another's).
 */
const cacheKeyFor = (orgId: string, q: AnalyticsQuery): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        orgId,
        q.provider,
        q.metric,
        q.interval,
        q.since,
        q.event ?? null,
        q.breakdown ?? null,
        q.recordProperty ?? null,
        q.recordValue ?? null,
        q.includePrior ?? false,
      ]),
    )
    .digest("base64url")

export const clearAnalyticsCacheForTest = () => cache.clear()

// ── execution ─────────────────────────────────────────────────────────────────

const runHogQL = async (
  ctx: { host: string; apiKey: string },
  projectId: string,
  built: { query: string; params: Record<string, unknown> },
): Promise<HogQLResponse> =>
  posthogRequest<HogQLResponse>(ctx, `/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    body: JSON.stringify({
      query: { kind: "HogQLQuery", query: built.query, values: built.params },
    }),
  })

/** Run a structured query for an org, honoring the TTL cache. */
export const runAnalyticsQuery = async (
  orgId: string,
  q: AnalyticsQuery,
): Promise<AnalyticsResult | { readonly error: string }> => {
  const key = cacheKeyFor(orgId, q)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const connection = await posthogConnectionForOrg(orgId)
  if (!connection) return { error: "NO_POSTHOG_CONNECTION" }
  const ctx = posthogCtxFor(connection)

  const days = SINCE_DAYS[q.since]
  const to = new Date()
  const from = new Date(to.getTime() - days * DAY_MS)
  const data = await runHogQL(ctx, connection.projectId, buildPosthogQuery(q, { from, to }))
  const series = rowsToSeries(data, !!q.breakdown)

  let delta: AnalyticsResult["delta"] = null
  if (q.includePrior) {
    const priorTo = from
    const priorFrom = new Date(from.getTime() - days * DAY_MS)
    // Prior-window totals only — drop the breakdown so this is a single cheap row.
    const priorData = await runHogQL(
      ctx,
      connection.projectId,
      buildPosthogQuery({ ...q, breakdown: null }, { from: priorFrom, to: priorTo }),
    )
    const priorSeries = rowsToSeries(priorData, false)
    delta = {
      cur: series.reduce((sum, s) => sum + sumPoints(s.points), 0),
      prior: priorSeries.reduce((sum, s) => sum + sumPoints(s.points), 0),
    }
  }

  const value: AnalyticsResult = { series, delta }
  cache.set(key, { at: Date.now(), value })
  return value
}

// ── HTTP surface ──────────────────────────────────────────────────────────────

const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null

/**
 * `POST /api/integrations/analytics/query` — the widget's data endpoint. The
 * client resolves its record value before calling, so this stays provider-facing
 * and never reads the instance table.
 */
export async function queryAnalytics(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return json({ error: "INVALID_BODY" }, 400)

  const metric = oneOf<AnalyticsMetric>(body.metric, ["active_users", "event_count"])
  const interval = oneOf<AnalyticsInterval>(body.interval, ["day", "week", "month"])
  const since = oneOf<AnalyticsSince>(body.since, ["7d", "30d", "90d"])
  if (!metric || !interval || !since) return json({ error: "INVALID_QUERY" }, 400)
  if (body.provider !== undefined && body.provider !== "posthog")
    return json({ error: "UNSUPPORTED_PROVIDER" }, 400)

  const q: AnalyticsQuery = {
    provider: "posthog",
    metric,
    interval,
    since,
    event: asString(body.event),
    breakdown: asString(body.breakdown),
    recordProperty: asString(body.recordProperty),
    recordValue: asString(body.recordValue),
    includePrior: body.includePrior === true,
  }
  // A record-scoped widget whose record has no value for the bound field would
  // otherwise silently widen to the whole org.
  if (q.recordProperty && !q.recordValue) return json({ series: [], delta: null })

  try {
    const result = await runAnalyticsQuery(org.orgId, q)
    if ("error" in result) return json(result, 404)
    return json(result)
  } catch (error) {
    return json({ error: "ANALYTICS_QUERY_FAILED", detail: String(error) }, 502)
  }
}
