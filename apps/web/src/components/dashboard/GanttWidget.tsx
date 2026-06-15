import { differenceInCalendarDays } from "date-fns"
import { Fragment, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { pillStyle } from "@/components/ui"
import type { Concept, DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { parseDateValue } from "@/lib/dates"
import { FieldValueCell } from "@/lib/fieldDisplay"
import { cn } from "@/lib/utils"
import { type GanttSpan, ganttSpans, ganttTicks, ganttWindow, PX_PER_DAY } from "@/lib/widgetDates"

type Gantt = Extract<DashboardWidget, { type: "gantt" }>

/** Sticky label rail width (px) — also the time track's left edge. */
const LABEL_W = 144
/** Fixed bar hue (a "color by" option is a later phase). */
const BAR_COLOR = "#3b82f6"

/**
 * Instances as horizontal bars between two date fields — duration and overlap
 * on one time axis. No end value = a milestone diamond at the start date. The
 * scale sets the zoom (px/day) and the surface scrolls both ways under a
 * sticky axis header and label rail; group-by folds rows into swimlanes.
 */
export function GanttWidget({
  widget,
  data,
  concept,
}: {
  widget: Gantt
  data: ConceptInstanceData | undefined
  /** The bar's concept — its title field drives bar labels. */
  concept?: Concept
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const fields = data?.fields ?? []
  const groupField = widget.groupBy ? fields.find((f) => f.id === widget.groupBy) : undefined

  const spans = useMemo(
    () =>
      ganttSpans(widget, data?.instances ?? [], fields, {
        me,
        titleFieldId: concept?.titleFieldId,
      }),
    [widget, data?.instances, fields, me, concept?.titleFieldId],
  )

  if (!widget.conceptId) return <p className="text-sm text-muted-foreground">Pick a concept.</p>
  if (!widget.startField) {
    return (
      <p className="text-sm text-muted-foreground">
        Pick a start date field in the widget settings.
      </p>
    )
  }

  const today = new Date()
  const { start, end } = ganttWindow(spans, widget.window ?? "fit", today)
  const ppd = PX_PER_DAY[widget.scale]
  const totalDays = differenceInCalendarDays(end, start) + 1
  const width = totalDays * ppd
  const ticks = ganttTicks(start, end, widget.scale)
  const offsetOf = (day: string) => {
    const d = parseDateValue(day)
    return d ? differenceInCalendarDays(d, start) : 0
  }
  const todayOffset = differenceInCalendarDays(today, start)
  const todayVisible = todayOffset >= 0 && todayOffset < totalDays
  const showToday = (widget.showTodayLine ?? true) && todayVisible

  // Only spans overlapping the window earn a row (bars clamp to the edges).
  const visible = spans.filter(
    (s) => offsetOf(s.start) < totalDays && offsetOf(s.end ?? s.start) >= 0,
  )

  // Swimlanes: enum groups follow the field's option order, others alphabetical,
  // the ungrouped bucket last. Flat (single anonymous group) without group-by.
  const groups = (() => {
    if (!groupField) return [{ key: null as string | null, spans: visible }]
    const byGroup = new Map<string, GanttSpan[]>()
    for (const s of visible) {
      const list = byGroup.get(s.group)
      if (list) list.push(s)
      else byGroup.set(s.group, [s])
    }
    const optionPos = new Map((groupField.config.options ?? []).map((o, i) => [o, i] as const))
    const keys = [...byGroup.keys()].sort((a, b) => {
      if (a === "") return 1
      if (b === "") return -1
      const pa = optionPos.get(a)
      const pb = optionPos.get(b)
      if (pa != null && pb != null) return pa - pb
      if (pa != null) return -1
      if (pb != null) return 1
      return a.localeCompare(b)
    })
    return keys.map((key) => ({ key: key as string | null, spans: byGroup.get(key)! }))
  })()

  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">No dated items in this window.</p>
  }

  const renderBar = (s: GanttSpan) => {
    const open = () => navigate(`/instances/${s.id}`)
    if (!s.end) {
      const off = offsetOf(s.start)
      if (off < 0 || off >= totalDays) return null
      return (
        <button
          type="button"
          aria-label={`${s.label} (milestone)`}
          title={s.label}
          style={{ ...pillStyle(BAR_COLOR), left: off * ppd + ppd / 2 - 5 }}
          className="km-pill absolute top-1/2 size-2.5 -translate-y-1/2 rotate-45 rounded-[2px]"
          onClick={open}
        />
      )
    }
    const sOff = Math.max(0, offsetOf(s.start))
    const eOff = Math.min(totalDays - 1, offsetOf(s.end))
    return (
      <button
        type="button"
        aria-label={s.label}
        title={s.label}
        style={{
          ...pillStyle(BAR_COLOR),
          left: sOff * ppd,
          width: Math.max((eOff - sOff + 1) * ppd, 6),
        }}
        className="km-pill absolute top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded"
        onClick={open}
      >
        {s.progress != null && (
          <span
            className="absolute inset-y-0 left-0"
            style={{ width: `${s.progress}%`, backgroundColor: "var(--pill)", opacity: 0.35 }}
          />
        )}
      </button>
    )
  }

  return (
    // cancel-drag: scrolling/clicking the chart must never start a tile drag.
    <div className="cancel-drag h-full min-h-0 overflow-auto">
      <div className="relative" style={{ width: LABEL_W + width }}>
        <div className="sticky top-0 z-20 flex h-6 border-b bg-card">
          <div
            className="sticky left-0 z-10 shrink-0 border-r bg-card"
            style={{ width: LABEL_W }}
          />
          <div className="relative shrink-0" style={{ width }}>
            {ticks.map((t) => (
              <span
                key={t.offset}
                className="absolute top-1 pl-1 text-[10px] leading-none whitespace-nowrap text-muted-foreground"
                style={{ left: t.offset * ppd }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {/* Gridlines + today line span every row; under the sticky rails (z-0). */}
        <div
          className="pointer-events-none absolute top-6 bottom-0 z-0"
          style={{ left: LABEL_W, width }}
        >
          {ticks.map((t) => (
            <div
              key={t.offset}
              className="absolute inset-y-0 w-px bg-border/60"
              style={{ left: t.offset * ppd }}
            />
          ))}
          {showToday && (
            <div
              className="absolute inset-y-0 w-px bg-destructive"
              style={{ left: todayOffset * ppd + ppd / 2 }}
            />
          )}
        </div>

        {groups.map((g) => (
          <Fragment key={g.key ?? "__flat"}>
            {groupField && (
              <div className="flex h-6 items-center">
                <div
                  className="sticky left-0 z-10 flex h-full shrink-0 items-center border-r bg-card px-1.5 text-[11px] font-medium text-muted-foreground"
                  style={{ width: LABEL_W }}
                >
                  {g.key ? (
                    <FieldValueCell field={groupField} value={g.key} />
                  ) : (
                    <span>No {groupField.name.toLowerCase()}</span>
                  )}
                </div>
              </div>
            )}
            {g.spans.map((s) => (
              <div key={s.id} className="flex h-7">
                <button
                  type="button"
                  title={s.label}
                  className={cn(
                    "sticky left-0 z-10 h-full shrink-0 truncate border-r bg-card px-1.5 text-left text-xs text-foreground hover:bg-muted",
                    groupField && "pl-3",
                  )}
                  style={{ width: LABEL_W }}
                  onClick={() => navigate(`/instances/${s.id}`)}
                >
                  {s.label}
                </button>
                <div className="relative h-full shrink-0" style={{ width }}>
                  {renderBar(s)}
                </div>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
