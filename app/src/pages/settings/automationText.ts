import type { AutomationAction, AutomationTrigger } from "../../lib/api"

/**
 * Human sentences for the three slots — the list row, the editor summary and the
 * run history all read the same way, so this lives in one place.
 *
 * Deliberately id-agnostic where it can be: a caller that has the concept/field
 * names passes a resolver, and everything else degrades to the shape of the rule
 * rather than showing a raw uuid.
 */

export type NameLookup = (id: string | null | undefined) => string | null

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const hourLabel = (h: number | undefined): string => {
  const hour = h ?? 9
  return `${String(hour).padStart(2, "0")}:00`
}

const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/** "when Deal · Stage changes", "every Monday 09:00". */
export const describeTrigger = (
  t: AutomationTrigger,
  names?: { concept?: NameLookup; field?: NameLookup; status?: NameLookup },
): string => {
  const concept = names?.concept?.(t.conceptId) ?? (t.conceptId ? "record" : null)
  const field = names?.field?.(t.fieldId)
  const scope = concept ? `${concept} · ` : ""
  switch (t.kind) {
    case "record.created":
      return `when a ${concept ?? "record"} is created`
    case "record.changed":
      return field ? `when ${scope}${field} changes` : `when a ${concept ?? "record"} changes`
    case "record.archived":
      return `when a ${concept ?? "record"} is archived`
    case "version.published":
      return `when a ${concept ?? "record"} version is published`
    case "record.band.changed":
      return `when ${scope}${field ?? "a computed field"} becomes ${t.band ?? "any band"}`
    case "task.created":
      return concept ? `when a task is added to a ${concept}` : "when a task is created"
    case "task.status.changed": {
      const status = names?.status?.(t.statusId)
      return status ? `when a task becomes ${status}` : "when a task's status changes"
    }
    case "schedule": {
      if (t.every === "week") return `every ${WEEKDAYS[t.weekday ?? 1]} ${hourLabel(t.hour)}`
      if (t.every === "month")
        return `every month on the ${ordinal(t.day ?? 1)}, ${hourLabel(t.hour)}`
      return `every day at ${hourLabel(t.hour)}`
    }
    default:
      return "when something happens"
  }
}

/** A single action as a short phrase. */
export const describeAction = (
  a: AutomationAction,
  names?: { concept?: NameLookup; field?: NameLookup; label?: NameLookup },
): string => {
  switch (a.kind) {
    case "setField": {
      const field = names?.field?.(a.fieldId) ?? "a field"
      const value = a.value == null || a.value === "" ? "empty" : String(a.value)
      return `set ${field} to ${value}`
    }
    case "addLabel":
      return `add label ${names?.label?.(a.labelId) ?? ""}`.trim()
    case "removeLabel":
      return `remove label ${names?.label?.(a.labelId) ?? ""}`.trim()
    case "createTask":
      return `create task${a.title ? ` "${a.title}"` : ""}`
    case "createRecord":
      return `create a ${names?.concept?.(a.conceptId) ?? "record"}`
    case "archiveRecord":
      return "archive the record"
    case "notifySlack":
      return `post to ${a.channel || "Slack"}`
    case "webhook":
      return "call a webhook"
    default:
      return "do something"
  }
}

/** "post to #wins, create task" — the list row's right-hand side. */
export const summarizeActions = (
  actions: ReadonlyArray<AutomationAction>,
  names?: { concept?: NameLookup; field?: NameLookup; label?: NameLookup },
): string =>
  actions.length === 0 ? "nothing yet" : actions.map((a) => describeAction(a, names)).join(", ")

/** Trigger kinds offered in the editor, with the label the sentence reads. */
export const TRIGGER_OPTIONS: ReadonlyArray<{
  readonly kind: AutomationTrigger["kind"]
  readonly label: string
  /** Does this kind narrow by concept? */
  readonly concept: boolean
  readonly hint?: string
}> = [
  { kind: "record.created", label: "A record is created", concept: true },
  { kind: "record.changed", label: "A record changes", concept: true },
  { kind: "record.archived", label: "A record is archived", concept: true },
  { kind: "version.published", label: "A version is published", concept: true },
  {
    kind: "record.band.changed",
    label: "A record goes stale (decay band)",
    concept: true,
    hint: "Fires from the hourly decay sweep, so staleness works without any extra setup.",
  },
  { kind: "task.created", label: "A task is created", concept: true },
  { kind: "task.status.changed", label: "A task's status changes", concept: false },
  {
    kind: "schedule",
    label: "On a schedule",
    concept: true,
    hint: "Runs over every record matching the conditions — this is how you sweep, and why there is no loop.",
  },
]

export const ACTION_OPTIONS: ReadonlyArray<{
  readonly kind: AutomationAction["kind"]
  readonly label: string
  /** Needs the trigger record to act on (so it is useless on an org-level rule). */
  readonly needsRecord: boolean
}> = [
  { kind: "setField", label: "Set a field", needsRecord: true },
  { kind: "addLabel", label: "Add a label", needsRecord: true },
  { kind: "removeLabel", label: "Remove a label", needsRecord: true },
  { kind: "createTask", label: "Create a task", needsRecord: false },
  { kind: "createRecord", label: "Create a record", needsRecord: false },
  { kind: "archiveRecord", label: "Archive the record", needsRecord: true },
  { kind: "notifySlack", label: "Post to Slack", needsRecord: false },
  { kind: "webhook", label: "Call a webhook", needsRecord: false },
]

/** The tokens the editor advertises under a template field. */
export const TEMPLATE_TOKENS: ReadonlyArray<{ token: string; means: string }> = [
  { token: "{{record.title}}", means: "the record's title" },
  { token: "{{record.url}}", means: "a link to the record" },
  { token: "{{field:<id>}}", means: "one of its field values" },
  { token: "{{trigger.from}}", means: "the previous value" },
  { token: "{{trigger.to}}", means: "the new value" },
  { token: "{{now}}", means: "the current time" },
  // `renderTemplate` has always handled this one; it was simply never advertised.
  { token: "{{actor}}", means: "who (or what) triggered the run" },
]

/** A blank action of the given kind, valid enough to save. */
export const emptyAction = (kind: AutomationAction["kind"]): AutomationAction => {
  switch (kind) {
    case "setField":
      return { kind, fieldId: "", value: "" }
    case "addLabel":
    case "removeLabel":
      return { kind, labelId: "" }
    case "createTask":
      return { kind, title: "" }
    case "createRecord":
      return { kind, conceptId: "", fields: {} }
    case "archiveRecord":
      return { kind }
    case "notifySlack":
      return { kind, channel: "", text: "" }
    case "webhook":
      return { kind, url: "" }
  }
}
