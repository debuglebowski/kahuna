import type { Concept, DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { formatWidgetNumber, heroTextClass } from "@/lib/dashboards"
import { cn } from "@/lib/utils"
import { metricValue } from "@/lib/widgetAggregations"

type Metric = Extract<DashboardWidget, { type: "metric" }>

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
  const { data: session } = useSession()
  if (!widget.conceptId || !concept) {
    return <p className="text-sm text-muted-foreground">Pick a concept to count.</p>
  }
  const value = metricValue(data?.instances ?? [], widget.agg, widget.conditions, widget.field, {
    match: widget.match,
    me: session?.user.id ?? null,
  })
  const field = widget.field ? data?.fields.find((f) => f.id === widget.field) : undefined
  const sub =
    widget.agg === "count"
      ? concept.pluralName || concept.name
      : `${widget.agg} of ${field?.name ?? "—"}`

  return (
    <div className="flex h-full flex-col justify-center">
      <div
        className={cn("font-semibold tabular-nums text-foreground", heroTextClass(widget.layout))}
      >
        {value == null ? "—" : formatWidgetNumber(value)}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}
