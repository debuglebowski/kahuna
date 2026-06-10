import type { Concept, DashboardWidget } from "@/lib/api"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { metricValue } from "@/lib/widgetAggregations"

type Metric = Extract<DashboardWidget, { type: "metric" }>

const fmt = (n: number): string =>
  Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

/** A single big number: count of matching instances, or sum/avg of a field. */
export function MetricWidget({
  widget,
  data,
  concept,
}: {
  widget: Metric
  data: ConceptInstanceData | undefined
  concept: Concept | undefined
}) {
  if (!widget.conceptId || !concept) {
    return <p className="text-sm text-muted-foreground">Pick a concept to count.</p>
  }
  const value = metricValue(data?.instances ?? [], widget.agg, widget.conditions, widget.field)
  const field = widget.field ? data?.fields.find((f) => f.id === widget.field) : undefined
  const sub =
    widget.agg === "count"
      ? concept.pluralName || concept.name
      : `${widget.agg} of ${field?.name ?? "—"}`

  return (
    <div className="flex h-full flex-col justify-center">
      <div className="text-3xl font-semibold tabular-nums text-foreground">
        {value == null ? "—" : fmt(value)}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}
