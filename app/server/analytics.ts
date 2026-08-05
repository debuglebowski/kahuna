import { createHash } from "node:crypto"
import { readIntegrationSettings } from "./integrationSettings"
import { connectorFailure } from "./integrations/errors"
import { posthogConnectionForOrg, posthogCtxFor, posthogRequest } from "./posthog"
import { resolveOrg } from "./session"

/**
 * Aggregated analytics queries for the `analytics` dashboard widget.
 *
 * Two shapes of the same request. Normally the widget sends a STRUCTURED query
 * (metric + interval + window + optional event/breakdown/record filter) and this
 * module translates it into HogQL — that keeps the provider's query language out
 * of saved dashboard bodies, so a second provider is a branch here rather than a
 * new widget type. `metric: "custom"` is the escape hatch: the caller's own
 * HogQL, bounded and shape-checked below, for the questions two metrics can't
 * ask. Both shapes return the same series contract.
 *
 * Results are cached in-process with a short TTL: a dashboard open in N tabs
 * would otherwise issue N identical queries against a rate-limited API.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

export type AnalyticsMetric = "active_users" | "event_count" | "custom"
export type AnalyticsInterval = "day" | "week" | "month"
export type AnalyticsSince = "7d" | "30d" | "90d"

export type AnalyticsQuery = {
  readonly provider: "posthog"
  readonly metric: AnalyticsMetric
  readonly interval: AnalyticsInterval
  readonly since: AnalyticsSince
  /** Caller-authored HogQL; read only when `metric` is "custom". */
  readonly query?: string | null
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

/** Metrics the server itself translates (i.e. everything but "custom"). */
export type StructuredMetric = Exclude<AnalyticsMetric, "custom">

/** The aggregate under the bucket. */
const METRIC_EXPR: Record<StructuredMetric, string> = {
  active_users: "count(DISTINCT distinct_id)",
  event_count: "count()",
}

const DAY_MS = 86_400_000

type Built = { readonly query: string; readonly params: Record<string, unknown> }
type Window = { readonly from: Date; readonly to: Date }

// ── query construction ────────────────────────────────────────────────────────

/**
 * Build the HogQL text + params. Every caller-supplied value (event name,
 * breakdown property, record value, dates) is bound as a PARAM — never
 * interpolated — so a property named `x') OR 1=1 --` can't alter the query.
 * Only the metric/interval keys reach the SQL text, and both are closed unions
 * resolved through a lookup table above.
 */
export const buildPosthogQuery = (
  q: AnalyticsQuery & { readonly metric: StructuredMetric },
  window: Window,
): Built => {
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

/** Rows the outer wrap lets through. Far above any sane bucket count, but it
 *  provably caps a `LIMIT 50000` written inside the caller's own query. */
const CUSTOM_ROW_LIMIT = 2000

/** A custom query the caller has to fix — a 400, never a 502. */
export class CustomQueryError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

/**
 * Wrap caller-authored HogQL so it can't outrun its bounds, and bind the same
 * window params the structured path uses.
 *
 * The provider's parser is the actual injection defense — it rejects stacked
 * statements and writes outright — so the job here is bounding the RESULT, not
 * sanitizing the text: an inner `LIMIT 50000` really does return 50 000 rows
 * unwrapped. `;` is rejected up front because it's the one thing that breaks the
 * wrap (`(<q>; -- x)` won't parse), and a named error beats a parse error the
 * user has to decode. The newlines around the subquery are load-bearing for the
 * same reason: a trailing `-- comment` would otherwise swallow the closing paren.
 */
export const buildCustomQuery = (q: AnalyticsQuery, window: Window): Built => {
  const raw = (q.query ?? "").trim().replace(/;+\s*$/, "")
  if (!raw) throw new CustomQueryError("EMPTY_QUERY")
  if (raw.includes(";")) throw new CustomQueryError("SEMICOLON_NOT_ALLOWED")
  const params: Record<string, unknown> = {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  }
  // Bound even when unreferenced (HogQL tolerates unused values); the widget's
  // own gate guarantees a record-scoped query never runs without a value.
  if (q.recordValue) params.recordValue = q.recordValue
  return { query: `SELECT * FROM (\n${raw}\n) LIMIT ${CUSTOM_ROW_LIMIT}`, params }
}

/** Columns `rowsToSeries` can shape. `series` is optional (single-series query). */
const REQUIRED_COLUMNS = ["bucket", "value"] as const

/**
 * A custom query that returns the wrong aliases used to render as "No data in
 * this window" — `rowsToSeries` drops every row whose bucket won't parse as a
 * date. Fail loudly instead, naming what came back so the fix is obvious.
 */
export const validateCustomShape = (columns: string[] | undefined): string | null => {
  const cols = columns ?? []
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c))
  return missing.length === 0 ? null : cols.join(", ") || "(no columns)"
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

const cache = new Map<string, { at: number; value: AnalyticsResult }>()

/**
 * Cache key. MUST include the org AND the resolved record value — keying on the
 * query config alone would serve one record's numbers for another record's
 * widget (and one org's for another's). Same rule covers the custom `query`
 * text: two custom widgets differ in nothing else.
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
        q.query ?? null,
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

/** Run a query for an org, honoring the TTL cache. */
export const runAnalyticsQuery = async (
  orgId: string,
  q: AnalyticsQuery,
): Promise<AnalyticsResult | { readonly error: string }> => {
  // The TTL is per-org, so it has to be resolved before the cache check. That
  // does NOT undo the deferral below: `readIntegrationSettings` memoizes the org
  // row for 30s, so on the warm path this is a Map lookup and touches no DB, and
  // the connection lookup still happens only on a miss.
  //
  // Rejected: stashing the TTL in the cache entry at write time. Free on hits,
  // but lowering the TTL then wouldn't take effect until the entry it governs
  // expired — a setting that doesn't apply until the thing it controls times out.
  const ttlMs = (await readIntegrationSettings(orgId)).analyticsCacheTtlMs
  const key = cacheKeyFor(orgId, q)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value

  const custom = q.metric === "custom"
  // Fail on an unusable query before spending a connection lookup on it.
  if (custom) buildCustomQuery(q, { from: new Date(0), to: new Date(0) })

  const connection = await posthogConnectionForOrg(orgId)
  if (!connection) return { error: "NO_POSTHOG_CONNECTION" }
  const ctx = posthogCtxFor(connection)

  const days = SINCE_DAYS[q.since]
  const to = new Date()
  const from = new Date(to.getTime() - days * DAY_MS)
  // `dropBreakdown` collapses the structured query to one cheap row for the
  // prior-window total. It can't apply to a custom query — we won't rewrite the
  // caller's SQL — so that prior run is the same query over a shifted window.
  const build = (w: Window, dropBreakdown = false): Built =>
    custom
      ? buildCustomQuery(q, w)
      : buildPosthogQuery(
          {
            ...q,
            metric: q.metric as StructuredMetric,
            breakdown: dropBreakdown ? null : q.breakdown,
          },
          w,
        )

  const data = await runHogQL(ctx, connection.projectId, build({ from, to }))
  if (custom) {
    const got = validateCustomShape(data.columns)
    if (got !== null) throw new CustomQueryError("BAD_QUERY_SHAPE", got)
  }
  // A custom query buckets and splits itself, so its series count comes from
  // whether it actually returned a `series` column.
  const series = rowsToSeries(
    data,
    custom ? (data.columns ?? []).includes("series") : !!q.breakdown,
  )

  let delta: AnalyticsResult["delta"] = null
  if (q.includePrior) {
    const priorTo = from
    const priorFrom = new Date(from.getTime() - days * DAY_MS)
    const priorData = await runHogQL(
      ctx,
      connection.projectId,
      build({ from: priorFrom, to: priorTo }, true),
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
 * and never reads the record version table.
 */
export async function queryAnalytics(req: Request) {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return json({ error: "INVALID_BODY" }, 400)

  const metric = oneOf<AnalyticsMetric>(body.metric, ["active_users", "event_count", "custom"])
  const interval = oneOf<AnalyticsInterval>(body.interval, ["day", "week", "month"])
  const since = oneOf<AnalyticsSince>(body.since, ["7d", "30d", "90d"])
  if (!metric || !interval || !since) return json({ error: "INVALID_QUERY" }, 400)
  if (body.provider !== undefined && body.provider !== "posthog")
    return json({ error: "UNSUPPORTED_PROVIDER" }, 400)
  const query = asString(body.query)
  if (metric === "custom" && !query) return json({ error: "QUERY_REQUIRED" }, 400)
  // NOTE (accepted risk, deliberate): `metric: "custom"` runs arbitrary
  // caller-authored HogQL on the ORG's PostHog key, and is open to any member.
  // A gate was tried and reverted — it renders a custom-analytics widget empty
  // for non-admins, because the query runs at render time. Revisit with the read
  // model, which can instead allow a custom query only when it matches a saved
  // dashboard body the caller is already permitted to see.
  const q: AnalyticsQuery = {
    provider: "posthog",
    metric,
    interval,
    since,
    query,
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
    // Rejected before or after the provider call, by our own rules.
    if (error instanceof CustomQueryError)
      return json({ error: error.code, detail: error.detail ?? null }, 400)
    // A provider 400 on a custom query is the author's mistake, not an outage —
    // and HogQL's message (with char offsets) is the only debugging aid they
    // have, so pass it through as a 400 rather than burying it in a 502.
    const status = (error as { status?: number }).status
    if (q.metric === "custom" && status === 400)
      return json({ error: "ANALYTICS_QUERY_INVALID", detail: providerMessage(error) }, 400)
    return json(
      {
        error: "ANALYTICS_QUERY_FAILED",
        detail: connectorFailure("posthog", "analytics.query", error),
      },
      502,
    )
  }
}

/**
 * The human-readable part of a PostHog error. `posthogRequest` throws
 * `PostHog API 400: <raw body>`, where the body is usually
 * `{"type":"validation_error","detail":"Global variable not found: nope"}`.
 */
const providerMessage = (error: unknown): string => {
  const raw = String((error as Error)?.message ?? error)
  const at = raw.indexOf(": ")
  const body = at === -1 ? raw : raw.slice(at + 2)
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return body || raw
}
