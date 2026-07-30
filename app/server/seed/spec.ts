import type { FieldConfig, FieldKind, TaskPrioritySpec, TaskStatusSpec } from "#engine"

/**
 * Default task statuses seeded for every new org (the annotation layer). Editable
 * afterwards in settings. `category` carries completion/grouping semantics so
 * nothing keys off the name; exactly one is `isDefault` (applied to new tasks).
 * Colors come from the PILL_COLORS palette so the settings picker shows them.
 */
export const defaultTaskStatuses: ReadonlyArray<TaskStatusSpec> = [
  { name: "Inbox", category: "todo", color: "#6b7280", isDefault: true },
  { name: "Todo", category: "todo", color: "#64748b" },
  { name: "In progress", category: "active", color: "#3b82f6" },
  { name: "Review", category: "active", color: "#8b5cf6" },
  { name: "Done", category: "done", color: "#22c55e" },
  { name: "Cancelled", category: "cancelled", color: "#78716c" },
]

/** Default task priorities seeded for every new org (ordered most → least
 *  urgent; a new task starts with none). Editable afterwards in settings. */
export const defaultTaskPriorities: ReadonlyArray<TaskPrioritySpec> = [
  { name: "Urgent", color: "#ef4444" },
  { name: "High", color: "#f97316" },
  { name: "Medium", color: "#f59e0b" },
  { name: "Low", color: "#3b82f6" },
  { name: "Someday", color: "#6b7280" },
]

export interface FieldSpec {
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  /** relation fields: the target concept's name, resolved to an id by the runner. */
  readonly targetName?: string
  /** Display glyph: a literal emoji or `lucide:Name` (see engine `Field.icon`). */
  readonly icon?: string
}

export interface ConceptSpec {
  readonly name: string
  /** Optional plural display label; the sidebar prefers it over `name`. */
  readonly pluralName?: string
  readonly description?: string
  /** Display glyph: a literal emoji or `lucide:Name` (see engine `Concept.icon`). */
  readonly icon?: string
  /** Display color: a hex from the web app's pill palette (see `PILL_COLORS`);
   *  tints the concept's items in the relationship graph. */
  readonly color?: string
  readonly fields: ReadonlyArray<FieldSpec>
}

/**
 * The Kingsmaker application model — a documentation-centric CRM + compliance
 * setup, defined entirely as data over the general engine. The runner folds it
 * into create-concept / add-field calls (event-sourced).
 *
 * Ownership/authorship uses the built-in `user` field kind (a real bauth_user,
 * validated against bauth_member at the app boundary). Inter-concept links are
 * `relation` fields whose `targetName` is resolved to a concept id at seed time:
 *
 *   CompanyContact -works_at->  Company
 *   CompanyContact -reports_to-> CompanyContact (self — org chart)
 *   CompanyNote    -about->     Company
 *   Agreement      -based_on->  AgreementTemplate
 *   Agreement      -for->       Company
 *   Agreement      -signed_by-> CompanyContact
 *   Task           -for->       Company
 */
export const kingsmakerSpec: ReadonlyArray<ConceptSpec> = [
  {
    name: "Company",
    pluralName: "Companies",
    description: "A customer or counterparty — the hub of the graph.",
    icon: "🏢",
    color: "#3b82f6",
    fields: [{ name: "name", kind: "text" }],
  },
  {
    name: "CompanyContact",
    pluralName: "Contacts",
    description: "A person at a company.",
    icon: "lucide:Contact",
    color: "#10b981",
    fields: [
      { name: "name", kind: "text" },
      { name: "email", kind: "text", config: { format: "email" }, icon: "✉️" },
      {
        name: "works_at",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
        icon: "🏢",
      },
      {
        name: "reports_to",
        kind: "relation",
        targetName: "CompanyContact",
        config: { cardinality: "one" },
        icon: "lucide:Network",
      },
    ],
  },
  {
    name: "CompanyNote",
    pluralName: "Notes",
    description: "A freeform note about a company.",
    icon: "📝",
    color: "#f59e0b",
    fields: [
      { name: "body", kind: "text" },
      { name: "noted_on", kind: "date", icon: "📅" },
      { name: "author", kind: "user", icon: "👤" },
      {
        name: "about",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
      },
    ],
  },
  {
    name: "AgreementTemplate",
    pluralName: "Agreement Templates",
    description: "A master template that agreements are executed from.",
    icon: "📋",
    color: "#8b5cf6",
    fields: [
      { name: "name", kind: "text" },
      { name: "doc_type", kind: "enum", config: { options: ["msa", "dpa", "nda", "sow"] } },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "active", "deprecated"],
          transitions: { draft: ["active"], active: ["deprecated"], deprecated: [] },
        },
      },
      { name: "version", kind: "number" },
      { name: "owner", kind: "user", icon: "👤" },
      { name: "body", kind: "file", icon: "📎" },
    ],
  },
  {
    name: "Agreement",
    pluralName: "Agreements",
    description: "An executed agreement — based on a template, for a company.",
    icon: "lucide:FileText",
    color: "#6366f1",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "active", "expired", "terminated"],
          transitions: {
            draft: ["active"],
            active: ["expired", "terminated"],
            expired: [],
            terminated: [],
          },
        },
      },
      { name: "effective_date", kind: "date", icon: "📅" },
      { name: "expiry_date", kind: "date", icon: "📅" },
      { name: "version", kind: "number" },
      { name: "owner", kind: "user", icon: "👤" },
      { name: "file", kind: "file", icon: "📎" },
      {
        name: "based_on",
        kind: "relation",
        targetName: "AgreementTemplate",
        config: { cardinality: "one" },
      },
      {
        name: "for",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
      },
      {
        name: "signed_by",
        kind: "relation",
        targetName: "CompanyContact",
        config: { cardinality: "one" },
      },
    ],
  },
  {
    name: "Policy",
    pluralName: "Policies",
    description: "An internal governance policy with a review cadence.",
    icon: "🛡️",
    color: "#f43f5e",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "category",
        kind: "enum",
        config: { options: ["security", "privacy", "hr", "finance"] },
      },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "review", "approved", "published", "archived"],
          transitions: {
            draft: ["review"],
            review: ["approved", "draft"],
            approved: ["published"],
            published: ["archived"],
            archived: [],
          },
        },
      },
      { name: "version", kind: "number" },
      { name: "effective_date", kind: "date" },
      { name: "review_due", kind: "date" },
      { name: "owner", kind: "user" },
      { name: "approved_by", kind: "user" },
      { name: "file", kind: "file" },
    ],
  },
  {
    name: "Task",
    pluralName: "Tasks",
    description: "A to-do assigned to a member, optionally tied to a company.",
    icon: "✅",
    color: "#0ea5e9",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["open", "in_progress", "done"],
          transitions: {
            open: ["in_progress", "done"],
            in_progress: ["done", "open"],
            done: ["open"],
          },
        },
      },
      { name: "due_date", kind: "date", icon: "📅" },
      { name: "assignee", kind: "user", icon: "👤" },
      {
        name: "for",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
      },
    ],
  },
  {
    name: "Runbook",
    pluralName: "Runbooks",
    description: "An internal operational runbook with a review cadence.",
    icon: "lucide:BookOpen",
    color: "#14b8a6",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "category",
        kind: "enum",
        config: { options: ["incident", "onboarding", "deploy", "support"] },
      },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "review", "published", "archived"],
          transitions: {
            draft: ["review"],
            review: ["published", "draft"],
            published: ["archived"],
            archived: [],
          },
        },
      },
      { name: "review_due", kind: "date" },
      { name: "owner", kind: "user" },
      { name: "file", kind: "file" },
    ],
  },
]
