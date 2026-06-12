import type { Concept, DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { formatWidgetNumber, heroTextClass, sizeVariant } from "@/lib/dashboards"
import { cn } from "@/lib/utils"
import { metricValue } from "@/lib/widgetAggregations"

type Goal = Extract<DashboardWidget, { type: "goal" }>

/** Auto color thresholds. `reach` (quota): green at the line, red under half.
 *  `stay` (budget): green under the line, amber when close, red once crossed. */
const tone = (pct: number, direction: "reach" | "stay"): "success" | "warning" | "destructive" =>
  direction === "reach"
    ? pct >= 1
      ? "success"
      : pct >= 0.5
        ? "warning"
        : "destructive"
    : pct > 1
      ? "destructive"
      : pct >= 0.9
        ? "warning"
        : "success"

const TEXT_TONE = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
} as const
const BG_TONE = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
} as const

const RING_PX = { sm: 64, md: 88, lg: 120 } as const

/** A metric with a finish line — current value vs target as bar/ring/number. */
export function GoalWidget({
  widget,
  data,
  concept,
}: {
  widget: Goal
  data: ConceptInstanceData | undefined
  concept: Concept | undefined
}) {
  const { data: session } = useSession()
  if (!widget.conceptId || !concept) {
    return <p className="text-sm text-muted-foreground">Pick a concept to track.</p>
  }
  if (widget.target == null) {
    return <p className="text-sm text-muted-foreground">Set a target in the widget settings.</p>
  }

  const value =
    metricValue(data?.instances ?? [], widget.agg, widget.conditions, widget.field, {
      match: widget.match,
      me: session?.user.id ?? null,
    }) ?? 0
  const direction = widget.direction ?? "reach"
  const variant = widget.variant ?? "bar"
  const showPercent = widget.showPercent ?? true
  // target 0 makes progress meaningless — show the raw numbers, no fill/color.
  const pct = widget.target > 0 ? value / widget.target : null
  const t = pct == null ? null : tone(pct, direction)

  const field = widget.field ? data?.fields.find((f) => f.id === widget.field) : undefined
  const sub =
    widget.agg === "count"
      ? concept.pluralName || concept.name
      : `${widget.agg} of ${field?.name ?? "—"}`
  const targetLine = `${direction === "stay" ? "stay under" : "goal"} ${formatWidgetNumber(widget.target)}`
  const pctLabel = pct == null ? null : `${Math.round(pct * 100)}%`

  if (variant === "ring") {
    const size = RING_PX[sizeVariant(widget.layout)]
    const stroke = 8
    const r = (size - stroke) / 2
    const c = 2 * Math.PI * r
    const fill = pct == null ? 0 : Math.min(pct, 1)
    return (
      <div className="flex h-full items-center justify-center gap-4">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="-rotate-90" aria-hidden="true" role="img">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              className="stroke-muted"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${c * fill} ${c}`}
              className={cn("stroke-current transition-[stroke-dasharray]", t && TEXT_TONE[t])}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
            {pctLabel ?? "—"}
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-semibold tabular-nums text-foreground">
            {formatWidgetNumber(value)}
          </div>
          <div className="truncate text-xs text-muted-foreground">{targetLine}</div>
          <div className="truncate text-xs text-muted-foreground">{sub}</div>
        </div>
      </div>
    )
  }

  if (variant === "number") {
    return (
      <div className="flex h-full flex-col justify-center">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-semibold tabular-nums",
              heroTextClass(widget.layout),
              t ? TEXT_TONE[t] : "text-foreground",
            )}
          >
            {formatWidgetNumber(value)}
          </span>
          {showPercent && pctLabel && (
            <span className="text-sm font-medium text-muted-foreground">{pctLabel}</span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {sub} · {targetLine}
        </div>
      </div>
    )
  }

  // bar (default)
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {formatWidgetNumber(value)}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          / {formatWidgetNumber(widget.target)}
          {showPercent && pctLabel ? ` · ${pctLabel}` : ""}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width]", t ? BG_TONE[t] : "bg-primary")}
          style={{ width: `${Math.min(pct ?? 0, 1) * 100}%` }}
        />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {sub} · {targetLine}
      </div>
    </div>
  )
}
