/**
 * Pure helpers for rendering the activity feed (no React/deps) — map an event
 * type to a human phrase, derive an inline snippet + expandable detail rows
 * from the raw event payload, and format timestamps. Kept testable.
 */

/** Human phrase for an event type. Falls back to a de-camel/snake-cased label. */
const LABELS: Record<string, string> = {
  InstanceCreated: "created this item",
  VersionCreated: "started a new version",
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
  TaskSnoozed: "snoozed a task",
  TaskUnsnoozed: "unsnoozed a task",
  TaskBlocked: "marked a task blocked",
  TaskUnblocked: "unblocked a task",
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

// ── payload-derived metadata ────────────────────────────────────────────────

/** Id → display-name lookups the feed wires in from whatever reference data it
 *  has loaded. Every lookup is optional and may miss (soft-deleted field,
 *  purged status/member) — helpers degrade to counts or generic words. */
export interface ActivityResolvers {
  readonly fieldName?: (id: string) => string | undefined
  readonly statusName?: (id: string) => string | undefined
  readonly priorityName?: (id: string) => string | undefined
  readonly userName?: (id: string) => string | undefined
}

/** One labelled row in the expanded detail view. Exactly one of `text` (plain
 *  string) or `fieldId`+`value` (instance field value, rendered kind-aware by
 *  the UI) is set. `hasPrev` marks a field edit whose overwritten value is
 *  known — the UI then renders `prev → value` (prev may be null = was empty). */
export interface ActivityDetailRow {
  readonly label: string
  readonly text?: string
  readonly fieldId?: string
  readonly value?: unknown
  readonly prev?: unknown
  readonly hasPrev?: boolean
}

const rec = (p: unknown): Record<string, unknown> =>
  p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

/** Single-line preview: collapse whitespace, cut at `max` with an ellipsis. */
export const clip = (s: string, max = 80): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** "Name, Status +2 more" — resolved field names, counts when none resolve. */
const fieldList = (ids: ReadonlyArray<string>, r: ActivityResolvers): string | null => {
  if (ids.length === 0) return null
  const known = ids.map((id) => r.fieldName?.(id)).filter((n): n is string => Boolean(n))
  if (known.length === 0) return ids.length === 1 ? "1 field" : `${ids.length} fields`
  const shown = known.slice(0, 3).join(", ")
  const more = ids.length - Math.min(known.length, 3)
  return more > 0 ? `${shown} +${more} more` : shown
}

const empty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)

const fmtDate = (v: unknown): string | null => {
  if (typeof v !== "string" || v === "") return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString()
}

/**
 * The muted inline snippet appended to the verb phrase ("edited fields —
 * Name, Status"). Null when the payload has nothing presentable.
 */
export const eventSnippet = (
  eventType: string,
  payload: unknown,
  r: ActivityResolvers = {},
): string | null => {
  const p = rec(payload)
  switch (eventType) {
    case "InstanceUpdated":
      return fieldList(Object.keys(rec(p.patch)), r)
    case "ComputedBandChanged": {
      const field = str(p.field)
      const to = str(p.to)
      if (!to) return null
      const name = (field && r.fieldName?.(field)) ?? field
      return `${name ? `${name}: ` : ""}${str(p.from) ?? "—"} → ${to}`
    }
    case "RelationCreated": {
      const fieldId = str(p.fieldId)
      return (fieldId && r.fieldName?.(fieldId)) ?? null
    }
    case "AttachmentAdded":
      return str(p.filename)
    case "NoteCreated":
    case "NoteUpdated": {
      const body = str(p.body)
      return body ? clip(body) : null
    }
    case "TaskCreated":
    case "TaskUpdated": {
      const title = str(p.title)
      return title ? clip(title) : null
    }
    case "TaskStatusChanged": {
      const from = str(p.from)
      const to = str(p.to)
      const f = from ? r.statusName?.(from) : null
      const t = to ? r.statusName?.(to) : null
      return f || t ? `${f ?? "—"} → ${t ?? "—"}` : null
    }
    case "TaskAssigned": {
      const who = (id: unknown): string =>
        typeof id === "string" && id !== "" ? (r.userName?.(id) ?? "former member") : "unassigned"
      return `${who(p.from)} → ${who(p.to)}`
    }
    case "TaskSnoozed": {
      const until = fmtDate(p.until)
      return until ? `until ${until}` : null
    }
    case "TaskBlocked": {
      const reason = str(p.reason)
      return reason ? clip(reason) : null
    }
    default:
      return null
  }
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Labelled rows for the expanded ("show more") view — the full metadata behind
 * the snippet: every changed field with its new value, the whole note body,
 * the task transition, etc. Empty when there is nothing beyond the phrase.
 * `previous` (field id → overwritten value, server-folded) turns field-edit
 * rows into from→to diffs.
 */
export const eventDetails = (
  eventType: string,
  payload: unknown,
  r: ActivityResolvers = {},
  previous?: unknown,
): ActivityDetailRow[] => {
  const p = rec(payload)
  const prevRec = rec(previous)
  const fieldRows = (state: Record<string, unknown>, skipEmpty: boolean): ActivityDetailRow[] =>
    Object.entries(state)
      .filter(([, v]) => !skipEmpty || !empty(v))
      .map(([fieldId, value]) => {
        const row = { label: r.fieldName?.(fieldId) ?? "Removed field", fieldId, value }
        return fieldId in prevRec && !same(prevRec[fieldId], value)
          ? { ...row, prev: prevRec[fieldId] ?? null, hasPrev: true }
          : row
      })
  switch (eventType) {
    case "InstanceCreated":
    case "VersionCreated":
      // Initial state: skip the untouched (empty) fields, show what was set.
      return fieldRows(rec(p.fields), true)
    case "InstanceUpdated":
      // The patch: keep nulls — "Status: —" reads as "cleared".
      return fieldRows(rec(p.patch), false)
    case "ComputedBandChanged": {
      const to = str(p.to)
      if (!to) return []
      const field = str(p.field)
      const name = (field && r.fieldName?.(field)) ?? field ?? "Band"
      return [{ label: name, text: `${str(p.from) ?? "—"} → ${to}` }]
    }
    case "RelationCreated": {
      const fieldId = str(p.fieldId)
      const name = fieldId ? r.fieldName?.(fieldId) : null
      return name ? [{ label: "Connection", text: name }] : []
    }
    case "AttachmentAdded": {
      const filename = str(p.filename)
      return filename ? [{ label: "File", text: filename }] : []
    }
    case "NoteCreated":
    case "NoteUpdated": {
      const body = str(p.body)
      return body ? [{ label: "Note", text: body }] : []
    }
    case "TaskCreated":
    case "TaskUpdated": {
      const rows: ActivityDetailRow[] = []
      const title = str(p.title)
      if (title) rows.push({ label: "Title", text: title })
      const status = str(p.statusId)
      if (status) rows.push({ label: "Status", text: r.statusName?.(status) ?? "—" })
      const priority = str(p.priorityId)
      if (priority) rows.push({ label: "Priority", text: r.priorityName?.(priority) ?? "—" })
      const assignee = str(p.assignee)
      if (assignee)
        rows.push({ label: "Assignee", text: r.userName?.(assignee) ?? "former member" })
      const due = fmtDate(p.dueAt)
      if (due) rows.push({ label: "Due", text: due })
      if (Array.isArray(p.labelIds) && p.labelIds.length > 0)
        rows.push({
          label: "Labels",
          text: p.labelIds.length === 1 ? "1 label" : `${p.labelIds.length} labels`,
        })
      if (p.descriptionChanged === true) rows.push({ label: "Description", text: "updated" })
      return rows
    }
    case "TaskStatusChanged": {
      const snippet = eventSnippet(eventType, payload, r)
      return snippet ? [{ label: "Status", text: snippet }] : []
    }
    case "TaskAssigned":
      return [{ label: "Assignee", text: eventSnippet(eventType, payload, r) ?? "" }]
    case "TaskSnoozed": {
      const until = fmtDate(p.until)
      return until ? [{ label: "Until", text: until }] : []
    }
    case "TaskBlocked": {
      const reason = str(p.reason)
      return reason ? [{ label: "Reason", text: reason }] : []
    }
    default:
      return []
  }
}

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
