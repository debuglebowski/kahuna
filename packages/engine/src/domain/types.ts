import { Schema } from "effect"

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
)
export type FieldKind = typeof FieldKind.Type

/** Per-field configuration, stored in `fields.config` (jsonb). */
export interface FieldConfig {
  /** enum: allowed values */
  readonly options?: ReadonlyArray<string>
  /** enum: legal state-machine transitions `from -> [to, ...]` */
  readonly transitions?: Record<string, ReadonlyArray<string>>
  /** relation: the target concept's id (the relation's identity is its field id). */
  readonly target?: string
  readonly cardinality?: "one" | "many"
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

// ── sidebar views (configurable nav layouts) ───────────────────────────────────
// The whole layout is the serializable `SidebarViewBody` below. It is OPAQUE to
// the engine (never read or filtered server-side); the web client resolves it
// against the live concept/instance collections. These mirror the contract's
// `SidebarView*` schemas (kept separate so the contract stays engine-free).

/** One filter condition. `field` is a field id, or `__labels` for `hasLabel`. */
export interface SidebarCondition {
  readonly field: string
  readonly op: "eq" | "hasLabel"
  readonly value: unknown
}
/** A manually-pinned group member — a concept link or a single instance. */
export type SidebarMember =
  | { readonly kind: "concept"; readonly conceptId: Id }
  | { readonly kind: "instance"; readonly conceptId: Id; readonly instanceId: Id }
/** An auto-membership rule: matching concepts, or matching instances of a concept. */
export type SidebarRule =
  | { readonly target: "concepts"; readonly conditions: ReadonlyArray<SidebarCondition> }
  | {
      readonly target: "items"
      readonly conceptId: Id
      readonly conditions: ReadonlyArray<SidebarCondition>
    }
export type SidebarStaticItem = "overview" | "dashboards" | "members" | "automations" | "settings"
export interface SidebarLink {
  readonly id: string
  readonly label: string
  readonly icon?: string | null
  /** `/instances/:id`, a concept route, or an external URL. */
  readonly to: string
}
export type SidebarSource =
  | { readonly kind: "static"; readonly items: ReadonlyArray<SidebarStaticItem> }
  | {
      readonly kind: "group"
      readonly members: ReadonlyArray<SidebarMember>
      readonly rules: ReadonlyArray<SidebarRule>
    }
  | {
      readonly kind: "list"
      readonly conceptId: Id
      readonly conditions: ReadonlyArray<SidebarCondition>
      readonly orderBy?: string | null
      readonly limit?: number | null
    }
  | { readonly kind: "links"; readonly items: ReadonlyArray<SidebarLink> }
export interface SidebarSection {
  readonly id: string
  readonly title: string | null
  readonly icon: string | null
  readonly collapsed?: boolean
  readonly source: SidebarSource
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
  readonly agg: "count" | "sum" | "avg"
  /** Field id to sum/avg (ignored for count). */
  readonly field?: string | null
}
/** List/Table — instances of a concept matching a filter, rendered as a table. */
export interface ListWidget extends WidgetBase {
  readonly type: "list"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  readonly orderBy?: string | null
  readonly limit?: number | null
  /** Field ids to show as columns; empty/absent = concept default columns. */
  readonly columns?: ReadonlyArray<string>
}
/** Breakdown — group instances by an enum field or by label → bar/pie chart. */
export interface BreakdownWidget extends WidgetBase {
  readonly type: "breakdown"
  readonly conceptId?: string | null
  readonly conditions: ReadonlyArray<SidebarCondition>
  /** A field id (enum) to group by, or `__labels` to group by label. */
  readonly groupBy: string
  readonly chart: "bar" | "pie"
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
}
/** Activity feed — recent events as a list. */
export interface ActivityWidget extends WidgetBase {
  readonly type: "activity"
  readonly conceptId?: string | null
  readonly limit?: number | null
}
export type DashboardWidget =
  | MetricWidget
  | ListWidget
  | BreakdownWidget
  | AttentionWidget
  | TrendWidget
  | ActivityWidget
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

// ── member pages + deactivation ─────────────────────────────────────────────────
// A member's profile page is a widget canvas with the SAME opaque body document
// as dashboards (`DashboardBody`), but a fixed scope by design: exactly one page
// per (org, user), the owner edits, every org member reads. Deactivation is the
// member analogue of archive: a marker row (org_id, user_id), restorable, that
// blocks org access and hides the user from pickers. Both reference bauth users
// logically (like `actor`) — the auth tables are never touched.

export interface MemberPage {
  readonly userId: string
  readonly body: DashboardBody
}

export interface MemberDeactivation {
  readonly userId: string
  readonly deactivatedAt: Date
}

export type SubjectKind = "instance" | "relation" | "concept" | "field" | "label" | "item"

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
