import { describe, expect, it } from "vitest"
import { type ActivityResolvers, clip, eventDetails, eventSnippet } from "./activity"

const r: ActivityResolvers = {
  fieldName: (id) => ({ f1: "Name", f2: "Status" })[id],
  statusName: (id) => ({ s1: "Todo", s2: "Done" })[id],
  userName: (id) => ({ u1: "Alice", u2: "Bob" })[id],
}

describe("clip", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(clip("a\n  b\tc")).toBe("a b c")
    expect(clip("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`)
    expect(clip("short")).toBe("short")
  })
})

describe("eventSnippet", () => {
  it("lists resolved field names for RecordVersionUpdated", () => {
    expect(eventSnippet("RecordVersionUpdated", { patch: { f1: "v", f2: null } }, r)).toBe(
      "Name, Status",
    )
  })
  it("falls back to a count when no field name resolves", () => {
    expect(eventSnippet("RecordVersionUpdated", { patch: { gone: 1 } }, r)).toBe("1 field")
    expect(eventSnippet("RecordVersionUpdated", { patch: { a: 1, b: 2 } }, r)).toBe("2 fields")
  })
  it("caps the list and counts the rest", () => {
    const many: ActivityResolvers = { fieldName: (id) => `F${id}` }
    expect(eventSnippet("RecordVersionUpdated", { patch: { 1: 1, 2: 2, 3: 3, 4: 4 } }, many)).toBe(
      "F1, F2, F3 +1 more",
    )
  })
  it("previews note bodies and task titles, clipped", () => {
    expect(eventSnippet("NoteCreated", { body: "hello  world" }, r)).toBe("hello world")
    expect(eventSnippet("TaskCreated", { title: "Ship it" }, r)).toBe("Ship it")
    expect(eventSnippet("NoteUpdated", {}, r)).toBeNull()
  })
  it("renders task transitions with resolved names", () => {
    expect(eventSnippet("TaskStatusChanged", { from: "s1", to: "s2" }, r)).toBe("Todo → Done")
    expect(eventSnippet("TaskStatusChanged", { from: null, to: "s2" }, r)).toBe("— → Done")
    expect(eventSnippet("TaskAssigned", { from: "u1", to: null }, r)).toBe("Alice → unassigned")
    expect(eventSnippet("TaskAssigned", { from: "gone", to: "u2" }, r)).toBe("former member → Bob")
  })
  it("hides unresolvable status transitions instead of '— → —'", () => {
    expect(eventSnippet("TaskStatusChanged", { from: "x", to: "y" }, r)).toBeNull()
  })
  it("shows attachment filenames and relation field names", () => {
    expect(eventSnippet("AttachmentAdded", { filename: "report.pdf" }, r)).toBe("report.pdf")
    expect(eventSnippet("RelationCreated", { fieldId: "f2" }, r)).toBe("Status")
    expect(eventSnippet("RelationCreated", { fieldId: "gone" }, r)).toBeNull()
  })
  it("describes band drift", () => {
    expect(
      eventSnippet("ComputedBandChanged", { field: "f1", from: "warm", to: "cooling" }, r),
    ).toBe("Name: warm → cooling")
    expect(eventSnippet("ComputedBandChanged", { from: null, to: "cold" }, r)).toBe("— → cold")
  })
  it("is null for payload-free events and garbage payloads", () => {
    expect(eventSnippet("RecordVersionArchived", {}, r)).toBeNull()
    expect(eventSnippet("RecordVersionUpdated", undefined, r)).toBeNull()
    expect(eventSnippet("RecordVersionUpdated", "junk", r)).toBeNull()
  })
})

describe("eventDetails", () => {
  it("keeps nulls in an update patch (a cleared field) but skips empties on create", () => {
    expect(eventDetails("RecordVersionUpdated", { patch: { f1: "v", f2: null } }, r)).toEqual([
      { label: "Name", fieldId: "f1", value: "v" },
      { label: "Status", fieldId: "f2", value: null },
    ])
    expect(
      eventDetails("RecordVersionCreated", { fields: { f1: "v", f2: null, f3: "" } }, r),
    ).toEqual([{ label: "Name", fieldId: "f1", value: "v" }])
  })
  it("labels a patch key whose field def is gone", () => {
    expect(eventDetails("RecordVersionUpdated", { patch: { gone: 1 } }, r)).toEqual([
      { label: "Removed field", fieldId: "gone", value: 1 },
    ])
  })
  it("attaches the overwritten value when `previous` is provided", () => {
    expect(
      eventDetails("RecordVersionUpdated", { patch: { f1: "new", f2: "kept" } }, r, {
        f1: "old",
        f2: "kept",
      }),
    ).toEqual([
      { label: "Name", fieldId: "f1", value: "new", prev: "old", hasPrev: true },
      // unchanged value (no-op patch key) renders plain, no arrow
      { label: "Status", fieldId: "f2", value: "kept" },
    ])
  })
  it("marks 'was empty' with a null prev and skips fields absent from previous", () => {
    expect(
      eventDetails("RecordVersionUpdated", { patch: { f1: "v", f2: "w" } }, r, { f1: null }),
    ).toEqual([
      { label: "Name", fieldId: "f1", value: "v", prev: null, hasPrev: true },
      { label: "Status", fieldId: "f2", value: "w" },
    ])
  })
  it("shows a new version's initial fields like a create", () => {
    expect(eventDetails("VersionCreated", { fields: { f1: "v", f2: null } }, r)).toEqual([
      { label: "Name", fieldId: "f1", value: "v" },
    ])
  })
  it("returns the full note body and task fields", () => {
    expect(eventDetails("NoteCreated", { body: "line1\nline2" }, r)).toEqual([
      { label: "Note", text: "line1\nline2" },
    ])
    expect(
      eventDetails(
        "TaskCreated",
        { title: "Ship", statusId: "s1", assignee: "u2", dueAt: "2026-06-12" },
        r,
      ),
    ).toEqual([
      { label: "Title", text: "Ship" },
      { label: "Status", text: "Todo" },
      { label: "Assignee", text: "Bob" },
      { label: "Due", text: new Date("2026-06-12").toLocaleDateString() },
    ])
  })
  it("is empty for payload-free events", () => {
    expect(eventDetails("RecordVersionArchived", {}, r)).toEqual([])
    expect(eventDetails("RecordRestored", undefined, r)).toEqual([])
  })
})
