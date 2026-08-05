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
  /** relation: open referenced records with this record-dashboard id (a 'record'
   *  dashboard owned by `target`); absent = that concept's default record view. */
  readonly recordDashboardId?: string | null
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
  /** No two records of the concept may hold the same value (text/number/date/
   *  enum/user/money only; never with `multiple`). Archived records keep their
   *  claim — only a purge releases a value, so a restore can never resurface a
   *  duplicate. Text compares case-insensitively. Versions of one record share
   *  values freely; missing values never conflict. Enforced write-time —
   *  enabling it on a field with existing cross-record duplicates is rejected. */
  readonly unique?: boolean
}

/** Record version field values, keyed by field **id** (`fields.id`). Synthetic keys
 *  prefixed with `__` (e.g. `__bands`, `__labels`) are engine markers, not fields.
 *  `__labels` holds this record's own label ids (an array of `labels.id`); it rides
 *  the normal RecordVersionCreated/RecordVersionUpdated payloads and folds like any state key. */
export type RecordState = Record<string, unknown>

/** Synthetic `RecordState` key holding a record version's own label ids. */
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
   *  concept wherever record versions are visualised; null renders neutral. */
  readonly color: string | null
  /** Connector-owned "managed concept" marker: a typed integration kind (e.g.
   *  `"linear"`, `"google.gmail"`) when an integration sync owns this concept's
   *  schema + record versions, else null. Drives read-only guards + opinionated detail
   *  views. Keyed by kind, never by concept name. */
  readonly managedBy: string | null
  /** Label ids inherited by every record version of this concept (read-time, never
   *  written per record — so they can't be removed on an individual record). */
  readonly staticLabelIds: ReadonlyArray<Id>
  /** Label ids snapshotted onto each new record version's `__labels` at creation time;
   *  editable per record afterward. */
  readonly defaultLabelIds: ReadonlyArray<Id>
  /** Opt-in versioning: when true, this concept's records hold multiple draft→
   *  published versions and references may pin a specific version. Default false
   *  ⇒ the plain 1-record version-per-record model (every record is a published seq-1 row). */
  readonly versioningEnabled: boolean
  /** How far back edits reach; only meaningful when `versioningEnabled`.
   *  'draft' (default) = a published version is frozen. 'any' = any published
   *  version may be amended in place. See {@link EditReach}. */
  readonly editReach: EditReach
  /** Opt-in "single record": this concept holds exactly ONE record, which always
   *  exists and can be neither archived nor purged while the flag is on. Enforced
   *  at the ITEM level (≤1 live lineage), so it composes with `versioningEnabled`
   *  — a versioned single record still holds N versions on its one lineage.
   *  Default false ⇒ an ordinary many-record concept. */
  readonly singleRecord: boolean
  /** Who may READ this concept's records: 'visible' = any member, 'admin' =
   *  owners/admins only. Enforced in ConceptService + RecordService off
   *  `OrgContext.role`; unknown DB values coerce to 'admin' (fail closed). */
  readonly visibility: ConceptVisibility
  /** Org-wide default record version-detail layout for this concept (a 12-col tile
   *  grid, same shape as a view-prefs custom layout); null = render the built-in
   *  default preset. Set in concept settings; every record version renders it. */
  readonly recordView: RecordViewLayout | null
  /** Field id whose value is this concept's record version display label ("title");
   *  any scalar field. Replaces the implicit "first text field" guess — null only
   *  for an unconfigured concept (then the fallback applies). Integration-set and
   *  UI-locked on a managed concept. */
  readonly titleFieldId: Id | null
  readonly createdAt: Date
  /** Archive marker (mirrors `Field`/`Label`/`Record version`): non-null = archived
   *  (hidden from the live list but restorable). A true delete removes the row. */
  readonly archivedAt: Date | null
  /** Total record versions (live + archived) — present only when listed `withCounts`.
   *  Drives the settings "N records" hint + what blocks a concept purge. */
  readonly recordCount?: number
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
  /** Per-field ownership marker (mirrors `Concept.managedBy`): the integration
   *  kind (e.g. `"google.gmail"`) for a connector-synced, read-only field, else
   *  null for a user-added field. On a managed concept, synced fields carry the
   *  kind while user fields stay null — so members may add + edit their own
   *  fields. Drives the field-level read-only guard. Keyed by kind, never name. */
  readonly managedBy: string | null
  /** Who may READ this field's VALUES: 'visible' = any member, 'admin' =
   *  owners/admins only. Mirrors `Concept.visibility` one level down, for a
   *  sensitive field on a concept that must itself stay readable.
   *  NOTE this filters the value at the USE-CASE boundary, never in `toField` /
   *  `FieldService.listFields` — see `domain/visibility.ts` for why. */
  readonly visibility: ConceptVisibility
  /** Optional display glyph (see `Concept.icon`): literal emoji or `lucide:Name`. */
  readonly icon: string | null
  /** Display order within the concept (ascending); ties broken by name. */
  readonly position: number
  /** Soft-delete marker; non-null fields are hidden from `listFields` but stay
   *  resolvable by `id` (so orphaned state keys / historical edges resolve). */
  readonly archivedAt: Date | null
}

/** The lineage row for a logical "record" — the stable identity across a concept's
 *  versions. References point at an `Record` ("Latest"); whole-record archive lives
 *  here. For a non-versioned concept the mapping to record versions is 1:1. */
export interface KmRecord {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  /** Whole-record (lineage-level) archive marker; hides every version from lists. */
  readonly archivedAt: Date | null
  readonly createdAt: Date
}

/** Product version lifecycle: a version is an editable `draft`, then a frozen,
 *  immutable, referenceable `published`. One-shot (`published` is permanent). */
export type VersionStatus = "draft" | "published"

/** How far back edits reach on a versioned concept (per-concept setting; ignored
 *  when versioning is off, where every record version is always editable).
 *  - `draft`: only the open draft is editable — a published version is frozen and
 *    changes need a fresh draft. The default, and the historical behaviour.
 *  - `any`: any published version may be AMENDED in place. Pinned references point
 *    at a version row, so an amendment reaches everyone referencing that version
 *    (erratum semantics). Auditable — each amendment is an appended event, so
 *    `getAsOf` still reconstructs the pre-amendment state. */
export type EditReach = "draft" | "any"

/** DEFAULT read reach for a concept's records (or a field's values).
 *  - `visible`: any member of the org may read it. The default.
 *  - `admin`: only owners/admins. A member sees it as if it does not exist —
 *    absent from `listConcepts`, and every by-id read fails `ConceptNotFound`
 *    (deliberately NOT a distinct 403, which would confirm it exists).
 *  - `none`: nobody by default, not even an admin. Reserved for material reachable
 *    ONLY through an explicit access rule — a personal dashboard, or a concept whose
 *    records are individually shared.
 *
 *  This is the DEFAULT layer of the access model: `access_rules` are exceptions over
 *  it, and `scopeCanReadConcept` resolves the pair. Unknown values coerce to `admin`
 *  (fail closed) in `rows.ts`.
 *  Engine-level callers (`role: "system"` — syncs, seeds) bypass it. */
export type ConceptVisibility = "visible" | "admin" | "none"

export interface RecordVersion {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  /** The lineage (`records.id`) this version belongs to. Immutable. For a
   *  non-versioned concept or any legacy row, `recordId === id` (1:1). */
  readonly recordId: Id
  readonly state: RecordState
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
  readonly toRecordId: Id
  /** Pinned published version, or null = resolve to the record's latest published. */
  readonly toVersionId: Id | null
  /** Legacy resolved-target column (shadow during migration; superseded by
   *  `toRecordId`/`toVersionId`). Still populated on new edges. */
  readonly toId: Id
  readonly properties: Record<string, unknown>
  readonly createdAt: Date
  readonly archivedAt: Date | null
}

export type EventPayload =
  | {
      readonly _tag: "RecordVersionCreated"
      readonly conceptId: Id
      readonly fields: RecordState
      // Versioning lineage metadata, carried so a full replay reconstructs the
      // version status/lineage. Absent on legacy events ⇒ the reducer defaults to
      // a published, seq-1, 1:1 lineage (`recordId` falls back to the record version id).
      readonly recordId?: Id
      readonly versionSeq?: number
      readonly versionStatus?: VersionStatus
    }
  | { readonly _tag: "RecordVersionUpdated"; readonly patch: RecordState }
  // An edit to an ALREADY-PUBLISHED version (only reachable on a versioned concept
  // with `editReach: "any"`). Folds exactly like `RecordVersionUpdated` — the distinct
  // tag exists so the activity feed can say "amended" instead of "edited", and so
  // amendments are filterable. The pre-amendment state stays recoverable via
  // `getAsOf` at the preceding event.
  | { readonly _tag: "VersionAmended"; readonly patch: RecordState }
  // Archive (soft, restorable). `RecordVersionDeleted` is the legacy archive tag kept
  // for replay; new archives emit `RecordVersionArchived`. Both fold to a set
  // `archivedAt`; `RecordVersionRestored` clears it again (see projection/reducer).
  | { readonly _tag: "RecordVersionDeleted" }
  | { readonly _tag: "RecordVersionArchived" }
  | { readonly _tag: "RecordVersionRestored" }
  // Draft → published transition (one-shot, immutable). Folds `versionStatus` to
  // 'published' + sets `publishedAt`, bumping the event counter. Only after this
  // does the version become referenceable ("Latest").
  | { readonly _tag: "VersionPublished" }
  // Audit tombstone for a hard delete: the row + attachments are gone, but the
  // prior events stay as history. Never folded (the subject no longer loads), so
  // the reducer doesn't handle it — it only surfaces in the activity feed.
  | { readonly _tag: "RecordVersionPurged" }
  | {
      readonly _tag: "RelationCreated"
      readonly fieldId: Id
      readonly fromId: Id
      readonly toId: Id
      // New reference shape (absent on legacy events). `toRecordId` = referenced
      // lineage; `toVersionId` null/absent = general ("Latest"), set = pinned.
      readonly toRecordId?: Id
      readonly toVersionId?: Id | null
      readonly properties: Record<string, unknown>
    }
  | { readonly _tag: "RelationDeleted"; readonly relationId: Id }
  // Attachment events ride their own subject stream (subjectKind "attachment",
  // subject_id = the attachment id) like notes/tasks; `subjectId` carries the
  // host record so the per-record feed can match purge tombstones. Legacy
  // AttachmentAdded events (pre-record era) sit on record version streams without
  // `subjectId` — the reducer folds them as a no-op.
  //
  // `subjectId` is optional on all four because a bucket-owned file has no host
  // record; those carry `bucketId` instead (exactly one of the two is present).
  // No per-record feed matches them — there is no widget feed today.
  | {
      readonly _tag: "AttachmentAdded"
      readonly attachmentId: Id
      readonly filename: string
      readonly subjectId?: Id
      readonly bucketId?: Id
    }
  | {
      readonly _tag: "AttachmentArchived"
      readonly attachmentId: Id
      readonly filename: string
      readonly subjectId?: Id
      readonly bucketId?: Id
    }
  | {
      readonly _tag: "AttachmentRestored"
      readonly attachmentId: Id
      readonly filename: string
      readonly subjectId?: Id
      readonly bucketId?: Id
    }
  | {
      readonly _tag: "AttachmentPurged"
      readonly attachmentId: Id
      readonly filename: string
      readonly subjectId?: Id
      readonly bucketId?: Id
    }
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
  // subjectKind "concept"/"field" events — they NEVER appear in a record version
  // stream, so the record version reducer (projection/reducer.ts) ignores them.
  | {
      readonly _tag: "ConceptUpdated"
      readonly description: string | null
      readonly name?: string
      readonly pluralName?: string | null
      readonly icon?: string | null
      readonly color?: string | null
      readonly versioningEnabled?: boolean
      readonly editReach?: EditReach
      readonly singleRecord?: boolean
      readonly visibility?: ConceptVisibility
      readonly staticLabelIds?: ReadonlyArray<Id>
      readonly defaultLabelIds?: ReadonlyArray<Id>
    }
  | { readonly _tag: "ConceptArchived" }
  | { readonly _tag: "ConceptRestored" }
  | { readonly _tag: "ConceptDeleted" }
  // Label vocabulary edits (settings → Labels). subjectKind "label"; like
  // concept/field schema events these never appear in a record version stream.
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
      readonly visibility?: ConceptVisibility
    }
  | { readonly _tag: "FieldArchived"; readonly conceptId: Id; readonly name: string }
  | { readonly _tag: "FieldRestored"; readonly conceptId: Id; readonly name: string }
  | { readonly _tag: "FieldDeleted"; readonly conceptId: Id; readonly name: string }
  // Whole-record (lineage) archive/restore. subjectKind "record"; like concept/field
  // events these never appear in a record version stream (the reducer ignores them).
  | { readonly _tag: "RecordArchived" }
  | { readonly _tag: "RecordRestored" }
  // ── annotation layer (notes/tasks) ──────────────────────────────────────────
  // subjectKind "note"/"task", subject_id = the annotation's id (its own stream,
  // never folded). `subjectId` in the payload records the annotated ITEM lineage
  // (records.id) or null (org-level) — distinct from the event's own subjectId — so
  // the per-record activity union + purge tombstones survive the row's deletion.
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
  // ── automations ─────────────────────────────────────────────────────────────
  // Definition edits (settings → Automations). subjectKind "automation"; like
  // concept/field/label schema events these never enter a record version stream.
  | { readonly _tag: "AutomationCreated"; readonly name: string; readonly trigger: string }
  | { readonly _tag: "AutomationUpdated"; readonly name: string; readonly trigger: string }
  | { readonly _tag: "AutomationEnabled"; readonly name: string }
  | { readonly _tag: "AutomationDisabled"; readonly name: string; readonly reason: string | null }
  | { readonly _tag: "AutomationArchived" }
  | { readonly _tag: "AutomationRestored" }
  | { readonly _tag: "AutomationDeleted" }
  // A completed RUN, appended on the acted-on record's own stream (subjectKind
  // "recordVersion", subject_id = the record) so the record's activity feed explains
  // itself: "Automation 'Won deals → #wins' created task 'Send contract'".
  // Folds like `ComputedBandChanged` — a marker that never bumps `version`, so it
  // can't collide with a user's optimistic-concurrency check. For a run with no
  // record (org-level task, failed lookup) it rides the automation's own stream.
  | {
      readonly _tag: "AutomationRan"
      readonly automationId: Id
      readonly name: string
      readonly status: string
      /** Short per-action summaries, for the feed line. */
      readonly actions: ReadonlyArray<string>
    }

export interface Attachment {
  readonly id: Id
  readonly orgId: OrgId
  /** Host record (records.id) — files survive re-publishes, like notes.
   *  null ⇔ `bucketId` is set (the DB CHECK enforces exactly one owner). */
  readonly recordId: Id | null
  /** Owning dashboard-widget bucket, for files that belong to no record. */
  readonly bucketId: Id | null
  /** Bucket files only: may an org-scope Files widget list this row? Gates
   *  listing, not access — a direct download URL stays member-reachable. */
  readonly bucketShared: boolean
  readonly filename: string
  readonly contentRef: string
  readonly mimeType: string | null
  readonly sizeBytes: number | null
  /** Uploader (= event actor = bauth_user.id); drives mutate rights. */
  readonly createdBy: string | null
  readonly createdAt: Date
  readonly archivedAt: Date | null
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
    // ── transition ops (automations only) ──────────────────────────────────────
    // Every op above asks about a RESTING state ("Stage is Won"); these two ask
    // about a TRANSITION ("Stage BECAME Won"), which is what an automation
    // actually means. Without them, saving an unrelated field on an already-Won
    // deal would re-fire a "when a deal is won" rule.
    //
    // They need a previous state to compare against, so they only ever hold in an
    // automation run (which supplies one via `MatchOpts.prev`). On every other
    // surface — filter bars, widgets, sidebar sources — there is no prior state
    // and both evaluate to false rather than throwing.
    | "changedTo"
    | "changedFrom"
  readonly value: unknown
}
/** How a condition set combines: every condition or at least one (absent = all). */
export type ConditionMatch = "all" | "any"

// ── sidebar views (configurable nav layouts) ───────────────────────────────────
// The whole layout is the serializable `SidebarViewBody` below. It is OPAQUE to
// the engine (never read or filtered server-side); the web client resolves it.
// The global nav records (Overview, Tasks, …) render in a fixed block above the
// sections unless placed into one (a `global:<key>` entry).

export interface SidebarSection {
  readonly id: string
  readonly title: string | null
  readonly icon: string | null
  readonly collapsed?: boolean
  /** Ordered, explicitly-placed entries: a dashboard uuid, or `global:<key>`
   *  for a placed global nav record. Unknown/deleted ids are skipped at render
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
// against the live concept/record version/event collections. Reuses `SidebarCondition`
// for filters. These mirror the contract's `Dashboard*` schemas (kept separate so
// the contract stays engine-free). The widget union is APPEND-ONLY — never reshape
// an existing widget; add new types at the end.

/** LEGACY pre-auto-layout placement (react-grid-layout coords). Optional now —
 *  the client migrates these bodies to the auto-layout tree. */
export interface WidgetLayout {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
/** A node's size on one axis (48-tile units). `fr` = flex weight. */
export interface Dim {
  readonly unit: "tiles" | "fr" | "pct"
  readonly value: number
  readonly min?: number
  readonly max?: number
}
/** Fields shared by every widget. `conceptId` is OPTIONAL so the same body can
 *  render in per-concept context (implicit conceptId) later. `w`/`h` are the
 *  auto-layout size; `layout` is the migrated-away legacy placement. */
interface WidgetBase {
  readonly id: string
  readonly title: string | null
  readonly icon?: string | null
  readonly layout?: WidgetLayout
  readonly w?: Dim
  readonly h?: Dim
  /** Presentation variant id — a key into the client `VARIANT_CATALOG` for this
   *  widget type. Free-form by design: a new variant is a catalog edit, not a
   *  schema change. Absent = the type's default (first catalog entry). */
  readonly variant?: string
  /** Inner padding of the widget's tile, in px. Absent = the canvas default.
   *  0 = full bleed: content runs to the tile's edge and the tile drops its card
   *  chrome (border/background), for a widget that frames itself. */
  readonly padding?: number
}
/** Metric — one number: count of matching record versions, or sum/avg of a field. */
export interface MetricWidget extends WidgetBase {
  readonly type: "metric"
  readonly conceptId?: string | null
  /** Record dashboards: narrow the population to the current record's related
   *  record versions via this relation field id (instead of the whole concept). */
  readonly relationFieldId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly agg: "count" | "sum" | "avg"
  /** Field id to sum/avg (ignored for count). */
  readonly field?: string | null
  /** Caption under the hero number; absent/empty = auto ("Deals" / "sum of X"). */
  readonly label?: string | null
  readonly format?: "plain" | "compact" | "currency" | "percent"
  /** Secondary stat: change vs the value N days ago (record version-createdAt based). */
  readonly delta?: "off" | "7d" | "30d"
  readonly includeArchived?: boolean
}
/** List/Table — record versions of a concept matching a filter, rendered as a table. */
export interface ListWidget extends WidgetBase {
  readonly type: "list"
  readonly conceptId?: string | null
  /** Record dashboards: narrow to the current record's related record_versions. */
  readonly relationFieldId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly orderBy?: string | null
  readonly limit?: number | null
  /** Field ids to show as columns; empty/absent = concept default columns. */
  readonly columns?: ReadonlyArray<string>
  readonly archived?: "exclude" | "include" | "only"
  /** `grouped` variant: enum field id to section rows by; absent = prompt to
   *  pick one (no implicit default). */
  readonly groupBy?: string | null
  /** `rows` variant: enum field id whose option color drives the status dot;
   *  absent = first enum. */
  readonly statusField?: string | null
  /** Open rows with this record-dashboard id; absent = the concept's default. */
  readonly recordDashboardId?: string | null
}
/** Breakdown — group record versions by an enum field or by label, rendered as bars,
 *  pie, ranked horizontal bars, donut, a stacked composition bar, or a table. */
export interface BreakdownWidget extends WidgetBase {
  readonly type: "breakdown"
  readonly conceptId?: string | null
  /** Record dashboards: narrow to the current record's related record_versions. */
  readonly relationFieldId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  /** A field id (enum) to group by, or `__labels` to group by label. */
  readonly groupBy: string
  readonly chart: "bar" | "pie" | "bars-h" | "donut" | "stacked" | "table"
  /** `field` = the enum's configured option order (falls back to label). */
  readonly sort?: "count" | "label" | "field"
  /** Value labels on bars / in the legend. */
  readonly values?: "count" | "percent" | "both"
  /** Collapse groups past this many into an "Other" bucket; null/absent = all. */
  readonly maxGroups?: number | null
  /** Table chart only: per-group trend sparkline + delta over this window. */
  readonly delta?: "off" | "7d" | "30d"
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
  /** "34d" quiet-duration per stale row (default on). */
  readonly showDays?: boolean
  /** Pre-filter the population before the rollup; absent = all record_versions. */
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
/** On a record dashboard, narrow an analytics query to the current record: match
 *  the record's `fieldId` value against the provider's `property`. */
export interface AnalyticsRecordFilter {
  readonly fieldId: string
  readonly property: string
}
/** Analytics — aggregated time-series from an external provider (PostHog). The
 *  only data-bound widget not backed by concept record versions: it carries a query
 *  config the server translates and runs, instead of a `conceptId`. */
export interface AnalyticsWidget extends WidgetBase {
  readonly type: "analytics"
  readonly provider: "posthog"
  readonly metric: "active_users" | "event_count" | "custom"
  /** Raw provider query (HogQL); only read when `metric` is "custom". Must
   *  return columns aliased `bucket`, `value` and optionally `series`. */
  readonly query?: string | null
  /** Restrict to one event name; absent = all events. Structured only. */
  readonly event?: string | null
  readonly interval: "day" | "week" | "month"
  readonly since: "7d" | "30d" | "90d"
  /** Provider property to split into one series per value. */
  readonly breakdown?: string | null
  readonly chart?: "area" | "bars" | "table"
  /** Header verdict: % change vs the prior period of the same length. */
  readonly showDelta?: boolean
  readonly recordFilter?: AnalyticsRecordFilter | null
}
/** Activity feed — recent events as a list. */
export interface ActivityWidget extends WidgetBase {
  readonly type: "activity"
  readonly conceptId?: string | null
  readonly limit?: number | null
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
  readonly groupBy?: "schedule" | "status" | "priority" | "none"
  /** Which row metadata to render; absent = all. */
  readonly rowMeta?: ReadonlyArray<"due" | "priority" | "labels" | "assignee">
  /** Only tasks in these statuses; absent/empty = all. */
  readonly statusIds?: ReadonlyArray<string>
  /** `week` = due within the next 7 days (incl. today). */
  readonly due?: "any" | "overdue" | "week"
  /** FILTER, not data scoping: only tasks annotating that concept's records
   *  (task → record → conceptId, resolved via `resolveTaskSubjects`). */
  readonly conceptId?: string | null
}
/** Members — the org directory (incl. admin management), not concept-scoped. */
export interface MembersWidget extends WidgetBase {
  readonly type: "members"
  readonly showToolbar?: boolean
  /** Row metadata toggles (rows variant); absent = role + email. */
  readonly fields?: ReadonlyArray<"role" | "email" | "joined">
  readonly sort?: "name" | "role" | "joined"
  /** Cap shown members, with a "view all" link; null/absent = all. */
  readonly limit?: number | null
}
/** Welcome — a big-title greeting for the viewer. */
export interface WelcomeWidget extends WidgetBase {
  readonly type: "welcome"
  /** "12 members · 87 events this week" line under the greeting. */
  readonly showPulse?: boolean
  /** Curated quick links (same shape as Shortcuts records); absent/empty = none. */
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
  readonly showPercent?: boolean
}
/** One curated shortcut. `ref` is a record version id, dashboard id, or URL per
 *  `kind`. `"instance"` accepted for one release to decode pre-rename rows. */
export interface ShortcutItem {
  readonly id: string
  readonly kind: "recordVersion" | "instance" | "dashboard" | "url"
  readonly ref: string
  readonly label?: string | null
  readonly icon?: string | null
}
/** Shortcuts — hand-picked jump-off points; fully manual by design (no filters). */
export interface ShortcutsWidget extends WidgetBase {
  readonly type: "shortcuts"
  readonly items: ReadonlyArray<ShortcutItem>
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
/** Kanban — record versions as cards in columns keyed by an enum field. */
export interface KanbanWidget extends WidgetBase {
  readonly type: "kanban"
  readonly conceptId?: string | null
  /** Record dashboards: narrow to the current record's related record_versions. */
  readonly relationFieldId?: string | null
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
  /** Open cards with this record-dashboard id; absent = the concept's default. */
  readonly recordDashboardId?: string | null
}
/** One calendar source: a concept's record versions plotted by a date field. */
export interface CalendarSource {
  readonly conceptId: string
  readonly dateField: string
  readonly color?: string | null
  readonly conditions?: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly labelField?: string | null
}
/** Calendar — record versions plotted by date, multi-concept overlay. */
export interface CalendarWidget extends WidgetBase {
  readonly type: "calendar"
  readonly mode: "month" | "week" | "agenda"
  readonly sources: ReadonlyArray<CalendarSource>
  readonly includeTasks?: boolean
  readonly density?: "full" | "dots"
}
/** Timeline/Gantt — record versions as bars between two date fields. */
export interface GanttWidget extends WidgetBase {
  readonly type: "gantt"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly scale: "day" | "week" | "month"
  /** Start date field id; a record version with no end renders a milestone. */
  readonly startField: string
  readonly endField?: string | null
  readonly groupBy?: string | null
  readonly barLabelField?: string | null
  readonly progressField?: string | null
  readonly showTodayLine?: boolean
  readonly window?: "fit" | "90d" | "quarter"
}
/** Files — uploads browsed at a scope. The first three read files owned by
 *  records; `widget` owns its own bucket, attached to no record. */
export interface FilesWidget extends WidgetBase {
  readonly type: "files"
  readonly conceptId?: string | null
  // "instance" accepted for one release to decode pre-rename rows.
  readonly scope: "recordVersion" | "instance" | "concept" | "org" | "widget"
  readonly recordVersionId?: string | null
  /** `scope: "recordVersion"` only — take the record from `conceptId`'s single record
   *  rather than a pinned `recordVersionId` (resolved client-side). */
  readonly bindToConceptRecord?: boolean
  /** `scope: "widget"` only — the bucket owning this widget's files. */
  readonly bucketId?: string | null
  /** `scope: "widget"` only, default true: listable by an org-scope widget too. */
  readonly bucketShared?: boolean
  readonly allowUpload?: boolean
  readonly sort?: "newest" | "name" | "size"
  readonly limit?: number | null
  readonly fileType?: "all" | "image" | "doc" | "pdf" | "other"
}
/** Document — one record's rich text field, edited inline on a dashboard. */
export interface DocumentWidget extends WidgetBase {
  readonly type: "document"
  readonly conceptId?: string | null
  readonly recordVersionId?: string | null
  /** Take the record from `conceptId`'s single record rather than a pinned
   *  `recordVersionId` (resolved client-side). */
  readonly bindToConceptRecord?: boolean
  readonly fieldId?: string | null
  readonly hideLabel?: boolean
}
/** Record-scoped widgets — one panel of the CURRENT record on a 'record' dashboard
 *  (record version supplied by page context; no per-widget conceptId/recordVersionId). Each
 *  reuses an existing record version-detail panel. Opaque to the engine like the rest. */
export interface RecordDetailsWidget extends WidgetBase {
  readonly type: "record-details"
}
export interface RecordConnectionsWidget extends WidgetBase {
  readonly type: "record-connections"
}
export interface RecordGraphWidget extends WidgetBase {
  readonly type: "record-graph"
}
export interface RecordLabelsWidget extends WidgetBase {
  readonly type: "record-labels"
}
export interface RecordVersionsWidget extends WidgetBase {
  readonly type: "record-versions"
}
export interface RecordNotesWidget extends WidgetBase {
  readonly type: "record-notes"
}
export interface RecordTasksWidget extends WidgetBase {
  readonly type: "record-tasks"
}
export interface RecordMentionsWidget extends WidgetBase {
  readonly type: "record-mentions"
}
export interface RecordActivityWidget extends WidgetBase {
  readonly type: "record-activity"
}
export type DashboardWidget =
  | MetricWidget
  | ListWidget
  | BreakdownWidget
  | AttentionWidget
  | TrendWidget
  | AnalyticsWidget
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
  | DocumentWidget
  | RecordDetailsWidget
  | RecordConnectionsWidget
  | RecordGraphWidget
  | RecordLabelsWidget
  | RecordVersionsWidget
  | RecordNotesWidget
  | RecordTasksWidget
  | RecordActivityWidget
  | RecordMentionsWidget
/** An invisible auto-layout container (Figma-style). `display` "flow" (default)
 *  lays children out along `direction`; "tabs" shows one child at a time behind a
 *  tab bar (each child is a tab/panel). Opaque to the engine — mirrors the
 *  contract's `DashboardGroup`. */
export interface DashboardGroup {
  readonly id: string
  readonly type: "group"
  readonly direction: "row" | "col"
  readonly display?: "flow" | "tabs"
  readonly label?: string | null
  readonly active?: string | null
  readonly tabBar?: "top" | "bottom" | "left" | "right"
  readonly w?: Dim
  readonly h?: Dim
  readonly children: ReadonlyArray<DashboardNode>
}
export type DashboardNode = DashboardWidget | DashboardGroup
/** The persisted dashboard document — an auto-layout tree (`direction`+`children`),
 *  or a LEGACY flat `widgets` list (migrated to a tree client-side). The engine
 *  treats it as an opaque document; resolution happens in the client. */
export interface DashboardBody {
  readonly direction?: "row" | "col"
  readonly children?: ReadonlyArray<DashboardNode>
  readonly widgets?: ReadonlyArray<DashboardWidget>
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
  /** "page" (default/legacy) = free-standing canvas; "record" = per-concept
   *  single-record version template. */
  readonly kind: "page" | "record"
  /** Owning concept for a "record" dashboard; null for "page". Record dashboards
   *  order by `position` — the first is what a bare reference opens. */
  readonly conceptId: string | null
  readonly body: DashboardBody
  readonly createdAt: Date
  readonly updatedAt: Date
}

// ── member deactivation + prefs ──────────────────────────────────────────────────
// Deactivation is the member analogue of archive: a marker row (org_id,
// user_id), restorable, that blocks org access and hides the user from pickers.
// It references bauth users logically (like `actor`) — the auth tables are
// never touched.

// A member's record version-detail layout prefs: which preset view to render, as a
// global default plus per-concept overrides keyed by concept id. View keys
// name client-defined presets — opaque to the engine, like a dashboard body.
// An override may be "custom", backed by a user-edited tile layout in
// `customByConcept` (12-col grid coords; content keys are client-defined).
export interface RecordViewTile {
  readonly id: string
  readonly contents: ReadonlyArray<string>
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface RecordViewLayout {
  readonly tiles: ReadonlyArray<RecordViewTile>
}

/** Relationship-graph tile settings — traversal + render knobs, keyed by
 *  concept id. Layout keys are client-defined (opaque here, like view keys). */
export interface RecordGraphConfig {
  /** Relation field ids the walk may follow; null = all. */
  readonly fieldIds: ReadonlyArray<string> | null
  readonly depth: number
  readonly layout: string
}

export interface RecordViewPrefsBody {
  readonly defaultView: string | null
  readonly byConcept: Readonly<Record<string, string>>
  readonly customByConcept: Readonly<Record<string, RecordViewLayout>>
  /** Optional — rows written before the graph tile existed lack it. */
  readonly graphByConcept?: Readonly<Record<string, RecordGraphConfig>>
}

export interface RecordViewPrefs {
  readonly userId: string
  readonly body: RecordViewPrefsBody
}

export interface MemberDeactivation {
  readonly userId: string
  readonly deactivatedAt: Date
}

export type SubjectKind =
  | "recordVersion"
  | "relation"
  | "concept"
  | "field"
  | "label"
  | "record"
  | "note"
  | "task"
  | "taskStatus"
  | "taskPriority"
  | "annotationField"
  | "attachment"
  | "automation"
  // Access control: a role and its rules are auditable subjects like anything else,
  // so role/rule/share changes land on the ordinary event log.
  | "accessRole"
  | "accessRule"

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

/** A note — markdown body + author — hung off a record (or org-level). */
export interface Note {
  readonly id: Id
  readonly orgId: OrgId
  /** The annotated record (`records.id`); null = org-level. */
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
 *  a record (or org-level when `subjectId` is null). */
export interface Task {
  readonly id: Id
  readonly orgId: OrgId
  /** The annotated record (`records.id`); null = org-level / standalone. */
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

// ── automations ────────────────────────────────────────────────────────────────
// "when X, if Y, then Z" — a saved filter over the event log with a list of
// service calls attached. Three slots, three closed vocabularies:
//   trigger    — which event (or a schedule); a FILTER over `events`, not new
//                machinery, since every mutation already appends + pg_notifies
//   conditions — `SidebarCondition[]`, the same shape/evaluator every widget uses
//   actions    — ordered thin calls onto existing services
// `trigger`/`actions` are persisted as opaque jsonb documents validated by the
// RPC contract, exactly like dashboard widget bodies: an APPEND-ONLY union — add
// new kinds at the end, never reshape an existing one, because old rows must keep
// parsing. Concepts and fields are referenced by ID, never name, so a rename can
// never break a rule.

/** The actor prefix every automation-run event carries. Events by such an actor
 *  NEVER trigger another automation — this is the one-hop guard, enforced by
 *  construction rather than by cycle detection. Mirrors `system:decay-tick`. */
export const AUTOMATION_ACTOR_PREFIX = "system:automation:"

/** Is this event actor an automation? (the one-hop guard's predicate) */
export const isAutomationActor = (actor: string | null | undefined): boolean =>
  typeof actor === "string" && actor.startsWith(AUTOMATION_ACTOR_PREFIX)

/** Which event (or clock tick) starts a run. Append-only. */
export type AutomationTriggerKind =
  | "record.created"
  | "record.changed"
  | "record.archived"
  | "version.published"
  | "record.band.changed"
  | "task.created"
  | "task.status.changed"
  | "schedule"

/** The trigger document. Which optional keys are meaningful depends on `kind`;
 *  all are ids (never names). `schedule` is the only non-event kind — it runs
 *  over EVERY record matching the conditions, which is also why automations need
 *  no loop construct. */
export interface AutomationTrigger {
  readonly kind: AutomationTriggerKind
  /** Restrict to one concept (all record.* + task.created); absent = any. */
  readonly conceptId?: string | null
  /** `record.changed`: only when THIS field is in the patch; absent = any field. */
  readonly fieldId?: string | null
  /** `record.band.changed`: the computed field, and which band to fire on. */
  readonly band?: string | null
  /** `task.status.changed`: only when the task lands on this status id. */
  readonly statusId?: string | null
  /** `schedule` only. */
  readonly every?: "day" | "week" | "month"
  /** `schedule` only: local hour 0-23 (minute is always 0). */
  readonly hour?: number
  /** `schedule` + every=week: 0=Sunday … 6=Saturday. */
  readonly weekday?: number
  /** `schedule` + every=month: day of month 1-28 (capped so every month has it). */
  readonly day?: number
}

/** One action. Ordered and run sequentially; the first failure stops the run and
 *  records which step failed and why. Every kind is a thin call onto a service
 *  that already exists — so required fields, uniques, enum transitions,
 *  managed-concept guards and optimistic concurrency all still apply. There is
 *  deliberately NO purge action: an automation is a rule you wrote once and then
 *  forgot, so it may only do reversible things. */
export type AutomationAction =
  | {
      readonly kind: "setField"
      readonly fieldId: string
      /** Template-interpolated when a string (see `TEMPLATE_TOKENS` in
       *  `src/pages/settings/automationText.ts`, rendered by `renderTemplate`). */
      readonly value: unknown
    }
  | { readonly kind: "addLabel"; readonly labelId: string }
  | { readonly kind: "removeLabel"; readonly labelId: string }
  | {
      readonly kind: "createTask"
      readonly title: string
      readonly assignee?: string | null
      readonly statusId?: string | null
      readonly priorityId?: string | null
      readonly labelIds?: ReadonlyArray<string>
      /** Days from the run to the due date; absent = no due date. */
      readonly dueInDays?: number | null
      /** Hang the task off the trigger record (default true) vs org-level. */
      readonly onRecord?: boolean
    }
  | {
      readonly kind: "createRecord"
      readonly conceptId: string
      /** Field id → value; string values are template-interpolated. */
      readonly fields: Record<string, unknown>
    }
  | { readonly kind: "archiveRecord" }
  | {
      readonly kind: "notifySlack"
      readonly channel: string
      readonly text: string
    }
  | {
      readonly kind: "webhook"
      readonly url: string
      /** Extra JSON merged over the default envelope; strings interpolated. */
      readonly body?: Record<string, unknown>
    }
  // ── Slack ────────────────────────────────────────────────────────────────
  // All four ride the org's BOT token, which is why they survived the cut: a
  // per-user token would need an actor the runner does not have.
  | {
      readonly kind: "slack.postThreadReply"
      /** Defaults to `{{slack.channel}}` when blank. */
      readonly channel: string
      /** The parent message. Usually `{{slack.ts}}` — the post earlier in this run. */
      readonly threadTs: string
      readonly text: string
    }
  | {
      readonly kind: "slack.postBlocks"
      readonly channel: string
      /** Block Kit JSON as typed. Parsed and screened at SAVE time. */
      readonly blocks: string
      /** Notification/fallback text. Required — without it push previews are blank. */
      readonly text: string
    }
  | {
      readonly kind: "slack.dmUser"
      /** A Slack user id (`U…`), not a KM member id — there is no mapping between them. */
      readonly slackUserId: string
      readonly text: string
    }
  | {
      readonly kind: "slack.addReaction"
      readonly channel: string
      readonly ts: string
      /** Emoji name, with or without the surrounding colons. */
      readonly name: string
    }
  // ── Linear ───────────────────────────────────────────────────────────────
  // The four record-scoped ones resolve the issue from the triggering record;
  // `createIssue` is the only one that needs no subject.
  | {
      readonly kind: "linear.updateIssue"
      /** Linear `IssueUpdateInput` keys (title, priority, stateId, …), interpolated. */
      readonly input: Record<string, unknown>
    }
  | { readonly kind: "linear.closeIssue" }
  | { readonly kind: "linear.comment"; readonly body: string }
  | {
      readonly kind: "linear.assign"
      /** Resolved to a Linear user id at RUN time — no mapping table. */
      readonly email: string
    }
  | {
      readonly kind: "linear.createIssue"
      /** Mandatory in Linear's schema; there is no workspace default. */
      readonly teamId: string
      readonly title: string
      readonly description?: string
    }

export type AutomationActionKind = AutomationAction["kind"]

/** Why an automation paused itself. Only `rate-cap` exists today; the column is
 *  free text so a future reason needs no migration. */
export type AutomationPausedReason = "rate-cap" | (string & {})

export interface Automation {
  readonly id: Id
  readonly orgId: OrgId
  readonly name: string
  readonly enabled: boolean
  readonly trigger: AutomationTrigger
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly match: ConditionMatch
  readonly actions: ReadonlyArray<AutomationAction>
  /** Schedule triggers only: when this is next due (claimed atomically). */
  readonly nextRunAt: Date | null
  readonly lastRunAt: Date | null
  readonly runCount: number
  /** Non-null ⇒ the automation paused ITSELF (rate cap tripped). */
  readonly pausedReason: AutomationPausedReason | null
  readonly createdBy: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly archivedAt: Date | null
}

/** How one run ended. `skipped` is RECORDED, never silent — it is the answer to
 *  "why didn't my automation fire?". */
export type AutomationRunStatus = "ok" | "skipped" | "failed"

/** Per-action outcome inside `AutomationRun.detail`. */
export interface AutomationActionOutcome {
  readonly kind: AutomationActionKind
  readonly ok: boolean
  /** Short human note ("created task abc", "no Slack connection"). */
  readonly note?: string
}

export interface AutomationRunDetail {
  /** Why a `skipped` run skipped ("conditions", "disabled", "no-subject"). */
  readonly reason?: string
  readonly actions?: ReadonlyArray<AutomationActionOutcome>
  /** Set on `failed`: which step (0-based) and the error. */
  readonly failedAt?: number
  readonly error?: string
}

export interface AutomationRun {
  readonly id: Id
  readonly orgId: OrgId
  readonly automationId: Id
  /** The triggering `events.id`; null for a scheduled run. */
  readonly eventId: number | null
  /** The record acted on (`record_versions.id`); null when there is none. */
  readonly subjectId: Id | null
  readonly status: AutomationRunStatus
  readonly detail: AutomationRunDetail
  readonly startedAt: Date
  readonly finishedAt: Date | null
}
