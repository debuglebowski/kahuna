import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { api, type Concept, type DashboardWidget, type Instance } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import {
  formatMetric,
  formatWidgetNumber,
  heroTextClass,
  isWide,
  sizeVariant,
} from "@/lib/dashboards"
import { cn } from "@/lib/utils"
import { createdOnOrBefore, metricSeries, metricValue } from "@/lib/widgetAggregations"
import { useWidgetBox } from "./widgetBox"

type Metric = Extract<DashboardWidget, { type: "metric" }>

const DAY_MS = 86_400_000

/** A minimal inline trend line for the `spark` variant. The non-uniform viewBox
 *  stretches the path to fill the box; `non-scaling-stroke` keeps the line crisp
 *  despite that scaling. Flat series (min === max) render a centered midline. */
function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const last = values.length - 1
  const points = values
    .map(
      (v, i) => `${((i / last) * 100).toFixed(2)},${(100 - ((v - min) / span) * 100).toFixed(2)}`,
    )
    .join(" ")
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-full w-full overflow-visible text-primary"
      aria-hidden="true"
      role="img"
    >
      <polyline
        points={points}
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

const SPARK_HEIGHT = { sm: "h-8", md: "h-12", lg: "h-16" } as const

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
 *  Variants: centered tile (default), a wide stat bar (`auto` picks the bar on
 *  short, wide tiles), or a sparkline KPI (number beside an inline trend). All
 *  support an optional delta vs the value N days ago. */
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
  const box = useWidgetBox()
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

  // Sparkline trail (spark variant only): the metric sampled daily across a
  // window derived from the delta setting (7d → 7d, otherwise 30d), so it needs
  // no new config. `now` is mount-stable so resize re-renders don't re-sample.
  const isSpark = (widget.variant ?? "auto") === "spark"
  const sparkDays = widget.delta === "7d" ? 7 : 30
  const now = useMemo(() => Date.now(), [])
  const series = useMemo(
    () =>
      isSpark
        ? metricSeries(
            instances,
            widget.agg,
            widget.conditions,
            widget.field,
            now - sparkDays * DAY_MS,
            now,
            Math.min(sparkDays + 1, 31),
            { match: widget.match, me: session?.user.id ?? null },
          )
        : [],
    [
      isSpark,
      instances,
      widget.agg,
      widget.conditions,
      widget.field,
      widget.match,
      sparkDays,
      now,
      session?.user.id,
    ],
  )

  if (!widget.conceptId || !concept) {
    return <p className="text-sm text-muted-foreground">Pick a concept to count.</p>
  }

  const opts = { match: widget.match, me: session?.user.id ?? null }
  const value = metricValue(instances, widget.agg, widget.conditions, widget.field, opts)
  const field = widget.field ? data?.fields.find((f) => f.id === widget.field) : undefined
  // A custom caption wins; otherwise auto-derive it from the aggregate.
  const sub =
    widget.label?.trim() ||
    (widget.agg === "count"
      ? concept.pluralName || concept.name
      : `${widget.agg} of ${field?.name ?? "—"}`)

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

  // Sparkline KPI: caption, then the number beside an inline trend that fills
  // the remaining width, with the delta below.
  if (isSpark) {
    return (
      <div className="flex h-full flex-col justify-center gap-1.5">
        <div className="min-w-0 truncate text-xs text-muted-foreground">{sub}</div>
        <div className="flex items-end gap-3">
          <span
            className={cn("font-semibold tabular-nums text-foreground", heroTextClass(box.height))}
          >
            {hero}
          </span>
          {series.length >= 2 && (
            <div className={cn("min-w-0 flex-1", SPARK_HEIGHT[sizeVariant(box.height)])}>
              <Sparkline values={series} />
            </div>
          )}
        </div>
        {delta && <div>{delta}</div>}
      </div>
    )
  }

  const variant = widget.variant ?? "auto"
  const bar =
    variant === "bar" ||
    (variant === "auto" && isWide(box.width) && sizeVariant(box.height) === "sm")

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

  // Tile (default): big number centered both axes, caption + delta stacked under.
  return (
    <div className="flex h-full flex-col justify-center text-center">
      <div className={cn("font-semibold tabular-nums text-foreground", heroTextClass(box.height))}>
        {hero}
      </div>
      {/* Label and delta each on their own line, stacked under the number. */}
      <div className="mt-1 min-w-0 truncate text-xs text-muted-foreground">{sub}</div>
      {delta && <div className="mt-0.5">{delta}</div>}
    </div>
  )
}
