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
import {
  collapseOther,
  groupBy,
  LABELS_KEY,
  OTHER_KEY,
  sortBuckets,
} from "@/lib/widgetAggregations"

type Breakdown = Extract<DashboardWidget, { type: "breakdown" }>

// A small, theme-agnostic categorical palette (recharts needs explicit colors).
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

/** Group instances by an enum field or by label → bar/pie chart. Lazy-loaded by
 *  the canvas so dashboards without charts don't pay recharts' bundle cost. */
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
  const rows = useMemo(() => {
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

  if (!widget.conceptId || !widget.groupBy)
    return <p className="text-sm text-muted-foreground">Pick a concept and a group-by.</p>
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>

  const total = rows.reduce((s, r) => s + r.value, 0)
  const pct = (v: number) => `${total > 0 ? Math.round((v / total) * 100) : 0}%`
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
                <Cell key={r.name} fill={PALETTE[i % PALETTE.length]} />
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
                <Cell key={r.name} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
