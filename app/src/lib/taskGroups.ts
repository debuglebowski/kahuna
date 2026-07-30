import { format } from "date-fns"
import type { Task, TaskPriority, TaskStatus } from "../../rpc/contract"
import { parseDateValue } from "./dates"

/**
 * Pure scheduling buckets for the global Tasks page (Zero-style): Overdue,
 * Today, Tomorrow, one group per future month, undated tasks under
 * "Not scheduled", snoozed tasks under "Snoozed", then closed tasks (when
 * shown) under "Done" / "Cancelled" at the end. Empty groups are dropped.
 */

export interface TaskGroup {
  readonly key: string
  readonly title: string
  /** "overdue" renders the alarmed header; everything else is neutral. */
  readonly tone: "overdue" | "default"
  readonly tasks: ReadonlyArray<Task>
}

/** Status-derived predicates the caller resolves (grouping never reads names). */
export interface TaskPredicates {
  readonly isDone: (t: Task) => boolean
  readonly isCancelled: (t: Task) => boolean
}

/** Snoozed = a future `snoozedUntil` (a passed one has woken up — read-time). */
export const isSnoozed = (t: Task, now: Date): boolean =>
  t.snoozedUntil !== null && Date.parse(t.snoozedUntil) > now.getTime()

/** Day key (UTC) of an ISO timestamp — due dates are stored as midnight UTC
 *  (see DueDateControl), so the UTC date IS the picked calendar day. */
const dayOf = (iso: string): string => iso.slice(0, 10)

const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

/** Whole days a due date lies before today (0 = due today, negative = future). */
export const daysOverdue = (iso: string, now: Date): number =>
  Math.round((Date.parse(dayKey(now)) - Date.parse(dayOf(iso))) / 86_400_000)

/** The tasks widget's due filter. `overdue` = due before today; `week` = due
 *  today through 7 days out (rolling window). Undated tasks match neither. */
export const matchesDue = (t: Task, due: "any" | "overdue" | "week", now: Date): boolean => {
  if (due === "any") return true
  if (!t.dueAt) return false
  const d = daysOverdue(t.dueAt, now)
  return due === "overdue" ? d > 0 : d <= 0 && d >= -7
}

export type TaskGroupBy = "schedule" | "status" | "priority" | "none"

const byCreatedDescG = (a: Task, b: Task) => +new Date(b.createdAt) - +new Date(a.createdAt)
const byDueAscG = (a: Task, b: Task) =>
  (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || byCreatedDescG(a, b)

/** Group by an ordered lookup dimension (status / priority): one group per
 *  entry in `order`, plus a trailing group for unset/unknown ids. */
const groupByLookup = (
  tasks: ReadonlyArray<Task>,
  order: ReadonlyArray<{ id: string; name: string }>,
  idOf: (t: Task) => string | null,
  prefix: string,
  noneTitle: string,
): TaskGroup[] => {
  const known = new Set(order.map((o) => o.id))
  const groups: TaskGroup[] = order.map((o) => ({
    key: `${prefix}:${o.id}`,
    title: o.name,
    tone: "default" as const,
    tasks: tasks.filter((t) => idOf(t) === o.id).sort(byDueAscG),
  }))
  const none = tasks.filter((t) => !known.has(idOf(t) ?? "")).sort(byDueAscG)
  return [...groups, { key: `${prefix}:none`, title: noneTitle, tone: "default", tasks: none }]
}

/** Group tasks by the widget's configured dimension. `schedule` delegates to
 *  the Zero-style buckets above; `none` returns one flat group (key "all" —
 *  the renderer drops its header). Empty groups are dropped. */
export function groupTasksBy(
  tasks: ReadonlyArray<Task>,
  by: TaskGroupBy,
  predicates: TaskPredicates,
  now: Date,
  statuses: ReadonlyArray<TaskStatus>,
  priorities: ReadonlyArray<TaskPriority>,
): TaskGroup[] {
  if (by === "schedule") return groupTasks(tasks, predicates, now)
  if (by === "none")
    return tasks.length === 0
      ? []
      : [{ key: "all", title: "All", tone: "default", tasks: [...tasks].sort(byDueAscG) }]
  const groups =
    by === "status"
      ? groupByLookup(tasks, statuses, (t) => t.statusId, "s", "No status")
      : groupByLookup(tasks, priorities, (t) => t.priorityId, "p", "No priority")
  return groups.filter((g) => g.tasks.length > 0)
}

export function groupTasks(
  tasks: ReadonlyArray<Task>,
  predicates: TaskPredicates,
  now: Date,
): TaskGroup[] {
  const { isDone, isCancelled } = predicates
  const today = dayKey(now)
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000))
  const byCreatedDesc = (a: Task, b: Task) => +new Date(b.createdAt) - +new Date(a.createdAt)
  const byDueAsc = (a: Task, b: Task) =>
    (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || byCreatedDesc(a, b)

  const overdue: Task[] = []
  const dueToday: Task[] = []
  const dueTomorrow: Task[] = []
  const unscheduled: Task[] = []
  const snoozed: Task[] = []
  const done: Task[] = []
  const cancelled: Task[] = []
  const months = new Map<string, Task[]>()

  for (const t of tasks) {
    // Closed beats snoozed (a snooze is irrelevant once the task is closed).
    if (isDone(t)) done.push(t)
    else if (isCancelled(t)) cancelled.push(t)
    else if (isSnoozed(t, now)) snoozed.push(t)
    else if (!t.dueAt) unscheduled.push(t)
    else {
      const day = dayOf(t.dueAt)
      if (day < today) overdue.push(t)
      else if (day === today) dueToday.push(t)
      else if (day === tomorrow) dueTomorrow.push(t)
      else {
        const month = day.slice(0, 7)
        const bucket = months.get(month)
        if (bucket) bucket.push(t)
        else months.set(month, [t])
      }
    }
  }

  const monthGroups: TaskGroup[] = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, ts]) => ({
      key: `m:${month}`,
      // parseDateValue keeps the day local so the month never shifts at TZ edges.
      title: format(parseDateValue(`${month}-01`) ?? new Date(), "MMMM yyyy"),
      tone: "default" as const,
      tasks: ts.sort(byDueAsc),
    }))

  const groups: TaskGroup[] = [
    { key: "overdue", title: "Overdue", tone: "overdue", tasks: overdue.sort(byDueAsc) },
    { key: "today", title: "Today", tone: "default", tasks: dueToday.sort(byCreatedDesc) },
    { key: "tomorrow", title: "Tomorrow", tone: "default", tasks: dueTomorrow.sort(byCreatedDesc) },
    ...monthGroups,
    {
      key: "unscheduled",
      title: "Not scheduled",
      tone: "default",
      tasks: unscheduled.sort(byCreatedDesc),
    },
    {
      key: "snoozed",
      title: "Snoozed",
      tone: "default",
      // Soonest wake-up first.
      tasks: snoozed.sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "")),
    },
    {
      key: "done",
      title: "Done",
      tone: "default",
      // Most recently completed first (completedAt; updatedAt covers legacy rows).
      tasks: done.sort(
        (a, b) => +new Date(b.completedAt ?? b.updatedAt) - +new Date(a.completedAt ?? a.updatedAt),
      ),
    },
    {
      key: "cancelled",
      title: "Cancelled",
      tone: "default",
      tasks: cancelled.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    },
  ]
  return groups.filter((g) => g.tasks.length > 0)
}
