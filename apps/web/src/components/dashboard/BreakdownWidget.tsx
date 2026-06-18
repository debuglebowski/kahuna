import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { api, type DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { formatWidgetNumber } from "@/lib/dashboards"
import { cn } from "@/lib/utils"
import {
  collapseOther,
  groupBy,
  groupSeries,
  LABELS_KEY,
  OTHER_KEY,
  sortBuckets,
} from "@/lib/widgetAggregations"

type Breakdown = Extract<DashboardWidget, { type: "breakdown" }>

const DAY_MS = 86_400_000

// A small, theme-agnostic categorical palette (recharts + the CSS variants need
// explicit colors).
const PALETTE = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#a3a3a3",
]
const colorAt = (i: number) => PALETTE[i % PALETTE.length]

interface Row {
  readonly key: string
  readonly name: string
  readonly value: number
}

const pctText = (v: number, total: number) => `${total > 0 ? Math.round((v / total) * 100) : 0}%`

/** A value label honouring the widget's `values` setting (with a per-variant
 *  default — the text variants always want *some* number beside the bar). */
const valueText = (v: number, total: number, mode: "count" | "percent" | "both") =>
  mode === "percent"
    ? pctText(v, total)
    : mode === "both"
      ? `${v} (${pctText(v, total)})`
      : String(v)

/** Group instances by an enum field or by label, then render as one of six
 *  presentations. Lazy-loaded by the canvas so dashboards without charts don't
 *  pay recharts' bundle cost. */
export function BreakdownWidget({
  widget,
  data,
}: {
  widget: Breakdown
  data: ConceptInstanceData | undefined
}) {
  // Resolve label ids → names when grouping by label.
  const byLabel = widget.groupBy === LABELS_KEY
  const labelsQ = useQuery({
    queryKey: ["labels"],
    queryFn: () => api.listLabels(),
    enabled: byLabel,
  })
  const labelName = useMemo(() => {
    const m = new Map((labelsQ.data ?? []).map((l) => [l.id, l.name] as const))
    return (id: string) => m.get(id) ?? id
  }, [labelsQ.data])

  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const rows = useMemo<Row[]>(() => {
    if (!widget.conceptId || !widget.groupBy) return []
    const buckets = groupBy(data?.instances ?? [], widget.conditions, widget.groupBy, {
      match: widget.match,
      me,
    })
    // sort=field follows the enum's configured option order (labels/users have
    // no configured order — sortBuckets falls back to label order for them).
    const order = data?.fields.find((f) => f.id === widget.groupBy)?.config.options
    const sorted = sortBuckets(buckets, widget.sort ?? "count", {
      labelOf: byLabel ? labelName : undefined,
      order,
    })
    return collapseOther(sorted, widget.maxGroups).map((b) => ({
      key: b.key,
      name: b.key === OTHER_KEY ? "Other" : byLabel ? labelName(b.key) : b.key,
      value: b.count,
    }))
  }, [
    data?.instances,
    data?.fields,
    widget.conceptId,
    widget.groupBy,
    widget.conditions,
    widget.match,
    widget.sort,
    widget.maxGroups,
    me,
    byLabel,
    labelName,
  ])

  // Table trend/delta: per-group count series across the chosen window. `now` is
  // mount-stable so resize re-renders don't re-sample (mirrors MetricWidget).
  const now = useMemo(() => Date.now(), [])
  const wantsSeries = widget.chart === "table" && widget.delta != null && widget.delta !== "off"
  const seriesDays = widget.delta === "30d" ? 30 : 7
  const series = useMemo(() => {
    if (!wantsSeries || !widget.conceptId || !widget.groupBy) return null
    return groupSeries(
      data?.instances ?? [],
      widget.conditions,
      widget.groupBy,
      now - seriesDays * DAY_MS,
      now,
      Math.min(seriesDays + 1, 10),
      { match: widget.match, me },
    )
  }, [
    wantsSeries,
    seriesDays,
    data?.instances,
    widget.conditions,
    widget.groupBy,
    widget.conceptId,
    widget.match,
    now,
    me,
  ])

  if (!widget.conceptId || !widget.groupBy)
    return <p className="text-sm text-muted-foreground">Pick a concept and a group-by.</p>
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>

  const total = rows.reduce((s, r) => s + r.value, 0)

  if (widget.chart === "table")
    return <BreakdownTable rows={rows} total={total} series={series} days={seriesDays} />
  if (widget.chart === "bars-h")
    return <RankedBars rows={rows} total={total} values={widget.values} />
  if (widget.chart === "stacked")
    return <CompositionBar rows={rows} total={total} values={widget.values} />
  if (widget.chart === "donut")
    return <DonutChart rows={rows} total={total} values={widget.values} />

  // ── recharts bar / pie (the originals) ─────────────────────────────────────
  const pct = (v: number) => pctText(v, total)
  const valueLabel =
    widget.values == null
      ? null
      : (v: number) =>
          widget.values === "count"
            ? String(v)
            : widget.values === "percent"
              ? pct(v)
              : `${v} (${pct(v)})`

  return (
    <div className="h-full w-full text-xs">
      <ResponsiveContainer width="100%" height="100%">
        {widget.chart === "pie" ? (
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="name" outerRadius="80%" innerRadius="45%">
              {rows.map((r, i) => (
                <Cell key={r.key} fill={colorAt(i)} />
              ))}
            </Pie>
            <Tooltip />
            <Legend
              formatter={
                valueLabel
                  ? (name: string, entry) => {
                      const v = (entry?.payload as { value?: number } | undefined)?.value
                      return v == null ? name : `${name} · ${valueLabel(v)}`
                    }
                  : undefined
              }
            />
          </PieChart>
        ) : (
          <BarChart data={rows} margin={{ top: 14, right: 8, bottom: 0, left: -16 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
            <Tooltip />
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
              {valueLabel && (
                <LabelList
                  dataKey="value"
                  position="top"
                  formatter={(v: unknown) => (typeof v === "number" ? valueLabel(v) : "")}
                  style={{ fontSize: 10 }}
                />
              )}
              {rows.map((r, i) => (
                <Cell key={r.key} fill={colorAt(i)} />
              ))}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

/** #1 Ranked bars: one horizontal row per group (label · bar · value), already
 *  sorted/collapsed upstream. Beats vertical bars for long labels / many groups. */
function RankedBars({
  rows,
  total,
  values,
}: {
  rows: Row[]
  total: number
  values?: "count" | "percent" | "both"
}) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  const mode = values ?? "count"
  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-auto text-xs">
      {rows.map((r, i) => (
        <div key={r.key} className="flex items-center gap-2">
          <div className="w-24 shrink-0 truncate text-muted-foreground" title={r.name}>
            {r.name}
          </div>
          <div className="relative h-4 min-w-0 flex-1 rounded-sm bg-muted/40">
            <div
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `${(r.value / max) * 100}%`, background: colorAt(i) }}
            />
          </div>
          <div className="w-16 shrink-0 text-right tabular-nums text-foreground">
            {valueText(r.value, total, mode)}
          </div>
        </div>
      ))}
    </div>
  )
}

/** #3 Composition bar: one full-width 100%-stacked bar + legend. The most compact
 *  form — proportions at a glance in a short, wide tile. */
function CompositionBar({
  rows,
  total,
  values,
}: {
  rows: Row[]
  total: number
  values?: "count" | "percent" | "both"
}) {
  const mode = values ?? "percent"
  return (
    <div className="flex h-full w-full flex-col justify-center gap-3 text-xs">
      <div className="flex h-7 w-full overflow-hidden rounded-md">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="h-full min-w-0"
            title={`${r.name} · ${valueText(r.value, total, "both")}`}
            style={{ width: `${total > 0 ? (r.value / total) * 100 : 0}%`, background: colorAt(i) }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {rows.map((r, i) => (
          <li key={r.key} className="flex min-w-0 items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: colorAt(i) }} />
            <span className="truncate text-foreground">{r.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {valueText(r.value, total, mode)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** #2 Donut: recharts ring with the total in the hole and a custom side legend
 *  (kept out of recharts so the centre label stays centred on the ring). */
function DonutChart({
  rows,
  total,
  values,
}: {
  rows: Row[]
  total: number
  values?: "count" | "percent" | "both"
}) {
  const mode = values ?? "count"
  return (
    <div className="flex h-full w-full items-center gap-3 text-xs">
      <div className="relative h-full min-w-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="90%"
              paddingAngle={1}
              stroke="none"
            >
              {rows.map((r, i) => (
                <Cell key={r.key} fill={colorAt(i)} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {formatWidgetNumber(total)}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">total</span>
        </div>
      </div>
      <ul className="flex max-h-full shrink-0 flex-col gap-1 overflow-auto pr-1">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorAt(i) }} />
            <span className="max-w-28 truncate text-foreground">{r.name}</span>
            <span className="ml-auto pl-2 tabular-nums text-muted-foreground">
              {valueText(r.value, total, mode)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A tiny inline trend line for a breakdown-table row (same shape as the Metric
 *  sparkline). Flat series render as a centred line. */
function MiniSpark({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const last = values.length - 1
  const pts = values
    .map(
      (v, i) => `${((i / last) * 100).toFixed(1)},${(100 - ((v - min) / span) * 100).toFixed(1)}`,
    )
    .join(" ")
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-4 w-16 overflow-visible text-primary"
      aria-hidden="true"
      role="img"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function DeltaText({ diff }: { diff: number }) {
  const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0
  return (
    <span
      className={cn(
        "tabular-nums",
        dir > 0 ? "text-success" : dir < 0 ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {dir > 0 ? "▲ " : dir < 0 ? "▼ " : ""}
      {diff > 0 ? "+" : ""}
      {formatWidgetNumber(diff)}
    </span>
  )
}

/** #4 Breakdown table: label · count · share, plus an optional trend sparkline +
 *  window delta (created-at based, like the Metric delta) when `series` is set. */
function BreakdownTable({
  rows,
  total,
  series,
  days,
}: {
  rows: Row[]
  total: number
  series: Map<string, number[]> | null
  days: number
}) {
  const showTrend = series != null
  return (
    <div className="h-full w-full overflow-auto text-xs">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-[11px] text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Group</th>
            <th className="px-2 py-1 text-right font-medium">Count</th>
            <th className="px-2 py-1 text-right font-medium">Share</th>
            {showTrend && <th className="px-2 py-1 font-medium">Trend</th>}
            {showTrend && <th className="py-1 pl-2 text-right font-medium">{`Δ ${days}d`}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const s = series?.get(r.key)
            const diff = s && s.length >= 2 ? (s.at(-1) ?? 0) - (s[0] ?? 0) : null
            return (
              <tr key={r.key} className="border-b border-border/50">
                <td className="py-1 pr-2">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: colorAt(i) }}
                    />
                    <span className="truncate" title={r.name}>
                      {r.name}
                    </span>
                  </span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-foreground">{r.value}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                  {pctText(r.value, total)}
                </td>
                {showTrend && <td className="px-2 py-1">{s ? <MiniSpark values={s} /> : null}</td>}
                {showTrend && (
                  <td className="py-1 pl-2 text-right">
                    {diff == null ? (
                      <span className="text-muted-foreground">–</span>
                    ) : (
                      <DeltaText diff={diff} />
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td className="py-1 pr-2">Total</td>
            <td className="px-2 py-1 text-right tabular-nums">{total}</td>
            <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">100%</td>
            {showTrend && <td />}
            {showTrend && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
