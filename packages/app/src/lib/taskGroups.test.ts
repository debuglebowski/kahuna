import type { Task, TaskPriority, TaskStatus } from "@alltinghq/contract"
import { describe, expect, it } from "vitest"
import {
  daysOverdue,
  groupTasks,
  groupTasksBy,
  isSnoozed,
  matchesDue,
  openTasksFor,
  type TaskPredicates,
} from "./taskGroups"

// Fixed "now": 2026-06-11 noon UTC — today=06-11, tomorrow=06-12.
const NOW = new Date("2026-06-11T12:00:00.000Z")

let seq = 0
const task = (over: Partial<Task>): Task => ({
  id: `t${++seq}`,
  subjectId: null,
  title: `task ${seq}`,
  description: null,
  statusId: null,
  priorityId: null,
  labelIds: [],
  assignee: null,
  dueAt: null,
  snoozedUntil: null,
  blockedAt: null,
  blockedReason: null,
  blockedByTaskId: null,
  completedAt: null,
  createdBy: null,
  customFields: {},
  version: 1,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  archivedAt: null,
  ...over,
})

const allOpen: TaskPredicates = { isDone: () => false, isCancelled: () => false }
const keys = (tasks: Task[]) => groupTasks(tasks, allOpen, NOW).map((g) => g.key)

describe("groupTasks", () => {
  it("buckets by schedule and orders groups overdue → today → tomorrow → months → unscheduled", () => {
    const tasks = [
      task({ dueAt: "2026-08-03T00:00:00.000Z" }),
      task({ dueAt: null }),
      task({ dueAt: "2026-06-11T00:00:00.000Z" }),
      task({ dueAt: "2026-04-20T00:00:00.000Z" }),
      task({ dueAt: "2026-06-12T00:00:00.000Z" }),
      task({ dueAt: "2026-06-25T00:00:00.000Z" }),
    ]
    expect(keys(tasks)).toEqual([
      "overdue",
      "today",
      "tomorrow",
      "m:2026-06",
      "m:2026-08",
      "unscheduled",
    ])
  })

  it("drops empty groups and titles months human-readably", () => {
    const groups = groupTasks([task({ dueAt: "2026-08-03T00:00:00.000Z" })], allOpen, NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: "m:2026-08", title: "August 2026" })
  })

  it("sorts overdue by due date ascending (oldest debt first)", () => {
    const a = task({ dueAt: "2026-06-01T00:00:00.000Z" })
    const b = task({ dueAt: "2026-04-20T00:00:00.000Z" })
    const groups = groupTasks([a, b], allOpen, NOW)
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual([b.id, a.id])
  })

  it("routes done tasks to the trailing done group regardless of due date", () => {
    const d = task({ dueAt: "2026-04-20T00:00:00.000Z" })
    const open = task({ dueAt: null })
    const groups = groupTasks([d, open], { ...allOpen, isDone: (t) => t.id === d.id }, NOW)
    expect(groups.map((g) => g.key)).toEqual(["unscheduled", "done"])
  })

  it("sorts done by completedAt desc, falling back to updatedAt for legacy rows", () => {
    const older = task({ completedAt: new Date("2026-06-02T00:00:00.000Z") })
    const legacy = task({ completedAt: null, updatedAt: new Date("2026-06-05T00:00:00.000Z") })
    const newer = task({ completedAt: new Date("2026-06-10T00:00:00.000Z") })
    const groups = groupTasks([older, legacy, newer], { ...allOpen, isDone: () => true }, NOW)
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual([newer.id, legacy.id, older.id])
  })

  it("routes cancelled tasks to their own trailing group after done", () => {
    const c = task({ dueAt: "2026-04-20T00:00:00.000Z" })
    const d = task({})
    const open = task({})
    const groups = groupTasks(
      [c, d, open],
      { isDone: (t) => t.id === d.id, isCancelled: (t) => t.id === c.id },
      NOW,
    )
    expect(groups.map((g) => g.key)).toEqual(["unscheduled", "done", "cancelled"])
  })

  it("routes future-snoozed tasks to the snoozed group (soonest wake-up first); past snoozes are awake", () => {
    const later = task({ snoozedUntil: "2026-06-20T00:00:00.000Z" })
    const soon = task({ snoozedUntil: "2026-06-13T00:00:00.000Z" })
    const woken = task({ snoozedUntil: "2026-06-10T00:00:00.000Z" })
    const groups = groupTasks([later, soon, woken], allOpen, NOW)
    expect(groups.map((g) => g.key)).toEqual(["unscheduled", "snoozed"])
    expect(groups[1]?.tasks.map((t) => t.id)).toEqual([soon.id, later.id])
  })

  it("closed beats snoozed — a snoozed-but-done task lands in done", () => {
    const t = task({ snoozedUntil: "2026-06-20T00:00:00.000Z" })
    const groups = groupTasks([t], { ...allOpen, isDone: () => true }, NOW)
    expect(groups.map((g) => g.key)).toEqual(["done"])
  })
})

describe("isSnoozed", () => {
  it("is true only while snoozedUntil lies in the future", () => {
    expect(isSnoozed(task({ snoozedUntil: "2026-06-20T00:00:00.000Z" }), NOW)).toBe(true)
    expect(isSnoozed(task({ snoozedUntil: "2026-06-10T00:00:00.000Z" }), NOW)).toBe(false)
    expect(isSnoozed(task({ snoozedUntil: null }), NOW)).toBe(false)
  })
})

describe("daysOverdue", () => {
  it("counts whole days before today", () => {
    expect(daysOverdue("2026-06-01T00:00:00.000Z", NOW)).toBe(10)
    expect(daysOverdue("2026-06-11T00:00:00.000Z", NOW)).toBe(0)
    expect(daysOverdue("2026-06-12T00:00:00.000Z", NOW)).toBe(-1)
  })
})

describe("matchesDue", () => {
  it("overdue = strictly before today; week = today through +7d; undated never matches", () => {
    const past = task({ dueAt: "2026-06-01T00:00:00.000Z" })
    const today = task({ dueAt: "2026-06-11T00:00:00.000Z" })
    const in7 = task({ dueAt: "2026-06-18T00:00:00.000Z" })
    const in9 = task({ dueAt: "2026-06-20T00:00:00.000Z" })
    const undated = task({ dueAt: null })
    expect(matchesDue(past, "overdue", NOW)).toBe(true)
    expect(matchesDue(today, "overdue", NOW)).toBe(false)
    expect(matchesDue(today, "week", NOW)).toBe(true)
    expect(matchesDue(in7, "week", NOW)).toBe(true)
    expect(matchesDue(in9, "week", NOW)).toBe(false)
    expect(matchesDue(past, "week", NOW)).toBe(false)
    expect(matchesDue(undated, "week", NOW)).toBe(false)
    expect(matchesDue(undated, "any", NOW)).toBe(true)
  })
})

describe("groupTasksBy", () => {
  const status = (id: string, name: string, position: number): TaskStatus => ({
    id,
    name,
    category: "todo",
    color: null,
    position,
    isDefault: false,
    archivedAt: null,
  })
  const priority = (id: string, name: string, position: number): TaskPriority => ({
    id,
    name,
    color: null,
    position,
    archivedAt: null,
  })
  const statuses = [status("s1", "Todo", 0), status("s2", "Doing", 1)]
  const priorities = [priority("p1", "High", 0)]

  it("status: one group per status in position order, unset/unknown trail; empty dropped", () => {
    const a = task({ statusId: "s2" })
    const b = task({ statusId: "s1" })
    const c = task({ statusId: null })
    const groups = groupTasksBy([a, b, c], "status", allOpen, NOW, statuses, priorities)
    expect(groups.map((g) => g.key)).toEqual(["s:s1", "s:s2", "s:none"])
    expect(groups[0]?.title).toBe("Todo")
    expect(groups[2]?.tasks.map((t) => t.id)).toEqual([c.id])
  })

  it("priority: groups by priorityId with a No-priority tail", () => {
    const a = task({ priorityId: "p1" })
    const b = task({ priorityId: null })
    const groups = groupTasksBy([a, b], "priority", allOpen, NOW, statuses, priorities)
    expect(groups.map((g) => g.key)).toEqual(["p:p1", "p:none"])
  })

  it("none: a single flat 'all' group sorted by due asc; empty input → no groups", () => {
    const late = task({ dueAt: "2026-08-01T00:00:00.000Z" })
    const soon = task({ dueAt: "2026-06-12T00:00:00.000Z" })
    const undated = task({ dueAt: null })
    const groups = groupTasksBy([late, undated, soon], "none", allOpen, NOW, statuses, priorities)
    expect(groups.map((g) => g.key)).toEqual(["all"])
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual([soon.id, late.id, undated.id])
    expect(groupTasksBy([], "none", allOpen, NOW, statuses, priorities)).toEqual([])
  })

  it("schedule delegates to the Zero-style buckets", () => {
    const groups = groupTasksBy(
      [task({ dueAt: "2026-06-11T00:00:00.000Z" })],
      "schedule",
      allOpen,
      NOW,
      statuses,
      priorities,
    )
    expect(groups.map((g) => g.key)).toEqual(["today"])
  })
})

describe("openTasksFor", () => {
  const ME = "u1"
  const cat = (byId: Record<string, string>) => (t: Task) => byId[t.statusId ?? ""]

  it("keeps only the user's open tasks: drops others', archived, closed and snoozed", () => {
    const mine = task({ assignee: ME, statusId: "todo" })
    const theirs = task({ assignee: "u2", statusId: "todo" })
    const unassigned = task({ assignee: null, statusId: "todo" })
    const archived = task({ assignee: ME, statusId: "todo", archivedAt: new Date() })
    const done = task({ assignee: ME, statusId: "done" })
    const cancelled = task({ assignee: ME, statusId: "cancelled" })
    const snoozed = task({
      assignee: ME,
      statusId: "todo",
      snoozedUntil: "2026-06-12T00:00:00.000Z", // after NOW
    })
    const woken = task({
      assignee: ME,
      statusId: "todo",
      snoozedUntil: "2026-06-10T00:00:00.000Z", // before NOW — snooze elapsed
    })
    const out = openTasksFor(
      [mine, theirs, unassigned, archived, done, cancelled, snoozed, woken],
      ME,
      cat({ todo: "started", done: "done", cancelled: "cancelled" }),
      NOW,
    )
    expect(out.map((t) => t.id)).toEqual([mine.id, woken.id])
  })

  it("sorts dated tasks soonest-first, then undated newest-first", () => {
    const later = task({ assignee: ME, dueAt: "2026-06-20T00:00:00.000Z" })
    const sooner = task({ assignee: ME, dueAt: "2026-06-12T00:00:00.000Z" })
    const oldUndated = task({ assignee: ME, createdAt: new Date("2026-05-01T00:00:00.000Z") })
    const newUndated = task({ assignee: ME, createdAt: new Date("2026-06-05T00:00:00.000Z") })
    const out = openTasksFor([oldUndated, later, newUndated, sooner], ME, () => undefined, NOW)
    expect(out.map((t) => t.id)).toEqual([sooner.id, later.id, newUndated.id, oldUndated.id])
  })

  it("reads `now` once, so a snooze boundary cannot shift mid-filter", () => {
    // Both snooze to exactly NOW+1ms. Evaluated against a single `now` they must
    // BOTH survive or BOTH drop — never split, which is what calling new Date()
    // inside the predicate risked.
    const at = new Date(NOW.getTime() + 1).toISOString()
    const a = task({ assignee: ME, snoozedUntil: at })
    const b = task({ assignee: ME, snoozedUntil: at })
    expect(openTasksFor([a, b], ME, () => undefined, NOW)).toHaveLength(0)
  })

  it("treats an unknown status as open (a purged status must not hide a task)", () => {
    const t = task({ assignee: ME, statusId: "gone" })
    expect(openTasksFor([t], ME, () => undefined, NOW).map((x) => x.id)).toEqual([t.id])
  })
})
