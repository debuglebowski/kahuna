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
import type { ConceptRecordData } from "@/lib/conceptData"
import { formatWidgetNumber } from "@/lib/dashboards"
import { useOrgSettings } from "@/lib/orgSettings"
import { cn } from "@/lib/utils"
import {
  bucketValue,
  collapseOther,
  currenciesOf,
  groupBy,
  groupSeries,
  LABELS_KEY,
  matchRecordVersion,
  metricValue,
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
  /** The measured value (0 for an avg over no numbers — `blank` marks it). */
  readonly value: number
  readonly blank?: boolean
}

/** How a breakdown prints its numbers: the full value, a compact axis tick, and
 *  whether a share-of-total means anything (it doesn't for averages). */
interface Fmt {
  readonly full: (n: number) => string
  readonly axis: (n: number) => string
  readonly share: boolean
}

const COUNT_FMT: Fmt = {
  full: (n) => formatWidgetNumber(n),
  axis: (n) => n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 }),
  share: true,
}

/** Currency formatting for a money measure; an unknown code degrades to plain. */
const moneyFmt = (currency: string, share: boolean): Fmt => {
  const nf = (o: Intl.NumberFormatOptions) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, ...o })
    } catch {
      return null
    }
  }
  const full = nf({ minimumFractionDigits: 0, maximumFractionDigits: 2 })
  const axis = nf({ notation: "compact", maximumFractionDigits: 1 })
  return {
    full: (n) => full?.format(n) ?? `${formatWidgetNumber(n)} ${currency}`,
    axis: (n) => axis?.format(n) ?? COUNT_FMT.axis(n),
    share,
  }
}

const pctText = (v: number, total: number) => `${total > 0 ? Math.round((v / total) * 100) : 0}%`

/** A value label honouring the widget's `values` setting (with a per-variant
 *  default — the text variants always want *some* number beside the bar).
 *  `count` = the measured value. Shares fall back to the value when the
 *  measure has no meaningful total (avg). */
const valueText = (r: Row, total: number, mode: "count" | "percent" | "both", fmt: Fmt) => {
  const v = r.blank ? "—" : fmt.full(r.value)
  if (!fmt.share) return v
  return mode === "percent"
    ? pctText(r.value, total)
    : mode === "both"
      ? `${v} (${pctText(r.value, total)})`
      : v
}

/** Group record versions by an enum field or by label — measuring each group's
 *  record count, or the sum/avg of a number/money field — then render as one of
 *  six presentations. Lazy-loaded by the canvas so dashboards without charts
 *  don't pay recharts' bundle cost. */
export function BreakdownWidget({
  widget,
  data,
}: {
  widget: Breakdown
  data: ConceptRecordData | undefined
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
  const { defaultCurrency } = useOrgSettings()

  // The measure: count, or sum/avg of a number/money field. A sum/avg without a
  // (valid) field prompts rather than silently falling back to counts.
  const agg = widget.agg ?? "count"
  const measureField =
    agg === "count"
      ? undefined
      : data?.fields.find(
          (f) => f.id === widget.field && (f.kind === "number" || f.kind === "money"),
        )
  const measure = useMemo(
    () => (measureField ? { agg, fieldId: measureField.id } : null),
    [agg, measureField],
  )
  const needsField = agg !== "count" && !measureField

  const matchOpts = useMemo(() => ({ match: widget.match, me }), [widget.match, me])
  const matched = useMemo(
    () =>
      (data?.recordVersions ?? []).filter((i) =>
        matchRecordVersion(i, widget.conditions, matchOpts),
      ),
    [data?.recordVersions, widget.conditions, matchOpts],
  )

  // Money: format in the values' own currency (org default when none stored);
  // more than one stored code means the sum mixes currencies — flagged, never
  // silently converted.
  const currencies = useMemo(
    () => (measureField?.kind === "money" ? currenciesOf(matched, measureField.id) : []),
    [matched, measureField],
  )
  const currency = currencies[0] ?? defaultCurrency
  const fmt: Fmt = useMemo(() => {
    const share = agg !== "avg"
    if (measureField?.kind === "money" && currency) return moneyFmt(currency, share)
    return { ...COUNT_FMT, share }
  }, [agg, measureField?.kind, currency])

  const rows = useMemo<Row[]>(() => {
    if (!widget.conceptId || !widget.groupBy || needsField) return []
    const buckets = groupBy(matched, [], widget.groupBy, undefined, measure)
    // sort=field follows the enum's configured option order (labels/users have
    // no configured order — sortBuckets falls back to label order for them).
    const order = data?.fields.find((f) => f.id === widget.groupBy)?.config.options
    const sorted = sortBuckets(buckets, widget.sort ?? "count", {
      labelOf: byLabel ? labelName : undefined,
      order,
    })
    return collapseOther(sorted, widget.maxGroups).map((b) => {
      const v = bucketValue(b, agg)
      return {
        key: b.key,
        name: b.key === OTHER_KEY ? "Other" : byLabel ? labelName(b.key) : b.key,
        value: v ?? 0,
        blank: v == null,
      }
    })
  }, [
    matched,
    data?.fields,
    widget.conceptId,
    widget.groupBy,
    widget.sort,
    widget.maxGroups,
    needsField,
    measure,
    agg,
    byLabel,
    labelName,
  ])

  // Table trend/delta: per-group value series across the chosen window. `now` is
  // mount-stable so resize re-renders don't re-sample (mirrors MetricWidget).
  const now = useMemo(() => Date.now(), [])
  const wantsSeries = widget.chart === "table" && widget.delta != null && widget.delta !== "off"
  const seriesDays = widget.delta === "30d" ? 30 : 7
  const series = useMemo(() => {
    if (!wantsSeries || !widget.conceptId || !widget.groupBy || needsField) return null
    return groupSeries(
      matched,
      [],
      widget.groupBy,
      now - seriesDays * DAY_MS,
      now,
      Math.min(seriesDays + 1, 10),
      undefined,
      measure,
    )
  }, [wantsSeries, seriesDays, matched, widget.groupBy, widget.conceptId, needsField, measure, now])

  if (!widget.conceptId || !widget.groupBy)
    return <p className="text-sm text-muted-foreground">Pick a concept and a group-by.</p>
  if (needsField)
    return (
      <p className="text-sm text-muted-foreground">
        Pick a number or money field to {agg === "sum" ? "sum" : "average"}.
      </p>
    )
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>

  // Sum/count: the groups add up. Avg: the overall average (a sum of averages
  // means nothing) — computed over the records, not the groups.
  const total =
    agg === "avg" && measureField
      ? (metricValue(matched, "avg", [], measureField.id) ?? 0)
      : rows.reduce((s, r) => s + r.value, 0)
  const measureLabel =
    agg === "count" || !measureField
      ? "Count"
      : agg === "sum"
        ? measureField.name
        : `Avg ${measureField.name}`
  const mixed =
    currencies.length > 1 ? (
      <p
        className="shrink-0 truncate pt-1 text-[10px] text-warning"
        title="Amounts are added as stored — no currency conversion."
      >
        Mixed currencies ({currencies.join(", ")}) — summed without conversion
      </p>
    ) : null

  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <BreakdownBody
          widget={widget}
          rows={rows}
          total={total}
          fmt={fmt}
          agg={agg}
          measureLabel={measureLabel}
          series={series}
          days={seriesDays}
        />
      </div>
      {mixed}
    </div>
  )
}

function BreakdownBody({
  widget,
  rows,
  total,
  fmt,
  agg,
  measureLabel,
  series,
  days,
}: {
  widget: Breakdown
  rows: Row[]
  total: number
  fmt: Fmt
  agg: "count" | "sum" | "avg"
  measureLabel: string
  series: Map<string, number[]> | null
  days: number
}) {
  if (widget.chart === "table")
    return (
      <BreakdownTable
        rows={rows}
        total={total}
        fmt={fmt}
        measureLabel={measureLabel}
        series={series}
        days={days}
      />
    )
  if (widget.chart === "bars-h")
    return <RankedBars rows={rows} total={total} values={widget.values} fmt={fmt} />
  if (widget.chart === "stacked")
    return <CompositionBar rows={rows} total={total} values={widget.values} fmt={fmt} />
  if (widget.chart === "donut")
    return (
      <DonutChart
        rows={rows}
        total={total}
        values={widget.values}
        fmt={fmt}
        totalLabel={agg === "avg" ? "average" : "total"}
      />
    )

  // ── recharts bar / pie (the originals) ─────────────────────────────────────
  const values = widget.values
  const byKey = new Map(rows.map((r) => [r.key, r] as const))
  const label = (r: Row | undefined) => (r && values ? valueText(r, total, values, fmt) : "")
  const tooltip = (v: unknown) => (typeof v === "number" ? fmt.full(v) : String(v))

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
            <Tooltip formatter={tooltip} />
            <Legend
              formatter={
                values
                  ? (name: string, entry) => {
                      const k = (entry?.payload as { key?: string } | undefined)?.key
                      const r = k == null ? undefined : byKey.get(k)
                      return r ? `${name} · ${label(r)}` : name
                    }
                  : undefined
              }
            />
          </PieChart>
        ) : (
          <BarChart data={rows} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis
              allowDecimals={agg !== "count"}
              tick={{ fontSize: 11 }}
              tickFormatter={fmt.axis}
              // Fit the widest tick ("SEK 200K"): ~7px per 11px glyph + gap.
              width={Math.max(
                28,
                Math.ceil(fmt.axis(Math.max(...rows.map((r) => r.value), 0)).length * 7) + 10,
              )}
            />
            <Tooltip formatter={tooltip} />
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
              {values && (
                <LabelList
                  dataKey="key"
                  position="top"
                  formatter={(k: unknown) => label(byKey.get(String(k)))}
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
  fmt,
}: {
  rows: Row[]
  total: number
  values?: "count" | "percent" | "both"
  fmt: Fmt
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
          <div className="min-w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-foreground">
            {valueText(r, total, mode, fmt)}
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
  fmt,
}: {
  rows: Row[]
  total: number
  values?: "count" | "percent" | "both"
  fmt: Fmt
}) {
  const mode = values ?? "percent"
  return (
    <div className="flex h-full w-full flex-col justify-center gap-3 text-xs">
      <div className="flex h-7 w-full overflow-hidden rounded-md">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="h-full min-w-0"
            title={`${r.name} · ${valueText(r, total, "both", fmt)}`}
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
              {valueText(r, total, mode, fmt)}
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
  fmt,
  totalLabel,
}: {
  rows: Row[]
  total: number
  values?: "count" | "percent" | "both"
  fmt: Fmt
  totalLabel: string
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
            <Tooltip
              formatter={(v: unknown) => (typeof v === "number" ? fmt.full(v) : String(v))}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {fmt.axis(total)}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {totalLabel}
          </span>
        </div>
      </div>
      <ul className="flex max-h-full shrink-0 flex-col gap-1 overflow-auto pr-1">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorAt(i) }} />
            <span className="max-w-28 truncate text-foreground">{r.name}</span>
            <span className="ml-auto whitespace-nowrap pl-2 tabular-nums text-muted-foreground">
              {valueText(r, total, mode, fmt)}
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

function DeltaText({ diff, fmt }: { diff: number; fmt: Fmt }) {
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
      {fmt.axis(diff)}
    </span>
  )
}

/** #4 Breakdown table: label · count · share, plus an optional trend sparkline +
 *  window delta (created-at based, like the Metric delta) when `series` is set. */
function BreakdownTable({
  rows,
  total,
  fmt,
  measureLabel,
  series,
  days,
}: {
  rows: Row[]
  total: number
  fmt: Fmt
  measureLabel: string
  series: Map<string, number[]> | null
  days: number
}) {
  const showTrend = series != null
  const showShare = fmt.share
  return (
    <div className="h-full w-full overflow-auto text-xs">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-[11px] text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Group</th>
            <th className="px-2 py-1 text-right font-medium">{measureLabel}</th>
            {showShare && <th className="px-2 py-1 text-right font-medium">Share</th>}
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
                <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-foreground">
                  {r.blank ? "—" : fmt.full(r.value)}
                </td>
                {showShare && (
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {pctText(r.value, total)}
                  </td>
                )}
                {showTrend && <td className="px-2 py-1">{s ? <MiniSpark values={s} /> : null}</td>}
                {showTrend && (
                  <td className="py-1 pl-2 text-right">
                    {diff == null ? (
                      <span className="text-muted-foreground">–</span>
                    ) : (
                      <DeltaText diff={diff} fmt={fmt} />
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td className="py-1 pr-2">{showShare ? "Total" : "Overall"}</td>
            <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">
              {fmt.full(total)}
            </td>
            {showShare && (
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">100%</td>
            )}
            {showTrend && <td />}
            {showTrend && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
