import { useQuery } from "@tanstack/react-query"
import { Area, AreaChart, Bar, BarChart, Legend, Tooltip } from "recharts"
import {
  CHART_MARGIN,
  ChartAxes,
  ChartFrame,
  ChartGrid,
  DeltaHeader,
} from "@/components/dashboard/chartChrome"
import {
  AnalyticsQueryError,
  type AnalyticsSeries,
  api,
  type DashboardWidget,
  type RecordVersion,
} from "@/lib/api"

type Analytics = Extract<DashboardWidget, { type: "analytics" }>

/** Series colors, in assignment order (biggest series first — see `rowsToSeries`). */
const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7"]

const INTERVAL_LABEL: Record<Analytics["interval"], string> = {
  day: "day",
  week: "week",
  month: "month",
}

/** Bucket tick label — date-only, which reads fine at every interval. */
const tick = (t: string): string => {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : d.toISOString().slice(0, 10)
}

/**
 * Pivot the server's per-series points into recharts' row-per-bucket shape:
 * `[{ bucket, <seriesName>: value, … }]`. Buckets are the union across series,
 * sorted, with missing values filled 0 so lines/bars don't gap.
 */
const toRows = (
  series: ReadonlyArray<AnalyticsSeries>,
): ReadonlyArray<Record<string, string | number>> => {
  const buckets = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort()
  return buckets.map((t) => {
    const row: Record<string, string | number> = { bucket: tick(t) }
    for (const s of series) row[s.name] = s.points.find((p) => p.t === t)?.value ?? 0
    return row
  })
}

/** Prose for the error codes the analytics endpoint returns. */
const ERROR_COPY: Record<string, string> = {
  NO_POSTHOG_CONNECTION: "Connect PostHog in Settings → Integrations.",
  QUERY_REQUIRED: "This widget needs a query.",
  EMPTY_QUERY: "This widget needs a query.",
  SEMICOLON_NOT_ALLOWED: "Remove the semicolon — one statement per query.",
  BAD_QUERY_SHAPE: "The query must return columns aliased bucket and value (series is optional).",
  ANALYTICS_QUERY_INVALID: "The provider rejected this query.",
}

/**
 * A failed query, rendered where the chart would be — for a custom query this IS
 * the debugging surface, so the provider's own message (parse error with char
 * offsets, the columns that actually came back) is shown verbatim beneath it.
 */
function QueryError({ error }: { error: Error }) {
  const code = error.message
  const detail = error instanceof AnalyticsQueryError ? error.detail : null
  return (
    <div className="flex h-full w-full flex-col gap-1 overflow-auto">
      <p className="text-sm text-muted-foreground">
        {ERROR_COPY[code] ?? "Couldn't load analytics."}
      </p>
      {detail && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
          {detail}
        </pre>
      )}
    </div>
  )
}

/**
 * Aggregated product metrics from an external analytics provider (PostHog).
 * The only data-bound widget that doesn't read concept record versions — the server
 * runs the aggregation and returns named series. On a RECORD dashboard, an
 * optional `recordFilter` narrows the same query to the current record by
 * reading one of its field values and matching it against a provider property.
 * Lazy-loaded by the canvas so chart-less boards skip recharts.
 */
export function AnalyticsWidget({
  widget,
  record,
}: {
  widget: Analytics
  record?: { readonly recordVersion: RecordVersion }
}) {
  const filter = widget.recordFilter ?? null
  // Resolve the record's identifying value client-side; the endpoint stays
  // provider-facing and never reads the record version table.
  const rawValue = filter ? record?.recordVersion.state[filter.fieldId] : undefined
  const recordValue =
    rawValue == null ? null : typeof rawValue === "string" ? rawValue : String(rawValue)
  const showDelta = widget.showDelta ?? false
  const chart = widget.chart ?? "area"
  const custom = widget.metric === "custom"
  const query = widget.query?.trim() || null

  // A record-scoped widget can't resolve its value off a record dashboard (or
  // when the field is empty) — don't query, since the server would return empty.
  const unresolved = !!filter && !recordValue

  const q = useQuery({
    queryKey: [
      "analytics",
      widget.provider,
      widget.metric,
      widget.interval,
      widget.since,
      query,
      widget.event ?? null,
      widget.breakdown ?? null,
      filter?.property ?? null,
      recordValue,
      showDelta,
    ],
    enabled: !unresolved && (!custom || !!query),
    queryFn: () =>
      api.runAnalyticsQuery({
        provider: widget.provider,
        metric: widget.metric,
        interval: widget.interval,
        since: widget.since,
        query,
        event: widget.event ?? null,
        breakdown: widget.breakdown ?? null,
        recordProperty: filter?.property ?? null,
        recordValue,
        includePrior: showDelta,
      }),
  })

  if (custom && !query)
    return (
      <p className="text-sm text-muted-foreground">No query yet — edit the widget to add one.</p>
    )
  if (unresolved)
    return (
      <p className="text-sm text-muted-foreground">
        {record ? "This record has no value for the bound field." : "Shows on a record dashboard."}
      </p>
    )
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.error) return <QueryError error={q.error} />

  const series = q.data?.series ?? []
  const rows = toRows(series)
  const total = series.reduce((sum, s) => sum + s.points.reduce((a, p) => a + p.value, 0), 0)
  if (total === 0) return <p className="text-sm text-muted-foreground">No data in this window.</p>

  const delta = q.data?.delta ?? null

  if (chart === "table")
    return (
      <div className="h-full w-full overflow-auto text-xs">
        <table className="w-full">
          <thead className="sticky top-0 bg-background">
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">
                {/* A custom query buckets itself, so `interval` says nothing about it. */}
                {custom ? "Bucket" : `Per ${INTERVAL_LABEL[widget.interval]}`}
              </th>
              {series.map((s) => (
                <th key={s.name} className="py-1 pr-2 text-right font-medium">
                  {s.name === "value" ? "Value" : s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.bucket)} className="border-t border-border">
                <td className="py-1 pr-2 text-muted-foreground">{row.bucket}</td>
                {series.map((s) => (
                  <td key={s.name} className="py-1 pr-2 text-right tabular-nums">
                    {Number(row[s.name] ?? 0).toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )

  const multi = series.length > 1
  const margin = CHART_MARGIN
  const grid = <ChartGrid />
  const axes = <ChartAxes />

  const body =
    chart === "bars" ? (
      <BarChart data={rows} margin={margin}>
        {grid}
        {axes}
        <Tooltip />
        {multi && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {series.map((s, i) => (
          <Bar
            key={s.name}
            dataKey={s.name}
            stackId={multi ? "a" : undefined}
            fill={COLORS[i % COLORS.length]}
            radius={multi ? undefined : [2, 2, 0, 0]}
          />
        ))}
      </BarChart>
    ) : (
      <AreaChart data={rows} margin={margin}>
        {grid}
        {axes}
        <Tooltip />
        {multi && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {series.map((s, i) => (
          <Area
            key={s.name}
            type="monotone"
            dataKey={s.name}
            stackId={multi ? "a" : undefined}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            fill={COLORS[i % COLORS.length]}
            fillOpacity={0.15}
            dot={false}
          />
        ))}
      </AreaChart>
    )

  return (
    <ChartFrame
      header={delta && <DeltaHeader cur={delta.cur} prior={delta.prior} since={widget.since} />}
    >
      {body}
    </ChartFrame>
  )
}
