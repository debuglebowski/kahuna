import { format } from "date-fns"
import type { Task } from "../../rpc/contract"
import { parseDateValue } from "./dates"

/**
 * Pure scheduling buckets for the global Tasks page (Zero-style): Overdue,
 * Today, Tomorrow, one group per future month, undated tasks under
 * "Not scheduled", and completed tasks (when shown) under "Done" at the end.
 * Empty groups are dropped.
 */

export interface TaskGroup {
  readonly key: string
  readonly title: string
  /** "overdue" renders the alarmed header; everything else is neutral. */
  readonly tone: "overdue" | "default"
  readonly tasks: ReadonlyArray<Task>
}

/** Day key (UTC) of an ISO timestamp — due dates are stored as midnight UTC
 *  (see DueDateControl), so the UTC date IS the picked calendar day. */
const dayOf = (iso: string): string => iso.slice(0, 10)

const dayKey = (d: Date): string => d.toISOString().slice(0, 10)

/** Whole days a due date lies before today (0 = due today, negative = future). */
export const daysOverdue = (iso: string, now: Date): number =>
  Math.round((Date.parse(dayKey(now)) - Date.parse(dayOf(iso))) / 86_400_000)

export function groupTasks(
  tasks: ReadonlyArray<Task>,
  isDone: (t: Task) => boolean,
  now: Date,
): TaskGroup[] {
  const today = dayKey(now)
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000))
  const byCreatedDesc = (a: Task, b: Task) => +new Date(b.createdAt) - +new Date(a.createdAt)
  const byDueAsc = (a: Task, b: Task) =>
    (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || byCreatedDesc(a, b)

  const overdue: Task[] = []
  const dueToday: Task[] = []
  const dueTomorrow: Task[] = []
  const unscheduled: Task[] = []
  const done: Task[] = []
  const months = new Map<string, Task[]>()

  for (const t of tasks) {
    if (isDone(t)) done.push(t)
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
      key: "done",
      title: "Done",
      tone: "default",
      tasks: done.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    },
  ]
  return groups.filter((g) => g.tasks.length > 0)
}
