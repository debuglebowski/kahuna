/**
 * Pure helpers for rendering the activity feed (no React/deps) — map an event
 * type to a human phrase and a timestamp to a relative string. Kept testable.
 */

/** Human phrase for an event type. Falls back to a de-camel/snake-cased label. */
const LABELS: Record<string, string> = {
  InstanceCreated: "created this item",
  InstanceUpdated: "edited fields",
  InstanceArchived: "archived this item",
  InstanceRestored: "restored this item",
  InstancePurged: "deleted this item",
  ComputedBandChanged: "status drifted",
  RelationCreated: "added a connection",
  RelationDeleted: "removed a connection",
  AttachmentAdded: "added an attachment",
  ItemArchived: "archived this item",
  ItemRestored: "restored this item",
  NoteCreated: "added a note",
  NoteUpdated: "edited a note",
  NoteArchived: "archived a note",
  NoteRestored: "restored a note",
  NotePurged: "deleted a note",
  TaskCreated: "added a task",
  TaskUpdated: "edited a task",
  TaskStatusChanged: "changed a task's status",
  TaskAssigned: "reassigned a task",
  TaskArchived: "archived a task",
  TaskRestored: "restored a task",
  TaskPurged: "deleted a task",
}

export const eventLabel = (eventType: string): string =>
  LABELS[eventType] ??
  eventType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .toLowerCase()

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** A short relative time ("just now", "5 min ago", "3 days ago"). `now` is
 *  injectable for testing (defaults to wall-clock). */
export const relativeTime = (d: Date, now: Date = new Date()): string => {
  const secs = Math.round((d.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(secs)
  if (abs < 45) return "just now"
  const min = Math.round(secs / 60)
  if (Math.abs(min) < 60) return RTF.format(min, "minute")
  const hr = Math.round(secs / 3600)
  if (Math.abs(hr) < 24) return RTF.format(hr, "hour")
  const day = Math.round(secs / 86400)
  if (Math.abs(day) < 30) return RTF.format(day, "day")
  const month = Math.round(day / 30)
  if (Math.abs(month) < 12) return RTF.format(month, "month")
  return RTF.format(Math.round(day / 365), "year")
}
