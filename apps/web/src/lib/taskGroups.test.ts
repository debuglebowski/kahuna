import { describe, expect, it } from "vitest"
import type { Task } from "../../rpc/contract"
import { daysOverdue, groupTasks, isSnoozed, type TaskPredicates } from "./taskGroups"

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
