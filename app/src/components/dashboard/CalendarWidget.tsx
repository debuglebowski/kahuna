import { useLiveQuery } from "@tanstack/react-db"
import { addDays, addMonths, format, isSameDay, isSameMonth } from "date-fns"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { pillStyle } from "@/components/ui"
import type { Concept, DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { KEY, tasksGlobalCollection, useRegisterCollection } from "@/lib/collections"
import type { ConceptRecordData } from "@/lib/conceptData"
import { formatDateValue } from "@/lib/dates"
import { cn } from "@/lib/utils"
import {
  agendaEvents,
  type CalendarEvent,
  dayKey,
  eventsByDay,
  monthGridDays,
  sourceEvents,
  taskEvents,
  weekDays,
} from "@/lib/widgetDates"

type Calendar = Extract<DashboardWidget, { type: "calendar" }>

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/**
 * Record versions plotted by a date field, several concepts overlaid on one grid
 * (plus the org's tasks by due date as an opt-in extra source). Month/week are
 * cursor-navigated; agenda is a fixed upcoming list. Multi-source: this reads
 * `instData` directly instead of the single-concept `data` prop the scoped
 * widgets get.
 */
export function CalendarWidget({
  widget,
  instData,
  cIndex,
}: {
  widget: Calendar
  instData: Record<string, ConceptRecordData>
  /** Concept lookup so each source's title field drives its event labels. */
  cIndex: Map<string, Concept>
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const includeTasks = widget.includeTasks ?? false
  // Registered unconditionally (hooks can't be conditional); the collection is
  // shared org-wide, so other registrants make this a no-op anyway.
  useRegisterCollection(KEY.tasksGlobal, tasksGlobalCollection)
  const tasksQ = useLiveQuery((q) => q.from({ t: tasksGlobalCollection }))

  const [cursor, setCursor] = useState(() => new Date())
  const today = new Date()

  const events = useMemo(() => {
    const out: CalendarEvent[] = []
    widget.sources.forEach((s, i) => {
      const d = s.conceptId ? instData[s.conceptId] : undefined
      if (!d || !s.dateField) return
      const titleFieldId = s.conceptId ? (cIndex.get(s.conceptId)?.titleFieldId ?? null) : null
      out.push(...sourceEvents(s, i, d.recordVersions, d.fields, { me, titleFieldId }))
    })
    if (includeTasks) out.push(...taskEvents(tasksQ.data ?? []))
    return out
  }, [widget.sources, instData, includeTasks, tasksQ.data, me, cIndex])

  const byDay = useMemo(() => eventsByDay(events), [events])

  const configured = widget.sources.some((s) => s.conceptId && s.dateField) || includeTasks
  if (!configured) {
    return (
      <p className="text-sm text-muted-foreground">
        Add a source (concept + date field) in the widget settings.
      </p>
    )
  }

  const openEvent = (e: CalendarEvent) => navigate(e.href)
  const step = (dir: -1 | 1) =>
    setCursor((c) => (widget.mode === "week" ? addDays(c, dir * 7) : addMonths(c, dir)))

  const headerLabel =
    widget.mode === "month"
      ? format(cursor, "MMMM yyyy")
      : widget.mode === "week"
        ? `${format(weekDays(cursor)[0]!, "MMM d")} – ${format(weekDays(cursor)[6]!, "MMM d, yyyy")}`
        : "Upcoming"

  return (
    // cancel-drag: navigation + event clicks must never start a tile drag.
    <div className="cancel-drag flex h-full min-h-0 flex-col">
      <div className="mb-1 flex shrink-0 items-center justify-between gap-1">
        <span className="truncate text-sm font-medium text-foreground">{headerLabel}</span>
        {widget.mode !== "agenda" && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Previous"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => step(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setCursor(new Date())}
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Next"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => step(1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>

      {widget.mode === "month" && (
        <MonthGrid
          cursor={cursor}
          today={today}
          byDay={byDay}
          density={widget.density ?? "full"}
          onOpen={openEvent}
        />
      )}
      {widget.mode === "week" && (
        <WeekRow cursor={cursor} today={today} byDay={byDay} onOpen={openEvent} />
      )}
      {widget.mode === "agenda" && <Agenda events={events} today={today} onOpen={openEvent} />}
    </div>
  )
}

function EventChip({
  event,
  onOpen,
}: {
  event: CalendarEvent
  onOpen: (e: CalendarEvent) => void
}) {
  return (
    <button
      type="button"
      title={event.label}
      style={pillStyle(event.color)}
      className="km-pill block w-full truncate rounded px-1 text-left text-[10px] leading-4 font-medium"
      onClick={() => onOpen(event)}
    >
      {event.label}
    </button>
  )
}

function DayNumber({ day, today }: { day: Date; today: Date }) {
  const isToday = isSameDay(day, today)
  return (
    <span
      className={cn(
        "inline-flex size-4.5 items-center justify-center rounded-full text-[11px] leading-none tabular-nums",
        isToday && "bg-primary font-semibold text-primary-foreground",
      )}
    >
      {day.getDate()}
    </span>
  )
}

function MonthGrid({
  cursor,
  today,
  byDay,
  density,
  onOpen,
}: {
  cursor: Date
  today: Date
  byDay: Map<string, CalendarEvent[]>
  density: "full" | "dots"
  onOpen: (e: CalendarEvent) => void
}) {
  const days = monthGridDays(cursor)
  const rows = days.length / 7
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b pb-0.5">
        {WEEKDAY_LABELS.map((l) => (
          <span key={l} className="text-center text-[10px] font-medium text-muted-foreground">
            {l}
          </span>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {days.map((day) => {
          const evts = byDay.get(dayKey(day)) ?? []
          const inMonth = isSameMonth(day, cursor)
          return (
            <div
              key={day.getTime()}
              className={cn(
                "flex min-h-0 flex-col gap-0.5 overflow-hidden border-r border-b p-0.5 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                !inMonth && "bg-muted/30 opacity-60",
              )}
            >
              <DayNumber day={day} today={today} />
              {density === "full" ? (
                <>
                  {evts.slice(0, 3).map((e) => (
                    <EventChip key={e.id} event={e} onOpen={onOpen} />
                  ))}
                  {evts.length > 3 && (
                    <span className="px-1 text-[10px] leading-4 text-muted-foreground">
                      +{evts.length - 3} more
                    </span>
                  )}
                </>
              ) : (
                evts.length > 0 && (
                  <span className="flex items-center gap-0.5 px-0.5">
                    {evts.slice(0, 4).map((e) => (
                      <span
                        key={e.id}
                        title={e.label}
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: e.color }}
                      />
                    ))}
                    <span className="text-[10px] leading-none text-muted-foreground tabular-nums">
                      {evts.length}
                    </span>
                  </span>
                )
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WeekRow({
  cursor,
  today,
  byDay,
  onOpen,
}: {
  cursor: Date
  today: Date
  byDay: Map<string, CalendarEvent[]>
  onOpen: (e: CalendarEvent) => void
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 gap-1">
      {weekDays(cursor).map((day) => {
        const evts = byDay.get(dayKey(day)) ?? []
        return (
          <div key={day.getTime()} className="flex min-h-0 flex-col rounded-md bg-muted/40 p-1">
            <div className="mb-1 flex shrink-0 items-center gap-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                {format(day, "EEE")}
              </span>
              <DayNumber day={day} today={today} />
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {evts.map((e) => (
                <EventChip key={e.id} event={e} onOpen={onOpen} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Agenda({
  events,
  today,
  onOpen,
}: {
  events: readonly CalendarEvent[]
  today: Date
  onOpen: (e: CalendarEvent) => void
}) {
  const upcoming = agendaEvents(events, today)
  if (upcoming.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing upcoming.</p>
  // Group consecutive same-day events (the list is already day-ordered).
  const groups: Array<{ day: string; items: CalendarEvent[] }> = []
  for (const e of upcoming) {
    const last = groups[groups.length - 1]
    if (last && last.day === e.day) last.items.push(e)
    else groups.push({ day: e.day, items: [e] })
  }
  const todayKey = dayKey(today)
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {groups.map((g) => (
        <div key={g.day}>
          <p
            className={cn(
              "mb-0.5 text-[11px] font-medium text-muted-foreground",
              g.day === todayKey && "text-primary",
            )}
          >
            {g.day === todayKey ? "Today" : formatDateValue(g.day)}
          </p>
          <div className="space-y-0.5">
            {g.items.map((e) => (
              <button
                key={e.id}
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-foreground hover:bg-muted"
                onClick={() => onOpen(e)}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: e.color }}
                />
                <span className="truncate">{e.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
