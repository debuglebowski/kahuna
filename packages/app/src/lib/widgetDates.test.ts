import { describe, expect, it } from "vitest"
import type { Field, RecordVersion, Task } from "./api"
import {
  agendaEvents,
  dayKeyOf,
  eventsByDay,
  ganttSpans,
  ganttTicks,
  ganttWindow,
  monthGridDays,
  sourceColor,
  sourceEvents,
  taskEvents,
  weekDays,
} from "./widgetDates"

const inst = (id: string, state: Record<string, unknown>): RecordVersion =>
  ({ id, state, version: 1, createdAt: new Date(), archivedAt: null }) as unknown as RecordVersion

const field = (id: string, kind: string, name = id): Field =>
  ({ id, kind, name, config: {} }) as unknown as Field

describe("dayKeyOf", () => {
  it("normalizes stored date shapes to a day key", () => {
    expect(dayKeyOf("2026-06-12")).toBe("2026-06-12")
    expect(dayKeyOf("2026-06-12T10:30:00.000Z")).toBe("2026-06-12")
    expect(dayKeyOf(["2026-01-05", "2026-02-06"])).toBe("2026-01-05") // multiple → first
  })

  it("rejects absent/invalid values", () => {
    expect(dayKeyOf(null)).toBeNull()
    expect(dayKeyOf(undefined)).toBeNull()
    expect(dayKeyOf("")).toBeNull()
    expect(dayKeyOf("not a date")).toBeNull()
    expect(dayKeyOf(42)).toBeNull()
    expect(dayKeyOf([])).toBeNull()
  })
})

describe("calendar windowing", () => {
  it("month grid covers whole Monday-start weeks", () => {
    const days = monthGridDays(new Date(2026, 5, 12)) // June 2026
    expect(days.length % 7).toBe(0)
    expect(days[0]!.getDay()).toBe(1) // Monday
    expect([days[0]!.getMonth(), days[0]!.getDate()]).toEqual([5, 1]) // Jun 1 IS a Monday
    expect(days[days.length - 1]!.getDay()).toBe(0) // Sunday
  })

  it("week days run Monday through Sunday around the anchor", () => {
    const days = weekDays(new Date(2026, 5, 12)) // Fri Jun 12 2026
    expect(days).toHaveLength(7)
    expect(days[0]!.getDate()).toBe(8) // Mon Jun 8
    expect(days[6]!.getDate()).toBe(14) // Sun Jun 14
  })
})

describe("sourceEvents", () => {
  const fields = [field("name", "text"), field("due", "date"), field("stage", "enum")]
  const recordVersions = [
    inst("a", { name: "Alpha", due: "2026-06-10", stage: "open" }),
    inst("b", { name: "Beta", due: "2026-06-11", stage: "won" }),
    inst("c", { name: "Gamma", stage: "open" }), // no date → skipped
  ]

  it("plots matching recordVersions on their date field", () => {
    const events = sourceEvents({ conceptId: "c1", dateField: "due" }, 0, recordVersions, fields)
    expect(events.map((e) => [e.day, e.label])).toEqual([
      ["2026-06-10", "Alpha"],
      ["2026-06-11", "Beta"],
    ])
    expect(events[0]!.href).toBe("/records/a")
  })

  it("applies per-source conditions and label field", () => {
    const events = sourceEvents(
      {
        conceptId: "c1",
        dateField: "due",
        labelField: "stage",
        conditions: [{ field: "stage", op: "eq", value: "open" }],
      },
      0,
      recordVersions,
      fields,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.label).toBe("open")
  })

  it("cycles fallback colors by source index, explicit color wins", () => {
    expect(sourceColor(null, 0)).not.toBe(sourceColor(null, 1))
    expect(sourceColor("#123456", 3)).toBe("#123456")
  })
})

describe("taskEvents + agenda", () => {
  const task = (id: string, dueAt: string | null, archived = false): Task =>
    ({ id, title: id, dueAt, archivedAt: archived ? new Date() : null }) as unknown as Task

  it("plots due, non-archived tasks", () => {
    const events = taskEvents([
      task("t1", "2026-06-12"),
      task("t2", null),
      task("t3", "2026-06-13", true),
    ])
    expect(events.map((e) => e.id)).toEqual(["task:t1"])
  })

  it("agenda lists today-and-later in day order, capped", () => {
    const events = taskEvents([
      task("past", "2026-06-01"),
      task("later", "2026-07-01"),
      task("today", "2026-06-12"),
    ])
    const upcoming = agendaEvents(events, new Date(2026, 5, 12))
    expect(upcoming.map((e) => e.day)).toEqual(["2026-06-12", "2026-07-01"])
    expect(agendaEvents(events, new Date(2026, 5, 12), 1)).toHaveLength(1)
  })

  it("buckets events by day, keeping order", () => {
    const byDay = eventsByDay(taskEvents([task("a", "2026-06-12"), task("b", "2026-06-12")]))
    expect(byDay.get("2026-06-12")!.map((e) => e.id)).toEqual(["task:a", "task:b"])
  })
})

describe("ganttSpans", () => {
  const fields = [field("name", "text"), field("start", "date"), field("end", "date")]
  const cfg = { startField: "start", endField: "end", conditions: [] }

  it("builds start-ordered spans; no start → skipped, no end → milestone", () => {
    const spans = ganttSpans(
      cfg,
      [
        inst("b", { name: "B", start: "2026-06-10", end: "2026-06-20" }),
        inst("a", { name: "A", start: "2026-06-05" }),
        inst("x", { name: "X", end: "2026-06-09" }), // no start
      ],
      fields,
    )
    expect(spans.map((s) => s.id)).toEqual(["a", "b"])
    expect(spans[0]!.end).toBeNull()
    expect(spans[1]!.end).toBe("2026-06-20")
  })

  it("treats an end before its start as a milestone, clamps progress", () => {
    const spans = ganttSpans(
      { ...cfg, progressField: "p" },
      [inst("a", { name: "A", start: "2026-06-10", end: "2026-06-01", p: 250 })],
      fields,
    )
    expect(spans[0]!.end).toBeNull()
    expect(spans[0]!.progress).toBe(100)
  })

  it("lanes by the group field's first value", () => {
    const spans = ganttSpans(
      { ...cfg, groupBy: "team" },
      [inst("a", { name: "A", start: "2026-06-10", team: ["red", "blue"] })],
      fields,
    )
    expect(spans[0]!.group).toBe("red")
  })
})

describe("ganttWindow", () => {
  const today = new Date(2026, 5, 12)
  const span = (start: string, end: string | null) => ({
    id: "s",
    start,
    end,
    label: "s",
    group: "",
    progress: null,
  })

  it("fit hugs the spans with a small pad", () => {
    const w = ganttWindow([span("2026-06-10", "2026-06-20")], "fit", today)
    expect(w.start.getDate()).toBe(7)
    expect(w.end.getDate()).toBe(23)
  })

  it("fit with no spans falls back to a window around today", () => {
    const w = ganttWindow([], "fit", today)
    expect(w.start < today && today < w.end).toBe(true)
  })

  it("quarter spans the current calendar quarter", () => {
    const w = ganttWindow([], "quarter", today)
    expect([w.start.getMonth(), w.start.getDate()]).toEqual([3, 1]) // Apr 1
    expect([w.end.getMonth(), w.end.getDate()]).toEqual([5, 30]) // Jun 30
  })
})

describe("ganttTicks", () => {
  it("week ticks land on Mondays inside the window", () => {
    const ticks = ganttTicks(new Date(2026, 5, 10), new Date(2026, 5, 30), "week")
    expect(ticks.map((t) => t.label)).toEqual(["Jun 15", "Jun 22", "Jun 29"])
    expect(ticks[0]!.offset).toBe(5)
  })

  it("month ticks land on month starts", () => {
    const ticks = ganttTicks(new Date(2026, 4, 20), new Date(2026, 7, 10), "month")
    expect(ticks.map((t) => t.label)).toEqual(["Jun", "Jul", "Aug"])
  })

  it("day ticks label every day, spelling the month at the window start and the 1st", () => {
    const ticks = ganttTicks(new Date(2026, 5, 29), new Date(2026, 6, 2), "day")
    expect(ticks.map((t) => t.label)).toEqual(["Jun 29", "30", "Jul 1", "2"])
  })
})
