import {
  addDays,
  differenceInCalendarDays,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
} from "date-fns"
import type { DashboardWidget, Field, RecordVersion, Task } from "./api"
import { type MatchOpts, matchRecordVersion } from "./conditions"
import { parseDateValue, toISODate } from "./dates"
import { recordHref } from "./recordHref"
import { recordLabel } from "./recordLabel"
import { showValue } from "./utils"

/**
 * Shared date plumbing for the date-plotting widgets (Calendar + Gantt): stored
 * field value → calendar day, source/record version → plotted events/spans, and the
 * windowing math both grids share. Pure (no React / DOM), unit-tested like
 * `widgetAggregations`. The clock is always passed in (`today`) so callers own
 * "now" and the helpers stay deterministic.
 */

type CalendarWidgetConfig = Extract<DashboardWidget, { type: "calendar" }>
export type CalendarSource = CalendarWidgetConfig["sources"][number]
type GanttWidgetConfig = Extract<DashboardWidget, { type: "gantt" }>

/** A stored date-ish value as a `YYYY-MM-DD` day key; null when absent/invalid.
 *  `multiple` date fields contribute their FIRST value (one cell per event). */
export const dayKeyOf = (v: unknown): string | null => {
  const first = Array.isArray(v) ? v[0] : v
  if (typeof first !== "string" || !first) return null
  const d = parseDateValue(first)
  return d ? toISODate(d) : null
}

/** Day key for a local Date (the inverse direction of `dayKeyOf`). */
export const dayKey = (d: Date): string => toISODate(d)

// ── calendar ─────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  /** Unique per plotted event (source index + record version/task id). */
  readonly id: string
  readonly day: string
  readonly label: string
  readonly color: string
  /** In-app navigation target (record version detail / the tasks page). */
  readonly href: string
}

/** Per-source fallback palette (PILL_COLORS hues), cycled by source index. */
export const SOURCE_FALLBACK_COLORS: ReadonlyArray<string> = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#f43f5e", // rose
  "#14b8a6", // teal
  "#d946ef", // fuchsia
  "#78716c", // stone
]

export const sourceColor = (color: string | null | undefined, index: number): string =>
  color || SOURCE_FALLBACK_COLORS[index % SOURCE_FALLBACK_COLORS.length]!

/** Hue for the synthetic "org tasks by due date" source (sky). */
export const TASKS_SOURCE_COLOR = "#0ea5e9"

/** Plot one source's matching record versions onto days. Record versions without a valid
 *  date value are skipped (a calendar can only show dated rows). */
export const sourceEvents = (
  source: CalendarSource,
  index: number,
  recordVersions: readonly RecordVersion[],
  fields: readonly Field[],
  opts?: Pick<MatchOpts, "me"> & { titleFieldId?: string | null },
): CalendarEvent[] => {
  const color = sourceColor(source.color, index)
  const out: CalendarEvent[] = []
  for (const inst of recordVersions) {
    if (!matchRecordVersion(inst, source.conditions ?? [], { match: source.match, me: opts?.me }))
      continue
    const day = dayKeyOf(inst.state[source.dateField])
    if (!day) continue
    const picked = source.labelField ? showValue(inst.state[source.labelField]) : ""
    out.push({
      id: `${index}:${inst.id}`,
      day,
      label: picked || recordLabel(inst, fields, opts?.titleFieldId),
      color,
      href: recordHref(inst.id),
    })
  }
  return out
}

/** Org tasks as calendar events (the `includeTasks` overlay): due, not archived. */
export const taskEvents = (tasks: readonly Task[]): CalendarEvent[] => {
  const out: CalendarEvent[] = []
  for (const t of tasks) {
    if (t.archivedAt) continue
    const day = dayKeyOf(t.dueAt)
    if (!day) continue
    out.push({ id: `task:${t.id}`, day, label: t.title, color: TASKS_SOURCE_COLOR, href: "/tasks" })
  }
  return out
}

/** Events bucketed by day key, each bucket keeping the input order. */
export const eventsByDay = (events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> => {
  const map = new Map<string, CalendarEvent[]>()
  for (const e of events) {
    const list = map.get(e.day)
    if (list) list.push(e)
    else map.set(e.day, [e])
  }
  return map
}

/** The month grid's cells for the month containing `anchor`: whole weeks
 *  (Monday-start) covering the month — always a multiple of 7 days. */
export const monthGridDays = (anchor: Date): Date[] => {
  const start = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 })
  const end = endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 })
  const out: Date[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** The 7 days of the (Monday-start) week containing `anchor`. */
export const weekDays = (anchor: Date): Date[] => {
  const start = startOfWeek(anchor, { weekStartsOn: 1 })
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/** Upcoming events for the agenda mode: on/after `today`, day order, capped. */
export const agendaEvents = (
  events: readonly CalendarEvent[],
  today: Date,
  limit = 100,
): CalendarEvent[] => {
  const from = dayKey(today)
  return [...events]
    .filter((e) => e.day >= from)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(0, limit)
}

// ── gantt ────────────────────────────────────────────────────────────────────

export interface GanttSpan {
  readonly id: string
  readonly start: string
  /** null = no end value → render a milestone at `start`. */
  readonly end: string | null
  readonly label: string
  /** Raw first value of the group-by field ("" = ungrouped bucket). */
  readonly group: string
  /** 0–100 fill, when a progress field is configured; else null. */
  readonly progress: number | null
}

const firstScalar = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

const clampProgress = (v: unknown): number | null => {
  const raw = firstScalar(v)
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, n))
}

/** Matching record versions as time spans, start order. No start date → skipped; an
 *  end before its start is treated as start-only (milestone) rather than an
 *  inverted bar. */
export const ganttSpans = (
  widget: Pick<
    GanttWidgetConfig,
    | "startField"
    | "endField"
    | "groupBy"
    | "barLabelField"
    | "progressField"
    | "conditions"
    | "match"
  >,
  recordVersions: readonly RecordVersion[],
  fields: readonly Field[],
  opts?: Pick<MatchOpts, "me"> & { titleFieldId?: string | null },
): GanttSpan[] => {
  const out: GanttSpan[] = []
  for (const inst of recordVersions) {
    if (!matchRecordVersion(inst, widget.conditions, { match: widget.match, me: opts?.me }))
      continue
    const start = dayKeyOf(inst.state[widget.startField])
    if (!start) continue
    const rawEnd = widget.endField ? dayKeyOf(inst.state[widget.endField]) : null
    const end = rawEnd && rawEnd >= start ? rawEnd : null
    const picked = widget.barLabelField ? showValue(inst.state[widget.barLabelField]) : ""
    const groupRaw = widget.groupBy ? firstScalar(inst.state[widget.groupBy]) : null
    out.push({
      id: inst.id,
      start,
      end,
      label: picked || recordLabel(inst, fields, opts?.titleFieldId),
      group: groupRaw == null || groupRaw === "" ? "" : String(groupRaw),
      progress: widget.progressField ? clampProgress(inst.state[widget.progressField]) : null,
    })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.label.localeCompare(b.label))
}

/** The plotted date range. `fit` hugs the spans (small pad); `90d` rolls with
 *  today (2 weeks of context behind, the rest ahead); `quarter` is the current
 *  calendar quarter. Both ends inclusive. */
export const ganttWindow = (
  spans: readonly GanttSpan[],
  window: "fit" | "90d" | "quarter",
  today: Date,
): { start: Date; end: Date } => {
  if (window === "90d") return { start: addDays(today, -14), end: addDays(today, 75) }
  if (window === "quarter") return { start: startOfQuarter(today), end: endOfQuarter(today) }
  if (spans.length === 0) return { start: addDays(today, -7), end: addDays(today, 30) }
  let min = spans[0]!.start
  let max = spans[0]!.end ?? spans[0]!.start
  for (const s of spans) {
    if (s.start < min) min = s.start
    const e = s.end ?? s.start
    if (e > max) max = e
  }
  // parseDateValue only fails on malformed keys, which dayKeyOf never produces.
  return {
    start: addDays(parseDateValue(min) ?? today, -3),
    end: addDays(parseDateValue(max) ?? today, 3),
  }
}

/** Horizontal zoom: pixels per day at each scale. */
export const PX_PER_DAY: Record<GanttWidgetConfig["scale"], number> = {
  day: 36,
  week: 12,
  month: 4,
}

export interface GanttTick {
  /** Days from the window start. */
  readonly offset: number
  readonly label: string
}

/** Axis ticks across [start, end] for a scale: every day / week (Mon) / month
 *  start. Day ticks label the day-of-month, spelling out the month at window
 *  start and on the 1st; week/month ticks always carry the month. */
export const ganttTicks = (
  start: Date,
  end: Date,
  scale: GanttWidgetConfig["scale"],
): GanttTick[] => {
  const out: GanttTick[] = []
  const total = differenceInCalendarDays(end, start)
  if (scale === "day") {
    for (let i = 0; i <= total; i++) {
      const d = addDays(start, i)
      out.push({
        offset: i,
        label: i === 0 || d.getDate() === 1 ? format(d, "MMM d") : format(d, "d"),
      })
    }
    return out
  }
  if (scale === "week") {
    let d = startOfWeek(start, { weekStartsOn: 1 })
    if (d < start) d = addDays(d, 7)
    for (; d <= end; d = addDays(d, 7)) {
      out.push({ offset: differenceInCalendarDays(d, start), label: format(d, "MMM d") })
    }
    return out
  }
  let d = startOfMonth(start)
  if (d < start) d = startOfMonth(addDays(endOfMonth(d), 1))
  for (; d <= end; d = startOfMonth(addDays(endOfMonth(d), 1))) {
    out.push({
      offset: differenceInCalendarDays(d, start),
      label: d.getMonth() === 0 ? format(d, "MMM yyyy") : format(d, "MMM"),
    })
  }
  return out
}
