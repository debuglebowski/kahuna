import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { Badge, decayTone, momentumTone } from "@/components/ui"
import type { Concept, DashboardWidget, Field, Instance } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { instanceLabel } from "@/lib/instanceLabel"
import { cn } from "@/lib/utils"
import { bandRollup, daysOf, matchInstance, staleInstances } from "@/lib/widgetAggregations"

type Attention = Extract<DashboardWidget, { type: "attention" }>

const DECAY_ORDER = ["fresh", "warm", "cooling", "cold"]
const MOMENTUM_ORDER = ["heating", "steady", "cooling"]

/** Solid fills for the heat-strip segments, by badge tone. */
const STRIP_BG = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
  blue: "bg-info",
  gray: "bg-muted-foreground/40",
} as const

/** The computed field to surface: the explicit one, else the first decay field,
 *  else any computed field. */
const pickField = (widget: Attention, fields: readonly Field[]): Field | undefined => {
  if (widget.computedField) {
    const f = fields.find((x) => x.id === widget.computedField)
    if (f) return f
  }
  return (
    fields.find((f) => f.kind === "computed" && f.config.computedKind === "decay") ??
    fields.find((f) => f.kind === "computed")
  )
}

/** Decay/momentum band rollup + a "needs a nudge" stale queue. Surfaces the
 *  computed-bands engine; reads bands from instance state (no extra RPC).
 *  Variants: badge rollup (default) or a proportional heat strip + worst-N. */
export function AttentionWidget({
  widget,
  data,
  concept,
}: {
  widget: Attention
  data: ConceptInstanceData | undefined
  concept: Concept | undefined
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const fields = data?.fields ?? []
  const conditions = widget.conditions
  const instances = useMemo(() => {
    const all = data?.instances ?? []
    return conditions && conditions.length > 0
      ? all.filter((i) => matchInstance(i, conditions, { match: widget.match, me }))
      : all
  }, [data?.instances, conditions, widget.match, me])
  const field = useMemo(() => pickField(widget, fields), [widget, fields])
  const kind = field?.config.computedKind
  const order = kind === "momentum" ? MOMENTUM_ORDER : DECAY_ORDER
  const tone = kind === "momentum" ? momentumTone : decayTone

  const rollup = useMemo(() => (field ? bandRollup(instances, field.id) : {}), [instances, field])
  const staleBands =
    widget.bands && widget.bands.length > 0
      ? widget.bands
      : kind === "momentum"
        ? ["cooling"]
        : ["cooling", "cold"]
  const stale = useMemo(
    () =>
      field ? staleInstances(instances, field.id, staleBands).slice(0, widget.limit ?? 5) : [],
    [instances, field, staleBands, widget.limit],
  )

  if (!widget.conceptId || !concept)
    return <p className="text-sm text-muted-foreground">Pick a concept.</p>
  if (!field)
    return (
      <p className="text-sm text-muted-foreground">This concept has no decay/momentum field.</p>
    )

  const present = order.filter((b) => rollup[b])
  const showDays = widget.showDays ?? true
  const strip = widget.variant === "strip"
  const total = present.reduce((s, b) => s + (rollup[b] ?? 0), 0)

  const staleList = stale.length > 0 && (
    <div className="min-h-0 flex-1 overflow-auto">
      {stale.map((i: Instance) => {
        const d = field ? daysOf(i, field.id) : null
        return (
          <button
            key={i.id}
            type="button"
            onClick={() => navigate(`/instances/${i.id}`)}
            className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-sm hover:bg-muted"
          >
            <span className="truncate text-foreground">{instanceLabel(i, fields)}</span>
            {showDays && d != null && (
              <span className="shrink-0 text-xs text-muted-foreground">{d}d quiet</span>
            )}
          </button>
        )
      })}
    </div>
  )

  if (strip) {
    return (
      <div className="flex h-full flex-col gap-2">
        {total === 0 ? (
          <span className="text-sm text-muted-foreground">No data.</span>
        ) : (
          <>
            <div className="flex h-2.5 shrink-0 overflow-hidden rounded-full bg-muted">
              {present.map((b) => (
                <div
                  key={b}
                  title={`${rollup[b]} ${b}`}
                  className={cn("h-full", STRIP_BG[tone(b)])}
                  style={{ width: `${((rollup[b] ?? 0) / total) * 100}%` }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {present.map((b) => (
                <span key={b} className="inline-flex items-center gap-1">
                  <span className={cn("size-2 rounded-full", STRIP_BG[tone(b)])} />
                  {rollup[b]} {b}
                </span>
              ))}
            </div>
          </>
        )}
        {staleList}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {present.length === 0 ? (
          <span className="text-sm text-muted-foreground">No data.</span>
        ) : (
          present.map((b) => (
            <Badge key={b} tone={tone(b)}>
              {rollup[b]} {b}
            </Badge>
          ))
        )}
      </div>
      {staleList}
    </div>
  )
}
