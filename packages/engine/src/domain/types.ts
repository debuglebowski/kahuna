import { Schema } from "effect"
import type { RichTextValue } from "./richtext"

/**
 * Lightweight id aliases. (Branded ids were considered but add constant
 * brand/unbrand friction against raw SQL strings; v1 keeps them as plain
 * strings. Anti-drift is enforced via field validation + state machines +
 * typed errors instead.)
 */
export type Id = string
export type OrgId = string
export type Actor = string

export const FieldKind = Schema.Literal(
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "relation",
  "file",
  "computed",
  // refs a real org member (bauth_user.id); stored in state like a scalar.
  "user",
  // arbitrary JSON-serializable blob (escape hatch for unmodeled data).
  "json",
  // an { amount, currency } pair.
  "money",
  // rich text: a { doc, text } envelope — ProseMirror JSON + extracted plain text.
  "richtext",
)
export type FieldKind = typeof FieldKind.Type

/** Per-field configuration, stored in `fields.config` (jsonb). */
export interface FieldConfig {
  /** enum: allowed values */
  readonly options?: ReadonlyArray<string>
  /** enum: display color per option (`value -> #rrggbb`); missing = neutral. */
  readonly optionColors?: Record<string, string>
  /** enum: legal state-machine transitions `from -> [to, ...]` */
  readonly transitions?: Record<string, ReadonlyArray<string>>
  /** relation: the target concept's id (the relation's identity is its field id). */
  readonly target?: string
  readonly cardinality?: "one" | "many"
  /** relation: how the TARGET side names the connection (field "Employees" on
   *  Company targeting Person reads "Employer" from the Person side). Decorative
   *  like the field name; absent = the target side falls back to the field name. */
  readonly inverseName?: string
  /** relation: plural of `inverseName`; the UI picks singular/plural by count. */
  readonly inversePluralName?: string
  /** computed: which built-in + its params */
  readonly computedKind?: "decay" | "momentum"
  readonly params?: Record<string, unknown>
  /** any scalar kind: store/validate an array of values instead of a single one. */
  readonly multiple?: boolean
  /** text/number: an extra format constraint (email/url/phone/slug/color | percent). */
  readonly format?: string
  /** How required a value is (scalar kinds only — never relation/file/computed).
   *  `required` blocks create without a value and blocks clearing it; on a
   *  versioned concept publish is gated too (a draft may predate the rule).
   *  `flagged` never blocks — missing values are surfaced in the UI.
   *  Absent = `optional`. */
  readonly requirement?: "required" | "flagged" | "optional"
  /** No two items of the concept may hold the same value (text/number/date/
   *  enum/user/money only; never with `multiple`). Archived items keep their
   *  claim — only a purge releases a value, so a restore can never resurface a
   *  duplicate. Text compares case-insensitively. Versions of one item share
   *  values freely; missing values never conflict. Enforced write-time —
   *  enabling it on a field with existing cross-item duplicates is rejected. */
  readonly unique?: boolean
}

/** Instance field values, keyed by field **id** (`fields.id`). Synthetic keys
 *  prefixed with `__` (e.g. `__bands`, `__labels`) are engine markers, not fields.
 *  `__labels` holds this item's own label ids (an array of `labels.id`); it rides
 *  the normal InstanceCreated/InstanceUpdated payloads and folds like any state key. */
export type InstanceState = Record<string, unknown>

/** Synthetic `InstanceState` key holding an instance's own label ids. */
export const LABELS_KEY = "__labels"

export interface Concept {
  readonly id: Id
  readonly orgId: OrgId
  /** Stable, immutable system key (derived from the initial name). Code that must
   *  pin a specific concept (dashboards, computed scans) refers to this, never the
   *  display name — so the name is free to be renamed. */
  readonly slug: string
  readonly name: string
  /** Optional plural display label (e.g. `name` "Company" → "Companies"). The
   *  sidebar prefers it and falls back to `name`; null until set (creation only
   *  asks for the singular). */
  readonly pluralName: string | null
  readonly description: string | null
  /** Optional display glyph: a literal emoji or a curated lucide icon name
   *  prefixed `lucide:` (e.g. `lucide:Building2`); null renders none. */
  readonly icon: string | null
  /** Optional display color (hex, same pill palette as labels) used to tint the
   *  concept wherever instances are visualised; null renders neutral. */
  readonly color: string | null
  /** Label ids inherited by every instance of this concept (read-time, never
   *  written per item — so they can't be removed on an individual item). */
  readonly staticLabelIds: ReadonlyArray<Id>
  /** Label ids snapshotted onto each new instance's `__labels` at creation time;
   *  editable per item afterward. */
  readonly defaultLabelIds: ReadonlyArray<Id>
  /** Opt-in versioning: when true, this concept's items hold multiple draft→
   *  published versions and references may pin a specific version. Default false
   *  ⇒ the plain 1-instance-per-item model (every item is a published seq-1 row). */
  readonly versioningEnabled: boolean
  readonly createdAt: Date
  /** Archive marker (mirrors `Field`/`Label`/`Instance`): non-null = archived
   *  (hidden from the live list but restorable). A true delete removes the row. */
  readonly archivedAt: Date | null
  /** Total instances (live + archived) — present only when listed `withCounts`.
   *  Drives the settings "N items" hint + what blocks a concept purge. */
  readonly itemCount?: number
}

/** A label in the org-wide, flat vocabulary. Keyed by `id`; `name`/`color` are
 *  freely editable; soft-deleted so any id it ever owned stays resolvable. */
export interface Label {
  readonly id: Id
  readonly orgId: OrgId
  readonly name: string
  /** Optional free hex color (e.g. "#e11d48"); null renders neutral. */
  readonly color: string | null
  /** A plain flag for now (rendered with a crown); future features key off it. */
  readonly primary: boolean
  readonly createdAt: Date
  readonly archivedAt: Date | null
}

/** Identify a concept by exactly one handle (compile-time exclusive). */
export type ConceptRef = { readonly conceptId: string } | { readonly conceptName: string }

export interface Field {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  /** Decorative, freely-renameable label. The stable key is `id`. */
  readonly name: string
  readonly kind: FieldKind
  readonly formula: string | null
  readonly config: FieldConfig
  /** Optional display glyph (see `Concept.icon`): literal emoji or `lucide:Name`. */
  readonly icon: string | null
  /** Display order within the concept (ascending); ties broken by name. */
  readonly position: number
  /** Soft-delete marker; non-null fields are hidden from `listFields` but stay
   *  resolvable by `id` (so orphaned state keys / historical edges resolve). */
  readonly archivedAt: Date | null
}

/** The lineage row for a logical "item" — the stable identity across a concept's
 *  versions. References point at an `Item` ("Latest"); whole-item archive lives
 *  here. For a non-versioned concept the mapping to instances is 1:1. */
export interface Item {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  /** Whole-item (lineage-level) archive marker; hides every version from lists. */
  readonly archivedAt: Date | null
  readonly createdAt: Date
}

/** Product version lifecycle: a version is an editable `draft`, then a frozen,
 *  immutable, referenceable `published`. One-shot (`published` is permanent). */
export type VersionStatus = "draft" | "published"

export interface Instance {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  /** The lineage (`items.id`) this version belongs to. Immutable. For a
   *  non-versioned concept or any legacy row, `itemId === id` (1:1). */
  readonly itemId: Id
  readonly state: InstanceState
  /** Optimistic-concurrency EVENT counter — NOT the product version (see
   *  `versionSeq`). Bumps on every mutating event including publish. */
  readonly version: number
  /** Product version status: 'draft' (editable) | 'published' (frozen). */
  readonly versionStatus: VersionStatus
  /** Sequence within the lineage (1,2,3…). Immutable. */
  readonly versionSeq: number
  /** When this version was published; null while a draft. */
  readonly publishedAt: Date | null
  readonly createdAt: Date
  readonly archivedAt: Date | null
}

export interface Relation {
  readonly id: Id
  readonly orgId: OrgId
  /** The relation field def (kind=relation) this edge realises. */
  readonly fieldId: Id
  readonly fromId: Id
  /** The referenced lineage ("Latest" target) — always set. */
  readonly toItemId: Id
  /** Pinned published version, or null = resolve to the item's latest published. */
  readonly toVersionId: Id | null
  /** Legacy resolved-target column (shadow during migration; superseded by
   *  `toItemId`/`toVersionId`). Still populated on new edges. */
  readonly toId: Id
  readonly properties: Record<string, unknown>
  readonly createdAt: Date
  readonly archivedAt: Date | null
}

export type EventPayload =
  | {
      readonly _tag: "InstanceCreated"
      readonly conceptId: Id
      readonly fields: InstanceState
      // Versioning lineage metadata, carried so a full replay reconstructs the
      // version status/lineage. Absent on legacy events ⇒ the reducer defaults to
      // a published, seq-1, 1:1 lineage (`itemId` falls back to the instance id).
      readonly itemId?: Id
      readonly versionSeq?: number
      readonly versionStatus?: VersionStatus
    }
  | { readonly _tag: "InstanceUpdated"; readonly patch: InstanceState }
  // Archive (soft, restorable). `InstanceDeleted` is the legacy archive tag kept
  // for replay; new archives emit `InstanceArchived`. Both fold to a set
  // `archivedAt`; `InstanceRestored` clears it again (see projection/reducer).
  | { readonly _tag: "InstanceDeleted" }
  | { readonly _tag: "InstanceArchived" }
  | { readonly _tag: "InstanceRestored" }
  // Draft → published transition (one-shot, immutable). Folds `versionStatus` to
  // 'published' + sets `publishedAt`, bumping the event counter. Only after this
  // does the version become referenceable ("Latest").
  | { readonly _tag: "VersionPublished" }
  // Audit tombstone for a hard delete: the row + attachments are gone, but the
  // prior events stay as history. Never folded (the subject no longer loads), so
  // the reducer doesn't handle it — it only surfaces in the activity feed.
  | { readonly _tag: "InstancePurged" }
  | {
      readonly _tag: "RelationCreated"
      readonly fieldId: Id
      readonly fromId: Id
      readonly toId: Id
      // New reference shape (absent on legacy events). `toItemId` = referenced
      // lineage; `toVersionId` null/absent = general ("Latest"), set = pinned.
      readonly toItemId?: Id
      readonly toVersionId?: Id | null
      readonly properties: Record<string, unknown>
    }
  | { readonly _tag: "RelationDeleted"; readonly relationId: Id }
  | { readonly _tag: "AttachmentAdded"; readonly attachmentId: Id; readonly filename: string }
  | { readonly _tag: "ConceptCreated"; readonly name: string }
  | {
      readonly _tag: "FieldAdded"
      readonly conceptId: Id
      readonly name: string
      readonly kind: string
    }
  // Emitted by the server decay tick when a time-derived computed band crosses a
  // threshold (e.g. decay warm -> cooling). Folds into a `__bands` marker WITHOUT
  // bumping version (like AttachmentAdded), so it never collides with a user's
  // optimistic-concurrency check.
  | {
      readonly _tag: "ComputedBandChanged"
      readonly field: string
      readonly kind: "decay" | "momentum"
      readonly from: string | null
      readonly to: string
    }
  // Concept/field schema edits (settings → concept configuration). These are
  // subjectKind "concept"/"field" events — they NEVER appear in an instance
  // stream, so the instance reducer (projection/reducer.ts) ignores them.
  | {
      readonly _tag: "ConceptUpdated"
      readonly description: string | null
      readonly name?: string
      readonly pluralName?: string | null
      readonly icon?: string | null
      readonly color?: string | null
      readonly versioningEnabled?: boolean
      readonly staticLabelIds?: ReadonlyArray<Id>
      readonly defaultLabelIds?: ReadonlyArray<Id>
    }
  | { readonly _tag: "ConceptArchived" }
  | { readonly _tag: "ConceptRestored" }
  | { readonly _tag: "ConceptDeleted" }
  // Label vocabulary edits (settings → Labels). subjectKind "label"; like
  // concept/field schema events these never appear in an instance stream.
  | {
      readonly _tag: "LabelCreated"
      readonly name: string
      readonly color: string | null
      readonly primary: boolean
    }
  | {
      readonly _tag: "LabelRenamed"
      readonly name: string
      readonly color: string | null
      readonly primary: boolean
    }
  | { readonly _tag: "LabelArchived" }
  | { readonly _tag: "LabelRestored" }
  | { readonly _tag: "LabelDeleted" }
  | {
      readonly _tag: "FieldUpdated"
      readonly conceptId: Id
      readonly name: string
      readonly kind: string
    }
  | { readonly _tag: "FieldArchived"; readonly conceptId: Id; readonly name: string }
  | { readonly _tag: "FieldRestored"; readonly conceptId: Id; readonly name: string }
  | { readonly _tag: "FieldDeleted"; readonly conceptId: Id; readonly name: string }
  // Whole-item (lineage) archive/restore. subjectKind "item"; like concept/field
  // events these never appear in an instance stream (the reducer ignores them).
  | { readonly _tag: "ItemArchived" }
  | { readonly _tag: "ItemRestored" }
  // ── annotation layer (notes/tasks) ──────────────────────────────────────────
  // subjectKind "note"/"task", subject_id = the annotation's id (its own stream,
  // never folded). `subjectId` in the payload records the annotated ITEM lineage
  // (items.id) or null (org-level) — distinct from the event's own subjectId — so
  // the per-item activity union + purge tombstones survive the row's deletion.
  | {
      readonly _tag: "NoteCreated"
      readonly subjectId: Id | null
      readonly body: string
      readonly customFields: Record<string, unknown>
    }
  | {
      readonly _tag: "NoteUpdated"
      readonly body?: string
      readonly customFields?: Record<string, unknown>
    }
  | { readonly _tag: "NoteArchived"; readonly subjectId: Id | null }
  | { readonly _tag: "NoteRestored"; readonly subjectId: Id | null }
  | { readonly _tag: "NotePurged"; readonly subjectId: Id | null }
  | {
      readonly _tag: "TaskCreated"
      readonly subjectId: Id | null
      readonly title: string
      readonly statusId: Id | null
      readonly assignee: string | null
      readonly dueAt: string | null
      readonly customFields: Record<string, unknown>
      // Absent on legacy events (pre-priority/labels/description).
      readonly priorityId?: Id | null
      readonly labelIds?: ReadonlyArray<Id>
      readonly hasDescription?: boolean
    }
  | {
      readonly _tag: "TaskUpdated"
      readonly title?: string
      readonly dueAt?: string | null
      readonly customFields?: Record<string, unknown>
      readonly priorityId?: Id | null
      readonly labelIds?: ReadonlyArray<Id>
      // The description envelope is too large for an audit payload — events
      // carry only the fact that it changed.
      readonly descriptionChanged?: boolean
    }
  | { readonly _tag: "TaskStatusChanged"; readonly from: Id | null; readonly to: Id }
  | { readonly _tag: "TaskAssigned"; readonly from: string | null; readonly to: string | null }
  | { readonly _tag: "TaskSnoozed"; readonly until: string }
  | { readonly _tag: "TaskUnsnoozed" }
  | {
      readonly _tag: "TaskBlocked"
      readonly reason: string | null
      readonly taskId: Id | null
    }
  | { readonly _tag: "TaskUnblocked" }
  | { readonly _tag: "TaskArchived"; readonly subjectId: Id | null }
  | { readonly _tag: "TaskRestored"; readonly subjectId: Id | null }
  | { readonly _tag: "TaskPurged"; readonly subjectId: Id | null }
  // Task-status vocabulary edits (settings). subjectKind "taskStatus".
  | { readonly _tag: "TaskStatusCreated"; readonly name: string; readonly category: string }
  | { readonly _tag: "TaskStatusUpdated"; readonly name: string; readonly category: string }
  | { readonly _tag: "TaskStatusArchived" }
  | { readonly _tag: "TaskStatusRestored" }
  | { readonly _tag: "TaskStatusReordered" }
  // Task-priority vocabulary edits (settings). subjectKind "taskPriority".
  | { readonly _tag: "TaskPriorityCreated"; readonly name: string }
  | { readonly _tag: "TaskPriorityUpdated"; readonly name: string }
  | { readonly _tag: "TaskPriorityArchived" }
  | { readonly _tag: "TaskPriorityRestored" }
  | { readonly _tag: "TaskPriorityReordered" }
  // Annotation custom-field definition edits (settings). subjectKind "annotationField".
  | {
      readonly _tag: "AnnotationFieldAdded"
      readonly annotationType: string
      readonly name: string
      readonly kind: string
    }
  | {
      readonly _tag: "AnnotationFieldUpdated"
      readonly annotationType: string
      readonly name: string
      readonly kind: string
    }
  | { readonly _tag: "AnnotationFieldArchived"; readonly annotationType: string }
  | { readonly _tag: "AnnotationFieldRestored"; readonly annotationType: string }
  | { readonly _tag: "AnnotationFieldReordered"; readonly annotationType: string }

export interface Attachment {
  readonly id: Id
  readonly orgId: OrgId
  readonly instanceId: Id
  readonly filename: string
  readonly contentRef: string
  readonly mimeType: string | null
  readonly sizeBytes: number | null
  readonly createdAt: Date
}

// ── shared filter conditions ───────────────────────────────────────────────────
// Used by the dashboard widget types below; the "Sidebar" prefix is historical —
// sidebar sections no longer carry conditions. These mirror the contract's
// schemas (kept separate so the contract stays engine-free).

/** One filter condition. `field` is a field id, or `__labels` for the label ops.
 *  Value shape varies by op: `between` = [min, max], `in`/`notIn` = an array,
 *  `empty`/`notEmpty`/`isMe` ignore it. Op set is APPEND-ONLY (bodies holding
 *  conditions are opaque persisted documents old clients must keep parsing). */
export interface SidebarCondition {
  readonly field: string
  readonly op:
    | "eq"
    | "hasLabel"
    | "neq"
    | "contains"
    | "empty"
    | "notEmpty"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "between"
    | "in"
    | "notIn"
    | "isMe"
    | "notHasLabel"
  readonly value: unknown
}
/** How a condition set combines: every condition or at least one (absent = all). */
export type ConditionMatch = "all" | "any"

// ── sidebar views (configurable nav layouts) ───────────────────────────────────
// The whole layout is the serializable `SidebarViewBody` below. It is OPAQUE to
// the engine (never read or filtered server-side); the web client resolves it.
// The global nav items (Overview, Tasks, …) render in a fixed block above the
// sections unless placed into one (a `global:<key>` entry).

export interface SidebarSection {
  readonly id: string
  readonly title: string | null
  readonly icon: string | null
  readonly collapsed?: boolean
  /** Ordered, explicitly-placed entries: a dashboard uuid, or `global:<key>`
   *  for a placed global nav item. Unknown/deleted ids are skipped at render
   *  time (kept in the body so nothing is silently pruned). */
  readonly entryIds: ReadonlyArray<string>
}
export interface SidebarViewBody {
  readonly sections: ReadonlyArray<SidebarSection>
}
export interface SidebarView {
  readonly id: Id
  readonly orgId: OrgId
  /** null = org-shared (any member); non-null = personal to that user. */
  readonly ownerId: string | null
  readonly name: string
  readonly icon: string | null
  readonly position: number
  readonly hidden: boolean
  readonly body: SidebarViewBody
  readonly createdAt: Date
  readonly updatedAt: Date
}

// ── dashboards (configurable widget canvases) ──────────────────────────────────
// Same contract as SidebarView: the `DashboardBody` is OPAQUE to the engine
// (never read or filtered server-side); the web client resolves each widget
// against the live concept/instance/event collections. Reuses `SidebarCondition`
// for filters. These mirror the contract's `Dashboard*` schemas (kept separate so
// the contract stays engine-free). The widget union is APPEND-ONLY — never reshape
// an existing widget; add new types at the end.

/** A widget's placement on the grid canvas (react-grid-layout coords). */
export interface WidgetLayout {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
/** Fields shared by every widget. `conceptId` is OPTIONAL so the same body can
 *  render in per-concept context (implicit conceptId) later. */
interface WidgetBase {
  readonly id: string
  readonly title: string | null
  readonly icon?: string | null
  readonly layout: WidgetLayout
}
/** Metric — one number: count of matching instances, or sum/avg of a field. */
export interface MetricWidget extends WidgetBase {
  readonly type: "metric"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly agg: "count" | "sum" | "avg"
  /** Field id to sum/avg (ignored for count). */
  readonly field?: string | null
  /** `auto` renders the wide stat bar on short, wide tiles. */
  readonly variant?: "auto" | "tile" | "bar"
  readonly format?: "plain" | "compact" | "currency" | "percent"
  /** Secondary stat: change vs the value N days ago (instance-createdAt based). */
  readonly delta?: "off" | "7d" | "30d"
  readonly includeArchived?: boolean
}
/** List/Table — instances of a concept matching a filter, rendered as a table. */
export interface ListWidget extends WidgetBase {
  readonly type: "list"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly orderBy?: string | null
  readonly limit?: number | null
  /** Field ids to show as columns; empty/absent = concept default columns. */
  readonly columns?: ReadonlyArray<string>
  /** `auto` switches to cards on narrow tiles (w < 5). */
  readonly variant?: "auto" | "table" | "cards"
  readonly archived?: "exclude" | "include" | "only"
}
/** Breakdown — group instances by an enum field or by label → bar/pie chart. */
export interface BreakdownWidget extends WidgetBase {
  readonly type: "breakdown"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  /** A field id (enum) to group by, or `__labels` to group by label. */
  readonly groupBy: string
  readonly chart: "bar" | "pie"
  /** `field` = the enum's configured option order (falls back to label). */
  readonly sort?: "count" | "label" | "field"
  /** Value labels on bars / in the legend. */
  readonly values?: "count" | "percent" | "both"
  /** Collapse groups past this many into an "Other" bucket; null/absent = all. */
  readonly maxGroups?: number | null
}
/** Attention — decay/momentum band rollup + a stale-queue list. */
export interface AttentionWidget extends WidgetBase {
  readonly type: "attention"
  readonly conceptId?: string | null
  /** Computed field id (decay or momentum). Absent = first decay field found. */
  readonly computedField?: string | null
  /** Bands to surface in the stale queue, in order. */
  readonly bands?: ReadonlyArray<"cooling" | "cold" | "heating" | "steady">
  readonly limit?: number | null
  /** `bands` = badge rollup + stale queue; `strip` = heat strip + worst-N. */
  readonly variant?: "bands" | "strip"
  /** "34d" quiet-duration per stale row (default on). */
  readonly showDays?: boolean
  /** Pre-filter the population before the rollup; absent = all instances. */
  readonly conditions?: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
}
/** Chart/Trend — time-series of events bucketed per day/week. */
export interface TrendWidget extends WidgetBase {
  readonly type: "trend"
  /** Scope the event stream to one concept; absent = whole org. */
  readonly conceptId?: string | null
  /** Which event types to count; absent = created only. */
  readonly eventTypes?: ReadonlyArray<string>
  readonly bucket: "day" | "week"
  readonly since: "7d" | "30d" | "90d"
  readonly chart?: "area" | "bars"
  /** Header verdict: % change vs the prior period of the same length. */
  readonly showDelta?: boolean
}
/** Activity feed — recent events as a list. */
export interface ActivityWidget extends WidgetBase {
  readonly type: "activity"
  readonly conceptId?: string | null
  readonly limit?: number | null
  /** `auto` picks the dense log on wide tiles (w >= 6), else the timeline rail. */
  readonly variant?: "auto" | "timeline" | "log"
  /** Inline payload snippets ("stage: open → nego", note previews). */
  readonly showDiffs?: boolean
  /** Client-side event-type filter (e.g. notes only); absent = all. */
  readonly eventTypes?: ReadonlyArray<string>
}
/** Tasks — the org-global task list (schedule buckets), not concept-scoped. */
export interface TasksWidget extends WidgetBase {
  readonly type: "tasks"
  /** Default assignee scope; the in-tile toolbar can change it at runtime. */
  readonly assignee?: "all" | "me" | "none"
  readonly showToolbar?: boolean
  readonly showComposer?: boolean
  readonly showDone?: boolean
  /** `checklist` = flat rows, no toolbar/composer/groups chrome. */
  readonly variant?: "full" | "checklist"
  readonly groupBy?: "schedule" | "status" | "priority" | "none"
  /** Which row metadata to render; absent = all. */
  readonly rowMeta?: ReadonlyArray<"due" | "priority" | "labels" | "assignee">
  /** Only tasks in these statuses; absent/empty = all. */
  readonly statusIds?: ReadonlyArray<string>
  /** `week` = due within the next 7 days (incl. today). */
  readonly due?: "any" | "overdue" | "week"
  /** FILTER, not data scoping: only tasks annotating that concept's records
   *  (task → item → conceptId, resolved via `resolveTaskSubjects`). */
  readonly conceptId?: string | null
}
/** Members — the org directory (incl. admin management), not concept-scoped. */
export interface MembersWidget extends WidgetBase {
  readonly type: "members"
  readonly showToolbar?: boolean
  /** `rows` = the directory list (default); `grid` = avatar orientation cards. */
  readonly variant?: "rows" | "grid"
  /** Row metadata toggles (rows variant); absent = role + email. */
  readonly fields?: ReadonlyArray<"role" | "email" | "joined">
  readonly sort?: "name" | "role" | "joined"
  /** Cap shown members, with a "view all" link; null/absent = all. */
  readonly limit?: number | null
}
/** Welcome — a big-title greeting for the viewer. */
export interface WelcomeWidget extends WidgetBase {
  readonly type: "welcome"
  /** `hero` = the big-title banner (default); `card` = compact orientation card. */
  readonly variant?: "hero" | "card"
  /** "12 members · 87 events this week" line under the greeting. */
  readonly showPulse?: boolean
  /** Curated quick links (same shape as Shortcuts items); absent/empty = none. */
  readonly links?: ReadonlyArray<ShortcutItem>
}
/** Goal — a metric with a finish line: current value vs a manual target. */
export interface GoalWidget extends WidgetBase {
  readonly type: "goal"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly agg: "count" | "sum" | "avg"
  readonly field?: string | null
  /** Manual target number; null = not configured yet. */
  readonly target?: number | null
  /** `reach` = progress toward >= target (quota); `stay` = keep <= target (budget). */
  readonly direction?: "reach" | "stay"
  readonly variant?: "bar" | "ring" | "number"
  readonly showPercent?: boolean
}
/** One curated shortcut. `ref` is an instance id, dashboard id, or URL per `kind`. */
export interface ShortcutItem {
  readonly id: string
  readonly kind: "instance" | "dashboard" | "url"
  readonly ref: string
  readonly label?: string | null
  readonly icon?: string | null
}
/** Shortcuts — hand-picked jump-off points; fully manual by design (no filters). */
export interface ShortcutsWidget extends WidgetBase {
  readonly type: "shortcuts"
  readonly items: ReadonlyArray<ShortcutItem>
  readonly variant?: "list" | "grid"
  /** Open URL targets in a new tab (internal targets always navigate in-app). */
  readonly newTab?: boolean
}
/** Note — free-form rich text on the canvas ({ doc, text } envelope, client-derived). */
export interface NoteWidget extends WidgetBase {
  readonly type: "note"
  readonly content?: { readonly doc: Record<string, unknown>; readonly text: string }
  readonly appearance?: "plain" | "info" | "warn" | "success"
  readonly overflow?: "clip" | "scroll"
}
/** Kanban — instances as cards in columns keyed by an enum field. */
export interface KanbanWidget extends WidgetBase {
  readonly type: "kanban"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  /** Enum field id whose values become the columns. */
  readonly groupBy: string
  readonly cardFields?: ReadonlyArray<string>
  readonly dragToUpdate?: boolean
  readonly columns?: ReadonlyArray<string>
  readonly showEmptyColumns?: boolean
  readonly orderBy?: string | null
  readonly includeArchived?: boolean
}
/** One calendar source: a concept's instances plotted by a date field. */
export interface CalendarSource {
  readonly conceptId: string
  readonly dateField: string
  readonly color?: string | null
  readonly conditions?: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly labelField?: string | null
}
/** Calendar — instances plotted by date, multi-concept overlay. */
export interface CalendarWidget extends WidgetBase {
  readonly type: "calendar"
  readonly mode: "month" | "week" | "agenda"
  readonly sources: ReadonlyArray<CalendarSource>
  readonly includeTasks?: boolean
  readonly density?: "full" | "dots"
}
/** Timeline/Gantt — instances as bars between two date fields. */
export interface GanttWidget extends WidgetBase {
  readonly type: "gantt"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly scale: "day" | "week" | "month"
  /** Start date field id; an instance with no end renders a milestone. */
  readonly startField: string
  readonly endField?: string | null
  readonly groupBy?: string | null
  readonly barLabelField?: string | null
  readonly progressField?: string | null
  readonly showTodayLine?: boolean
  readonly window?: "fit" | "90d" | "quarter"
}
/** Files — uploads attached to instances, browsed at a scope. */
export interface FilesWidget extends WidgetBase {
  readonly type: "files"
  readonly conceptId?: string | null
  readonly scope: "instance" | "concept" | "org"
  readonly instanceId?: string | null
  readonly allowUpload?: boolean
  readonly variant?: "gallery" | "list"
  readonly sort?: "newest" | "name" | "size"
  readonly limit?: number | null
  readonly fileType?: "all" | "image" | "doc" | "pdf" | "other"
}
export type DashboardWidget =
  | MetricWidget
  | ListWidget
  | BreakdownWidget
  | AttentionWidget
  | TrendWidget
  | ActivityWidget
  | TasksWidget
  | MembersWidget
  | WelcomeWidget
  | GoalWidget
  | ShortcutsWidget
  | NoteWidget
  | KanbanWidget
  | CalendarWidget
  | GanttWidget
  | FilesWidget
export interface DashboardBody {
  readonly widgets: ReadonlyArray<DashboardWidget>
  /** Grid columns (default 12) and row height in px. Forward-compat. */
  readonly cols?: number
  readonly rowHeight?: number
}
export interface Dashboard {
  readonly id: Id
  readonly orgId: OrgId
  /** null = org-shared (any member); non-null = personal to that user. */
  readonly ownerId: string | null
  readonly name: string
  readonly icon: string | null
  readonly position: number
  readonly hidden: boolean
  readonly body: DashboardBody
  readonly createdAt: Date
  readonly updatedAt: Date
}

// ── member deactivation + prefs ──────────────────────────────────────────────────
// Deactivation is the member analogue of archive: a marker row (org_id,
// user_id), restorable, that blocks org access and hides the user from pickers.
// It references bauth users logically (like `actor`) — the auth tables are
// never touched.

// A member's instance-detail layout prefs: which preset view to render, as a
// global default plus per-concept overrides keyed by concept id. View keys
// name client-defined presets — opaque to the engine, like a dashboard body.
// An override may be "custom", backed by a user-edited tile layout in
// `customByConcept` (12-col grid coords; content keys are client-defined).
export interface InstanceViewTile {
  readonly id: string
  readonly contents: ReadonlyArray<string>
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface InstanceViewLayout {
  readonly tiles: ReadonlyArray<InstanceViewTile>
}

/** Relationship-graph tile settings — traversal + render knobs, keyed by
 *  concept id. Layout keys are client-defined (opaque here, like view keys). */
export interface InstanceGraphConfig {
  /** Relation field ids the walk may follow; null = all. */
  readonly fieldIds: ReadonlyArray<string> | null
  readonly depth: number
  readonly layout: string
}

export interface InstanceViewPrefsBody {
  readonly defaultView: string | null
  readonly byConcept: Readonly<Record<string, string>>
  readonly customByConcept: Readonly<Record<string, InstanceViewLayout>>
  /** Optional — rows written before the graph tile existed lack it. */
  readonly graphByConcept?: Readonly<Record<string, InstanceGraphConfig>>
}

export interface InstanceViewPrefs {
  readonly userId: string
  readonly body: InstanceViewPrefsBody
}

export interface MemberDeactivation {
  readonly userId: string
  readonly deactivatedAt: Date
}

export type SubjectKind =
  | "instance"
  | "relation"
  | "concept"
  | "field"
  | "label"
  | "item"
  | "note"
  | "task"
  | "taskStatus"
  | "taskPriority"
  | "annotationField"

/** The annotation variant. Append-only; "comment" etc. may follow. */
export type AnnotationType = "note" | "task"

/** Semantic bucket for a task status — completion/grouping key off this, never
 *  the renameable `name`. `done` = completed (sets `completedAt`); `cancelled`
 *  = closed without completing (never sets it). */
export type TaskStatusCategory = "todo" | "active" | "done" | "cancelled"

/** A per-org configurable task status (Open / In progress / Done …). Keyed by
 *  `id` (renameable `name`); `category` carries the semantics; soft-deleted. */
export interface TaskStatus {
  readonly id: Id
  readonly orgId: OrgId
  readonly name: string
  readonly color: string | null
  readonly category: TaskStatusCategory
  /** The status applied to a newly created task (exactly one live per org). */
  readonly isDefault: boolean
  readonly position: number
  readonly archivedAt: Date | null
}

/** A per-org configurable task priority (Urgent / High / …). The `TaskStatus`
 *  shape minus category/default: no semantics beyond `position` (lower = more
 *  urgent); a new task starts with NO priority. Soft-deleted like statuses. */
export interface TaskPriority {
  readonly id: Id
  readonly orgId: OrgId
  readonly name: string
  readonly color: string | null
  readonly position: number
  readonly archivedAt: Date | null
}

/** A custom-field DEFINITION for the annotation layer — same shape as `Field`
 *  but scoped by `annotationType` instead of a concept. Scalar kinds only. */
export interface AnnotationField {
  readonly id: Id
  readonly orgId: OrgId
  readonly annotationType: AnnotationType
  readonly name: string
  readonly kind: FieldKind
  readonly config: FieldConfig
  readonly icon: string | null
  readonly position: number
  readonly archivedAt: Date | null
}

/** A note — markdown body + author — hung off an item lineage (or org-level). */
export interface Note {
  readonly id: Id
  readonly orgId: OrgId
  /** The annotated item lineage (`items.id`); null = org-level. */
  readonly subjectId: Id | null
  readonly body: string
  /** Author (bauth_user.id). */
  readonly createdBy: string | null
  readonly customFields: Record<string, unknown>
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly archivedAt: Date | null
}

/** A task — first-class, org-scoped, assignable, globally queryable — hung off
 *  an item lineage (or org-level when `subjectId` is null). */
export interface Task {
  readonly id: Id
  readonly orgId: OrgId
  /** The annotated item lineage (`items.id`); null = org-level / standalone. */
  readonly subjectId: Id | null
  readonly title: string
  /** Rich-text description (`{ doc, text }` envelope); null = none. */
  readonly description: RichTextValue | null
  /** Current status (`task_statuses.id`); null only if the status was purged. */
  readonly statusId: Id | null
  /** Priority (`task_priorities.id`); null = no priority. */
  readonly priorityId: Id | null
  /** This task's own label ids (org label vocabulary). */
  readonly labelIds: ReadonlyArray<Id>
  /** Assignee (bauth_user.id); null = unassigned. */
  readonly assignee: string | null
  /** Due date (ISO string) or null. */
  readonly dueAt: string | null
  /** Hidden from "open" lists until this passes (ISO string); read-time check. */
  readonly snoozedUntil: string | null
  /** Blocked marker; non-null = blocked (with optional reason + blocking task). */
  readonly blockedAt: Date | null
  readonly blockedReason: string | null
  /** The blocking task (`annotations.id`); informational, no auto-unblock. */
  readonly blockedByTaskId: Id | null
  /** Set when the status enters the `done` category, cleared when it leaves.
   *  `cancelled` never sets it — closed ≠ completed. */
  readonly completedAt: Date | null
  readonly createdBy: string | null
  readonly customFields: Record<string, unknown>
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly archivedAt: Date | null
}

export interface EngineEvent {
  readonly id: number
  readonly orgId: OrgId
  readonly occurredAt: Date
  readonly actor: string | null
  readonly subjectKind: SubjectKind
  readonly subjectId: Id
  readonly eventType: string
  readonly payload: EventPayload
}
