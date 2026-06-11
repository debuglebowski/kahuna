import { describe, expect, it } from "vitest"
import type { Task } from "../../rpc/contract"
import { daysOverdue, groupTasks } from "./taskGroups"

// Fixed "now": 2026-06-11 noon UTC — today=06-11, tomorrow=06-12.
const NOW = new Date("2026-06-11T12:00:00.000Z")

let seq = 0
const task = (over: Partial<Task>): Task => ({
  id: `t${++seq}`,
  subjectId: null,
  title: `task ${seq}`,
  statusId: null,
  assignee: null,
  dueAt: null,
  createdBy: null,
  customFields: {},
  version: 1,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  archivedAt: null,
  ...over,
})

const notDone = () => false
const keys = (tasks: Task[]) => groupTasks(tasks, notDone, NOW).map((g) => g.key)

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
    const groups = groupTasks([task({ dueAt: "2026-08-03T00:00:00.000Z" })], notDone, NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: "m:2026-08", title: "August 2026" })
  })

  it("sorts overdue by due date ascending (oldest debt first)", () => {
    const a = task({ dueAt: "2026-06-01T00:00:00.000Z" })
    const b = task({ dueAt: "2026-04-20T00:00:00.000Z" })
    const groups = groupTasks([a, b], notDone, NOW)
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual([b.id, a.id])
  })

  it("routes done tasks to the trailing done group regardless of due date", () => {
    const d = task({ dueAt: "2026-04-20T00:00:00.000Z" })
    const open = task({ dueAt: null })
    const groups = groupTasks([d, open], (t) => t.id === d.id, NOW)
    expect(groups.map((g) => g.key)).toEqual(["unscheduled", "done"])
  })
})

describe("daysOverdue", () => {
  it("counts whole days before today", () => {
    expect(daysOverdue("2026-06-01T00:00:00.000Z", NOW)).toBe(10)
    expect(daysOverdue("2026-06-11T00:00:00.000Z", NOW)).toBe(0)
    expect(daysOverdue("2026-06-12T00:00:00.000Z", NOW)).toBe(-1)
  })
})
