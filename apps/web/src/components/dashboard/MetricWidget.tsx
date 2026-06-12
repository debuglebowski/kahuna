import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { api, type Concept, type DashboardWidget, type Instance } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { formatMetric, formatWidgetNumber, heroTextClass } from "@/lib/dashboards"
import { cn } from "@/lib/utils"
import { createdOnOrBefore, metricValue } from "@/lib/widgetAggregations"

type Metric = Extract<DashboardWidget, { type: "metric" }>

const DAY_MS = 86_400_000

/** Currency code for the hero number: the first one stored on the summed
 *  field's values (money values carry their own code; USD covers none). */
const sniffCurrency = (instances: readonly Instance[], fieldId?: string | null): string => {
  if (!fieldId) return "USD"
  for (const i of instances) {
    const v = i.state[fieldId]
    if (v && typeof v === "object" && "currency" in v) {
      const c = (v as { currency?: unknown }).currency
      if (typeof c === "string" && c) return c
    }
  }
  return "USD"
}

/** A single big number: count of matching instances, or sum/avg of a field.
 *  Variants: vertical tile (default) or a wide stat bar (`auto` picks the bar
 *  on short, wide tiles). Optional delta vs the value N days ago. */
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
  const conceptId = widget.conceptId ?? ""
  const includeArchived = widget.includeArchived ?? false

  // The live collection excludes archived rows; the opt-in pulls them via a
  // plain query (same pattern as the Kanban board's archived toggle).
  const archivedQ = useQuery({
    queryKey: ["metric-archived", conceptId],
    queryFn: () => api.listInstances(conceptId, { includeArchived: true }),
    enabled: includeArchived && !!conceptId,
  })
  const instances = useMemo(() => {
    const live = data?.instances ?? []
    if (!includeArchived) return live
    const archived = (archivedQ.data ?? []).filter((i) => i.archivedAt != null)
    return [...live, ...archived]
  }, [data?.instances, includeArchived, archivedQ.data])

  if (!widget.conceptId || !concept) {
    return <p className="text-sm text-muted-foreground">Pick a concept to count.</p>
  }

  const opts = { match: widget.match, me: session?.user.id ?? null }
  const value = metricValue(instances, widget.agg, widget.conditions, widget.field, opts)
  const field = widget.field ? data?.fields.find((f) => f.id === widget.field) : undefined
  const sub =
    widget.agg === "count"
      ? concept.pluralName || concept.name
      : `${widget.agg} of ${field?.name ?? "—"}`

  const format = widget.format ?? "plain"
  const currency = format === "currency" ? sniffCurrency(instances, widget.field) : undefined
  const hero = value == null ? "—" : formatMetric(value, format, currency)

  // Delta vs N days ago: the metric over the instances that existed back then.
  // Created-at based — archived/deleted drift is invisible (approximation).
  const deltaDays = widget.delta === "7d" ? 7 : widget.delta === "30d" ? 30 : null
  let deltaLine: { text: string; dir: -1 | 0 | 1 } | null = null
  if (deltaDays != null && value != null) {
    const baseline = metricValue(
      createdOnOrBefore(instances, Date.now() - deltaDays * DAY_MS),
      widget.agg,
      widget.conditions,
      widget.field,
      opts,
    )
    if (baseline != null) {
      const diff = value - baseline
      const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0
      const signed = `${diff > 0 ? "+" : ""}${formatWidgetNumber(diff)}`
      deltaLine = { text: `${signed} vs ${deltaDays}d ago`, dir }
    }
  }

  const delta = deltaLine && (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        deltaLine.dir > 0
          ? "text-success"
          : deltaLine.dir < 0
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      {deltaLine.dir > 0 ? "▲ " : deltaLine.dir < 0 ? "▼ " : ""}
      {deltaLine.text}
    </span>
  )

  const variant = widget.variant ?? "auto"
  const bar =
    variant === "bar" || (variant === "auto" && widget.layout.w >= 6 && widget.layout.h <= 2)

  if (bar) {
    return (
      <div className="flex h-full items-center justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-3xl font-semibold tabular-nums text-foreground">{hero}</span>
          <span className="truncate text-sm text-muted-foreground">{sub}</span>
        </div>
        {delta}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col justify-center">
      <div
        className={cn("font-semibold tabular-nums text-foreground", heroTextClass(widget.layout))}
      >
        {hero}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{sub}</span>
        {delta}
      </div>
    </div>
  )
}
