import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { api, type DashboardWidget } from "@/lib/api"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { groupBy, LABELS_KEY } from "@/lib/widgetAggregations"

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

  const rows = useMemo(() => {
    if (!widget.conceptId || !widget.groupBy) return []
    return groupBy(data?.instances ?? [], widget.conditions, widget.groupBy).map((b) => ({
      name: byLabel ? labelName(b.key) : b.key,
      value: b.count,
    }))
  }, [data?.instances, widget.conceptId, widget.groupBy, widget.conditions, byLabel, labelName])

  if (!widget.conceptId || !widget.groupBy)
    return <p className="text-sm text-muted-foreground">Pick a concept and a group-by.</p>
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>

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
            <Legend />
          </PieChart>
        ) : (
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
            <Tooltip />
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
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
