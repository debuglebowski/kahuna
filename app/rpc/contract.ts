import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

/**
 * The Kingsmaker RPC contract — the single typed source of truth shared by the
 * server (handlers) and the browser client. Imports ONLY effect + @effect/rpc,
 * so it is safe to bundle into the client (no engine / node deps).
 */

// ── wire schemas ──────────────────────────────────────────────────────────────

/** Synthetic instance-state key carrying an item's own label ids (mirrors the
 *  engine's `LABELS_KEY`). Sent inside `createInstance.fields` / `updateInstance.patch`. */
export const LABELS_KEY = "__labels"

const State = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** Product version lifecycle (mirrors the engine's `VersionStatus`). */
export const VersionStatus = Schema.Literal("draft", "published")
export type VersionStatus = typeof VersionStatus.Type

/** How far back edits reach on a versioned concept (mirrors the engine's
 *  `EditReach`). `draft` = a published version is frozen, edits need a fresh
 *  draft. `any` = any published version may be AMENDED in place, which everyone
 *  referencing that version sees. Ignored when versioning is off. */
export const EditReach = Schema.Literal("draft", "any")

/** DEFAULT read reach for a concept or field: org-wide, owners/admins only, or
 *  nobody-without-an-explicit-rule. The default layer of the access model; access
 *  rules are exceptions over it. */
export const ConceptVisibility = Schema.Literal("visible", "admin", "none")
export type EditReach = typeof EditReach.Type

const InstanceFields = {
  id: Schema.String,
  conceptId: Schema.String,
  /** The lineage this version belongs to. For a non-versioned concept, 1:1 with id. */
  itemId: Schema.String,
  state: State,
  /** Optimistic-concurrency event counter (not the product version). */
  version: Schema.Number,
  /** Product version status: 'draft' (editable) | 'published' (frozen). */
  versionStatus: VersionStatus,
  /** Sequence within the lineage (1,2,3…). */
  versionSeq: Schema.Number,
  publishedAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
  archivedAt: Schema.NullOr(Schema.Date),
}
export const Instance = Schema.Struct(InstanceFields)
export type Instance = typeof Instance.Type

/** A logical item (lineage) — referenced as "Latest"; whole-item archive lives here. */
export const Item = Schema.Struct({
  id: Schema.String,
  conceptId: Schema.String,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Item = typeof Item.Type

/** A relation edge in its new reference shape. `toVersionId` null = general ("Latest"). */
export const Relation = Schema.Struct({
  id: Schema.String,
  fieldId: Schema.String,
  fromId: Schema.String,
  toItemId: Schema.String,
  toVersionId: Schema.NullOr(Schema.String),
  toId: Schema.String,
})
export type Relation = typeof Relation.Type

/** A relation-picker candidate: the head (latest published) of a target item. */
export const InstancePick = Schema.Struct({
  itemId: Schema.String,
  instanceId: Schema.String,
  label: Schema.String,
  versionSeq: Schema.Number,
  versionStatus: VersionStatus,
})
export type InstancePick = typeof InstancePick.Type

// A tile on the 12-col instance-detail grid: one or more content keys (rendered
// as tabs when >1; opaque strings here — the client drops ones it doesn't know)
// plus grid coords. Shared by a concept's default layout (`Concept.instanceView`)
// and the per-user view-prefs custom layouts.
export const InstanceViewTile = Schema.Struct({
  id: Schema.String,
  contents: Schema.Array(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
})
export type InstanceViewTile = typeof InstanceViewTile.Type

export const InstanceViewLayout = Schema.Struct({
  tiles: Schema.Array(InstanceViewTile),
})
export type InstanceViewLayout = typeof InstanceViewLayout.Type

export const Concept = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  /** Optional plural display label; sidebar prefers it, falling back to `name`. */
  pluralName: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  /** Display glyph: a literal emoji or a curated lucide icon name prefixed
   *  `lucide:` (e.g. `lucide:Building2`); null renders none. */
  icon: Schema.NullOr(Schema.String),
  /** Optional display color (hex, same pill palette as labels) used to tint the
   *  concept wherever instances are visualised; null renders neutral. */
  color: Schema.NullOr(Schema.String),
  /** Connector-owned "managed concept" kind (e.g. `"linear"`, `"google.gmail"`)
   *  when an integration sync owns this concept's schema + instances, else null.
   *  Drives read-only guards + the opinionated instance detail view. */
  managedBy: Schema.NullOr(Schema.String),
  /** Label ids inherited by every instance (static); and snapshotted onto new
   *  instances (default). Both drawn from the org-wide label vocabulary. */
  staticLabelIds: Schema.Array(Schema.String),
  defaultLabelIds: Schema.Array(Schema.String),
  /** Opt-in per-concept versioning (draft→published versions + pinned references). */
  versioningEnabled: Schema.Boolean,
  /** Which of this concept's versions are editable; only meaningful when
   *  `versioningEnabled`. See {@link EditReach}. */
  editReach: EditReach,
  /** Opt-in "single record": the concept holds exactly ONE record, always
   *  present and neither archivable nor purgeable while on. Reachable at
   *  `/c/<slug>`. Toggled ONLY via `setConceptSingleRecord` (never
   *  `updateConcept` — the toggle also creates/guards the record). */
  singleRecord: Schema.Boolean,
  /** Who may READ this concept's records. `"admin"` means members never see it at
   *  all — it is absent from this very list for them, so a member only ever
   *  receives `"visible"` here. Set via `setConceptVisibility` (admin-only). */
  visibility: ConceptVisibility,
  /** Org-wide default instance-detail layout (a 12-col tile grid); null = the
   *  built-in default preset. Set in concept settings → Layout. */
  instanceView: Schema.NullOr(InstanceViewLayout),
  /** Field id whose value is this concept's instance display label ("title");
   *  any scalar field. Null = unconfigured (fallback to first text field).
   *  Integration-set + UI-locked on a managed concept. */
  titleFieldId: Schema.NullOr(Schema.String),
  /** Archive marker: non-null = archived (hidden from the live list, restorable). */
  archivedAt: Schema.NullOr(Schema.Date),
  /** Total items (live + archived) — present only on a `withCounts` list. */
  itemCount: Schema.optional(Schema.Number),
})
export type Concept = typeof Concept.Type

/** A label in the org-wide, flat vocabulary. */
export const Label = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  /** A plain flag for now (rendered with a crown); future features key off it. */
  primary: Schema.Boolean,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Label = typeof Label.Type

export const FieldKind = Schema.Literal(
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "relation",
  "file",
  "computed",
  "user",
  "json",
  "money",
  "richtext",
)
export type FieldKind = typeof FieldKind.Type

/** Mirrors the engine's `FieldConfig` (kept here so the contract stays engine-free). */
export const FieldConfig = Schema.Struct({
  options: Schema.optional(Schema.Array(Schema.String)),
  /** enum: display color per option (`value -> #rrggbb`); missing = neutral. */
  optionColors: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  transitions: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  ),
  /** relation: the target concept's id (the relation's identity is the field id). */
  target: Schema.optional(Schema.String),
  cardinality: Schema.optional(Schema.Literal("one", "many")),
  /** relation: how the TARGET side names the connection (e.g. "Employees" on
   *  Company reads "Employer" from the Person side); absent = field name. */
  inverseName: Schema.optional(Schema.String),
  /** relation: plural of `inverseName`; the UI picks singular/plural by count. */
  inversePluralName: Schema.optional(Schema.String),
  /** relation: open referenced records with this record-dashboard id (a 'record'
   *  dashboard owned by `target`); absent = that concept's default record view. */
  recordDashboardId: Schema.optional(Schema.NullOr(Schema.String)),
  computedKind: Schema.optional(Schema.Literal("decay", "momentum")),
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  /** any scalar kind: store/validate a list of values. */
  multiple: Schema.optional(Schema.Boolean),
  /** text/number: an extra format constraint. */
  format: Schema.optional(Schema.String),
  /** scalar kinds: how required a value is. `required` blocks create/clearing
   *  (and publish on versioned concepts); `flagged` only surfaces missing values
   *  in the UI. Absent = optional. */
  requirement: Schema.optional(Schema.Literal("required", "flagged", "optional")),
  /** text/number/date/enum/user/money: no two items may hold the same value —
   *  archived included (only purge releases), text case-insensitive (never
   *  combined with `multiple`). */
  unique: Schema.optional(Schema.Boolean),
})
export type FieldConfig = typeof FieldConfig.Type

export const Field = Schema.Struct({
  id: Schema.String,
  conceptId: Schema.String,
  name: Schema.String,
  kind: FieldKind,
  formula: Schema.NullOr(Schema.String),
  config: FieldConfig,
  /** Per-field ownership marker (mirrors `Concept.managedBy`): the integration
   *  kind (e.g. `"google.gmail"`) for a connector-synced, read-only field, else
   *  null for a user-added field. On a managed concept, synced fields carry the
   *  kind while user fields stay null — so members may add + edit their own. */
  managedBy: Schema.NullOr(Schema.String),
  /** Who may READ this field's values. A member never receives a def whose value
   *  they can't read — it is filtered out of `listFields` entirely — so a member
   *  only ever sees `"visible"` here. Set via `setFieldVisibility` (admin-only). */
  visibility: ConceptVisibility,
  /** Display glyph: literal emoji or `lucide:Name` (see `Concept.icon`). */
  icon: Schema.NullOr(Schema.String),
  /** Display order within the concept (ascending); ties broken by name. */
  position: Schema.Number,
  /** Archive marker: non-null = archived (hidden from the live list, restorable). */
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Field = typeof Field.Type

/** A file (the binary side of the annotation substrate). Bytes move over plain
 *  HTTP (multipart up, binary down — see server/router.ts); this is the metadata
 *  the RPCs list and mutate. Exactly one owner: `itemId` = the host lineage of a
 *  record, `bucketId` = a Files widget that owns its files outright. */
export const Attachment = Schema.Struct({
  id: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  bucketId: Schema.NullOr(Schema.String),
  filename: Schema.String,
  mimeType: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Number),
  /** Uploader (bauth_user.id); drives archive/delete rights (uploader or admin). */
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  /** Archive marker: non-null = archived (hidden from the live list, restorable). */
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Attachment = typeof Attachment.Type

export const FeedItem = Schema.Struct({
  id: Schema.Number,
  occurredAt: Schema.Date,
  actor: Schema.NullOr(Schema.String),
  eventType: Schema.String,
  subjectKind: Schema.String,
  subjectId: Schema.String,
  /** Raw engine event payload (field patch, note body, task transition, …) —
   *  the feed derives inline snippets and the expanded detail view from it. */
  payload: Schema.optional(Schema.Unknown),
  /** Field-edit events only: the value each patched field held before, keyed
   *  by field id — folded server-side (events store only the new values). */
  previous: Schema.optional(Schema.Unknown),
})
export type FeedItem = typeof FeedItem.Type

/** One instance connected to another via a relation, with its concept resolved. */
export const RelatedInstance = Schema.Struct({
  relationId: Schema.String,
  /** The relation field def this edge realises (identity); name is decorative. */
  fieldId: Schema.String,
  relationName: Schema.String,
  /** The field's inverse-side labels (config.inverseName/...PluralName), resolved
   *  server-side so `in` entries can be headed without the foreign field def. */
  relationInverseName: Schema.NullOr(Schema.String),
  relationInversePluralName: Schema.NullOr(Schema.String),
  /** Server-resolved display label of the connected instance (its state is keyed
   *  by field id, which the client can't resolve without that concept's fields). */
  label: Schema.String,
  /** `out` = this instance is the relation's `from`; `in` = it is the `to`. */
  direction: Schema.Literal("out", "in"),
  conceptId: Schema.String,
  conceptName: Schema.String,
  /** True if this edge pins a specific published version; false = "Latest" (general). */
  pinned: Schema.Boolean,
  /** The resolved target version (the pinned version, or the current Latest). May be
   *  null when a general ref currently has no published version (dangling). */
  instance: Schema.NullOr(Instance),
})
export type RelatedInstance = typeof RelatedInstance.Type

/** A single instance plus everything needed to render its detail view. */
export const InstanceDetail = Schema.Struct({
  instance: Instance,
  concept: Concept,
  fields: Schema.Array(Field),
  related: Schema.Array(RelatedInstance),
  /** Live relation fields on OTHER concepts targeting this one — the inbound
   *  side of this instance's connections (drives inverse-side add/remove). */
  inboundRelationFields: Schema.Array(Field),
  /** Inherited from the concept (static) — shown as locked chips. */
  staticLabels: Schema.Array(Label),
  /** This instance's own labels (from `state.__labels`), resolved and editable. */
  labels: Schema.Array(Label),
})
export type InstanceDetail = typeof InstanceDetail.Type

/** A node in the concept graph — one concept. */
export const ConceptGraphNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  /** Display glyph: literal emoji or `lucide:Name` (see `Concept.icon`). */
  icon: Schema.NullOr(Schema.String),
  /** Connector-managed kind (e.g. `"linear"`, `"google.gmail"`) when this concept
   *  is owned by an integration sync, else null — drives the graph's "integration
   *  concept" marker. */
  managedBy: Schema.NullOr(Schema.String),
})
export type ConceptGraphNode = typeof ConceptGraphNode.Type

/** A directed edge — a relation field on `from` pointing at concept `to`. */
export const ConceptGraphEdge = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  relationType: Schema.String,
  /** Inverse-side label (config.inverseName); null = unnamed. */
  inverseName: Schema.NullOr(Schema.String),
  cardinality: Schema.Literal("one", "many"),
  fieldName: Schema.String,
})
export type ConceptGraphEdge = typeof ConceptGraphEdge.Type

/** Concepts + their relationships, for the settings graph view. */
export const ConceptGraph = Schema.Struct({
  nodes: Schema.Array(ConceptGraphNode),
  edges: Schema.Array(ConceptGraphEdge),
})
export type ConceptGraph = typeof ConceptGraph.Type

/** Saved canvas positions for the concept graph: concept id → { x, y }.
 *  Shared org-wide presentation state (like sidebar views — no admin gate).
 *  Coordinates must be finite — NaN/Infinity would poison the stored layout. */
const FiniteNumber = Schema.Number.pipe(Schema.finite())
export const GraphLayout = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({ x: FiniteNumber, y: FiniteNumber }),
})
export type GraphLayout = typeof GraphLayout.Type

// ── shared filter conditions ───────────────────────────────────────────────────
// Used by the dashboard widget schemas below (and FilterBar); the "Sidebar"
// prefix is historical — sidebar sections no longer carry conditions.

/** One filter condition. `field` = a field id, or `__labels` for the label ops.
 *  Value shape varies by op: `between` = [min, max], `in`/`notIn` = an array,
 *  `empty`/`notEmpty`/`isMe` ignore it. Op set is APPEND-ONLY (bodies holding
 *  conditions are opaque persisted documents old clients must keep parsing). */
export const SidebarCondition = Schema.Struct({
  field: Schema.String,
  op: Schema.Literal(
    "eq",
    "hasLabel",
    "neq",
    "contains",
    "empty",
    "notEmpty",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "in",
    "notIn",
    "isMe",
    "notHasLabel",
    // Transition ops — only meaningful in an automation, where a previous state
    // exists to compare against. Elsewhere they never match (see conditions.ts).
    "changedTo",
    "changedFrom",
  ),
  value: Schema.Unknown,
})
export type SidebarCondition = typeof SidebarCondition.Type

/** How a condition set combines: every condition or at least one (absent = all). */
const ConditionMatch = { match: Schema.optional(Schema.Literal("all", "any")) }

// ── sidebar views (configurable nav layouts) ───────────────────────────────────
// A View is an ordered stack of sections, switched via the sidebar pager. The
// whole layout is `SidebarViewBody`; the server only persists/serves the
// document. The global nav items (Overview, Tasks, …) render in a fixed block
// above the sections unless placed into one (a `global:<key>` entry).

export const SidebarSection = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  collapsed: Schema.optional(Schema.Boolean),
  /** Ordered, explicitly-placed entries: a dashboard uuid, or `global:<key>`
   *  for a placed global nav item. Unknown/deleted ids are skipped at render
   *  time (kept in the body so nothing is silently pruned). */
  entryIds: Schema.Array(Schema.String),
})
export type SidebarSection = typeof SidebarSection.Type

export const SidebarViewBody = Schema.Struct({
  sections: Schema.Array(SidebarSection),
})
export type SidebarViewBody = typeof SidebarViewBody.Type

export const SidebarView = Schema.Struct({
  id: Schema.String,
  /** null = org-shared (any member); non-null = personal to that user. */
  ownerId: Schema.NullOr(Schema.String),
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  position: Schema.Number,
  hidden: Schema.Boolean,
  body: SidebarViewBody,
})
export type SidebarView = typeof SidebarView.Type

// ── dashboards (configurable widget canvases) ──────────────────────────────────
// A Dashboard is a grid canvas of widgets. The whole layout is `DashboardBody`
// and is resolved CLIENT-SIDE against the live concept/instance/event collections
// — the server only persists/serves the document. The widget union is APPEND-ONLY
// (a closed union breaks old clients on reshape); add new widget types at the end.

/** LEGACY pre-auto-layout placement (react-grid-layout coords). Kept optional so
 *  old stored bodies still decode; the client migrates them to the tree model
 *  (`Dim`-sized nodes) on load. New bodies omit it. */
const WidgetLayout = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  wUnit: Schema.optional(Schema.Literal("fr", "px", "pct")),
  hUnit: Schema.optional(Schema.Literal("fr", "px", "pct")),
  wFr: Schema.optional(Schema.Number),
})

/** A node's size along one axis, in 48-tile units (the window is 48×48 tiles).
 *  `fr` = flex weight: claims a share of the parent's LEFTOVER tiles along the
 *  parent's direction (0 when none are left). `tiles`/`pct` are fixed sizes;
 *  `min`/`max` (tiles) clamp the result. */
const Dim = Schema.Struct({
  unit: Schema.Literal("tiles", "fr", "pct"),
  value: Schema.Number,
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
})

/** Fields shared by every widget. `w`/`h` are the auto-layout size; `layout` is
 *  the legacy placement (migrated away on load). Both optional during the
 *  transition — the client normalizes either into a sized tree node. */
const widgetBase = {
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  layout: Schema.optional(WidgetLayout),
  w: Schema.optional(Dim),
  h: Schema.optional(Dim),
  /** Presentation variant id — a key into the client `VARIANT_CATALOG` for this
   *  widget type (which carries the label, optional preview, and any config
   *  preset applied on select). Free-form string by design: adding a variant is
   *  a catalog edit, never a schema/API change. Absent = the type's first
   *  catalog entry (its default). */
  variant: Schema.optional(Schema.String),
  /** Inner padding of the widget's tile, in px. Absent = the canvas default.
   *  0 = full bleed: content runs to the tile's edge and the tile drops its card
   *  chrome (border/background), for a widget that frames itself. */
  padding: Schema.optional(Schema.Number),
}
/** `conceptId` is optional on every concept-scoped widget so the same body can
 *  render in per-concept context (implicit conceptId) later. */
const ConceptScoped = { conceptId: Schema.optional(Schema.NullOr(Schema.String)) }
/** On a RECORD dashboard, a concept-scoped widget may narrow its population to the
 *  CURRENT record's related instances via this relation field id (instead of the
 *  whole concept). Ignored on a 'page' dashboard or when absent. */
const RecordRelationScoped = { relationFieldId: Schema.optional(Schema.NullOr(Schema.String)) }

/** One curated shortcut. `ref` is an instance id, dashboard id, or URL per `kind`;
 *  `label` is a display snapshot (dashboards re-resolve to the live name).
 *  Used by the Shortcuts widget and the Welcome widget's quick links. */
const ShortcutItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("instance", "dashboard", "url"),
  ref: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
})

const MetricWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  ...RecordRelationScoped,
  type: Schema.Literal("metric"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  agg: Schema.Literal("count", "sum", "avg"),
  field: Schema.optional(Schema.NullOr(Schema.String)),
  /** Caption under the hero number; absent/empty = auto ("Deals" / "sum of X"). */
  label: Schema.optional(Schema.NullOr(Schema.String)),
  format: Schema.optional(Schema.Literal("plain", "compact", "currency", "percent")),
  /** Secondary stat: change vs the value N days ago (instance-createdAt based). */
  delta: Schema.optional(Schema.Literal("off", "7d", "30d")),
  includeArchived: Schema.optional(Schema.Boolean),
})
const ListWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  ...RecordRelationScoped,
  type: Schema.Literal("list"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  orderBy: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  columns: Schema.optional(Schema.Array(Schema.String)),
  archived: Schema.optional(Schema.Literal("exclude", "include", "only")),
  /** `grouped` variant: enum field id to section rows by; absent = prompt to
   *  pick one (no implicit default). */
  groupBy: Schema.optional(Schema.NullOr(Schema.String)),
  /** `rows` variant: enum field id whose option color drives the status dot;
   *  absent = first enum. */
  statusField: Schema.optional(Schema.NullOr(Schema.String)),
  /** Open rows with this record-dashboard id (a 'record' dashboard of the row's
   *  concept); absent = that concept's default record view. */
  recordDashboardId: Schema.optional(Schema.NullOr(Schema.String)),
})
const BreakdownWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  ...RecordRelationScoped,
  type: Schema.Literal("breakdown"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  groupBy: Schema.String,
  /** Presentation: vertical bars / pie (recharts), ranked horizontal bars,
   *  donut-with-total, a 100%-stacked composition bar, or a numeric table. */
  chart: Schema.Literal("bar", "pie", "bars-h", "donut", "stacked", "table"),
  /** `field` = the enum's configured option order (falls back to label). */
  sort: Schema.optional(Schema.Literal("count", "label", "field")),
  /** Value labels on bars / in the legend. */
  values: Schema.optional(Schema.Literal("count", "percent", "both")),
  /** Collapse groups past this many into an "Other" bucket; null/absent = all. */
  maxGroups: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Table chart only: add a per-group trend sparkline + delta over this window. */
  delta: Schema.optional(Schema.Literal("off", "7d", "30d")),
})
const AttentionWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("attention"),
  computedField: Schema.optional(Schema.NullOr(Schema.String)),
  bands: Schema.optional(Schema.Array(Schema.Literal("cooling", "cold", "heating", "steady"))),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  /** "34d" quiet-duration per stale row (default on). */
  showDays: Schema.optional(Schema.Boolean),
  /** Pre-filter the population before the rollup; absent = all instances. */
  conditions: Schema.optional(Schema.Array(SidebarCondition)),
  ...ConditionMatch,
})
const TrendWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("trend"),
  eventTypes: Schema.optional(Schema.Array(Schema.String)),
  bucket: Schema.Literal("day", "week"),
  since: Schema.Literal("7d", "30d", "90d"),
  chart: Schema.optional(Schema.Literal("area", "bars")),
  /** Header verdict: % change vs the prior period of the same length. */
  showDelta: Schema.optional(Schema.Boolean),
})
const ActivityWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("activity"),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Inline payload snippets ("stage: open → nego", note previews). */
  showDiffs: Schema.optional(Schema.Boolean),
  /** Client-side event-type filter (e.g. notes only); absent = all. */
  eventTypes: Schema.optional(Schema.Array(Schema.String)),
})
/** On a RECORD dashboard, narrow an analytics query to THIS record: read the
 *  record's `fieldId` value and send it as an external `property` filter. Absent
 *  (or on a 'page' dashboard) = the whole org's series. */
const AnalyticsRecordFilter = Schema.Struct({
  /** Field id on the record's concept whose value identifies it externally
   *  (e.g. an email or domain field). */
  fieldId: Schema.String,
  /** The provider-side property to match that value against. */
  property: Schema.String,
})
/**
 * Aggregated time-series from an external analytics provider (PostHog today).
 * The ONLY data-bound widget whose numbers come from a server-side aggregation
 * rather than client-side grouping over concept instances — so it carries a
 * query config instead of a `conceptId`. The same type serves page dashboards
 * (org-wide) and record dashboards (via `recordFilter`), since the record case
 * is the identical query plus one filter.
 */
const AnalyticsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("analytics"),
  /** Which provider answers the query. A union of one today; adding a provider
   *  is a new member + a server branch, never a new widget type. */
  provider: Schema.Literal("posthog"),
  /** `active_users` = distinct people, `event_count` = raw event volume,
   *  `custom` = the provider query in `query` answers instead. */
  metric: Schema.Literal("active_users", "event_count", "custom"),
  /** Raw provider query (HogQL), used only when `metric` is "custom". Must
   *  return columns aliased `bucket`, `value` and optionally `series`; the
   *  window (`{from}`/`{to}`) and the resolved record value (`{recordValue}`)
   *  are bound as params, never interpolated. */
  query: Schema.optional(Schema.NullOr(Schema.String)),
  /** Restrict to one event name; absent/null = all events. Structured only. */
  event: Schema.optional(Schema.NullOr(Schema.String)),
  /** Bucket width. Structured only — a custom query buckets itself. */
  interval: Schema.Literal("day", "week", "month"),
  since: Schema.Literal("7d", "30d", "90d"),
  /** Provider property to split into one series per value ("the label Y"). */
  breakdown: Schema.optional(Schema.NullOr(Schema.String)),
  chart: Schema.optional(Schema.Literal("area", "bars", "table")),
  /** Header verdict: % change vs the prior period of the same length. */
  showDelta: Schema.optional(Schema.Boolean),
  recordFilter: Schema.optional(Schema.NullOr(AnalyticsRecordFilter)),
})
// The remaining widgets render org-global surfaces — no instance data scoping.
const TasksWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("tasks"),
  /** Default assignee scope; the in-tile toolbar can change it at runtime. */
  assignee: Schema.optional(Schema.Literal("all", "me", "none")),
  showToolbar: Schema.optional(Schema.Boolean),
  showComposer: Schema.optional(Schema.Boolean),
  showDone: Schema.optional(Schema.Boolean),
  groupBy: Schema.optional(Schema.Literal("schedule", "status", "priority", "none")),
  /** Which row metadata to render; absent = all. */
  rowMeta: Schema.optional(Schema.Array(Schema.Literal("due", "priority", "labels", "assignee"))),
  /** Only tasks in these statuses; absent/empty = all. */
  statusIds: Schema.optional(Schema.Array(Schema.String)),
  /** `week` = due within the next 7 days (incl. today). */
  due: Schema.optional(Schema.Literal("any", "overdue", "week")),
  /** FILTER, not data scoping: only tasks annotating that concept's records
   *  (task → item → conceptId, resolved via `resolveTaskSubjects`). */
  conceptId: Schema.optional(Schema.NullOr(Schema.String)),
})
const MembersWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("members"),
  showToolbar: Schema.optional(Schema.Boolean),
  /** Row metadata toggles (rows variant); absent = role + email. */
  fields: Schema.optional(Schema.Array(Schema.Literal("role", "email", "joined"))),
  sort: Schema.optional(Schema.Literal("name", "role", "joined")),
  /** Cap shown members, with a "view all" link; null/absent = all. */
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
})
const WelcomeWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("welcome"),
  /** "12 members · 87 events this week" line under the greeting. */
  showPulse: Schema.optional(Schema.Boolean),
  /** Curated quick links (same shape as Shortcuts items); absent/empty = none. */
  links: Schema.optional(Schema.Array(ShortcutItem)),
})
// Goal — a metric with a finish line: current value vs a manual target.
const GoalWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("goal"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  agg: Schema.Literal("count", "sum", "avg"),
  field: Schema.optional(Schema.NullOr(Schema.String)),
  /** Manual target number; null = not configured yet. */
  target: Schema.optional(Schema.NullOr(Schema.Number)),
  /** `reach` = progress toward >= target (quota); `stay` = keep <= target (budget). */
  direction: Schema.optional(Schema.Literal("reach", "stay")),
  showPercent: Schema.optional(Schema.Boolean),
})
// Shortcuts — hand-picked jump-off points; fully manual by design (no filters).
// (`ShortcutItem` is declared above the widget structs — Welcome reuses it.)
const ShortcutsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("shortcuts"),
  items: Schema.Array(ShortcutItem),
  /** Open URL targets in a new tab (internal targets always navigate in-app). */
  newTab: Schema.optional(Schema.Boolean),
})
// Note — free-form rich text on the canvas. The content is the same { doc, text }
// envelope as `RichTextEnvelope` (declared below; inlined here since the body is
// an opaque client-side document — the server never derives `text` for it).
const NoteWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("note"),
  content: Schema.optional(
    Schema.Struct({
      doc: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      text: Schema.String,
    }),
  ),
  appearance: Schema.optional(Schema.Literal("plain", "info", "warn", "success")),
  overflow: Schema.optional(Schema.Literal("clip", "scroll")),
})
// Kanban — instances as cards in columns keyed by an enum field (renderer: P2).
const KanbanWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  ...RecordRelationScoped,
  type: Schema.Literal("kanban"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  /** Enum field id whose values become the columns. */
  groupBy: Schema.String,
  /** Field ids shown on each card; absent = name + first two scalars. */
  cardFields: Schema.optional(Schema.Array(Schema.String)),
  /** Off = read-only board (no drag-to-update). */
  dragToUpdate: Schema.optional(Schema.Boolean),
  /** Subset + order of enum values shown as columns; absent = all. */
  columns: Schema.optional(Schema.Array(Schema.String)),
  showEmptyColumns: Schema.optional(Schema.Boolean),
  /** Field id ordering cards within a column; absent = default order. */
  orderBy: Schema.optional(Schema.NullOr(Schema.String)),
  includeArchived: Schema.optional(Schema.Boolean),
  /** Open cards with this record-dashboard id (a 'record' dashboard of the card's
   *  concept); absent = that concept's default record view. */
  recordDashboardId: Schema.optional(Schema.NullOr(Schema.String)),
})
/** One calendar source: a concept's instances plotted by a date field. */
const CalendarSource = Schema.Struct({
  conceptId: Schema.String,
  /** Date field id supplying each instance's position on the grid. */
  dateField: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  conditions: Schema.optional(Schema.Array(SidebarCondition)),
  ...ConditionMatch,
  /** Field id for the event label; absent = the instance's name/label. */
  labelField: Schema.optional(Schema.NullOr(Schema.String)),
})
// Calendar — instances plotted by date, multi-concept overlay (renderer: P3).
const CalendarWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("calendar"),
  mode: Schema.Literal("month", "week", "agenda"),
  sources: Schema.Array(CalendarSource),
  /** Overlay org tasks by due date as an extra source. */
  includeTasks: Schema.optional(Schema.Boolean),
  /** Month-mode cell rendering: full event cells vs dots + count. */
  density: Schema.optional(Schema.Literal("full", "dots")),
})
// Timeline/Gantt — instances as bars between two date fields (renderer: P3).
const GanttWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("gantt"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  scale: Schema.Literal("day", "week", "month"),
  /** Start date field id; an instance with no end renders a milestone. */
  startField: Schema.String,
  endField: Schema.optional(Schema.NullOr(Schema.String)),
  /** Enum/user field id for swimlane rows; absent = flat. */
  groupBy: Schema.optional(Schema.NullOr(Schema.String)),
  barLabelField: Schema.optional(Schema.NullOr(Schema.String)),
  /** Number field (0–100) filling the bar; absent = plain bars. */
  progressField: Schema.optional(Schema.NullOr(Schema.String)),
  showTodayLine: Schema.optional(Schema.Boolean),
  window: Schema.optional(Schema.Literal("fit", "90d", "quarter")),
})
// Files — uploads browsed at a scope (renderer: P4). Three scopes read files that
// belong to records; `widget` owns its own, attached to no record at all.
const FilesWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("files"),
  /** instance = one record's files; concept = recent across its instances; org =
   *  all; widget = this widget's own `bucketId` files (no record involved). */
  scope: Schema.Literal("instance", "concept", "org", "widget"),
  /** Instance id for `scope: "instance"` on a dashboard (no implicit context). */
  instanceId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `scope: "instance"` only — resolve the record from a single-record concept
   *  instead of pinning one `instanceId`. A boolean, not a second concept id: the
   *  concept is the one already in `conceptId`, so the two can't drift. */
  bindToConceptRecord: Schema.optional(Schema.Boolean),
  /** `scope: "widget"` only — the bucket owning this widget's files. Minted on
   *  switching to that scope; must be a fresh uuid, never a widget `id` (those
   *  repeat across dashboards, so two widgets would share one file set). */
  bucketId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `scope: "widget"` only, default true: may an org-scope Files widget list
   *  this bucket? False keeps the files to this widget. Gates listing, not
   *  access — a direct download URL stays reachable by any member. */
  bucketShared: Schema.optional(Schema.Boolean),
  /** Off = read-only browse (no drop-zone). */
  allowUpload: Schema.optional(Schema.Boolean),
  sort: Schema.optional(Schema.Literal("newest", "name", "size")),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  fileType: Schema.optional(Schema.Literal("all", "image", "doc", "pdf", "other")),
})
// Document — one record's rich text field, edited inline on the canvas. Bound to
// a specific record (`instanceId`) + a `richtext` field (`fieldId`); autosaves via
// `updateInstance` (the server re-derives the envelope's `text`). `conceptId` is
// the field-picker's scope (the chosen record's concept), not a data filter.
const DocumentWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("document"),
  instanceId: Schema.optional(Schema.NullOr(Schema.String)),
  /** Resolve the record from `conceptId`'s single record instead of pinning one
   *  `instanceId`. `conceptId` is already the field picker's scope, so binding
   *  reuses it — one id, no drift between the record and the field list. */
  bindToConceptRecord: Schema.optional(Schema.Boolean),
  fieldId: Schema.optional(Schema.NullOr(Schema.String)),
  /** Hide the field-name header above the editor. */
  hideLabel: Schema.optional(Schema.Boolean),
})

// ── record-scoped widgets ──────────────────────────────────────────────────────
// These render ONE panel of the CURRENT record and only make sense on a 'record'
// dashboard, where the instance is supplied by page context (not configured per
// widget). Each reuses an existing instance-detail panel. They carry NO
// `conceptId`/`instanceId` — the record is implicit; on a 'page' dashboard they
// show an "only on a record dashboard" empty state. (Document + Files cover the
// document/files panels already, auto-binding `instanceId` from record context.)
const RecordDetailsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-details"),
})
const RecordConnectionsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-connections"),
})
const RecordGraphWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-graph"),
})
const RecordLabelsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-labels"),
})
const RecordVersionsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-versions"),
})
const RecordNotesWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-notes"),
})
const RecordTasksWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-tasks"),
})
const RecordMentionsWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-mentions"),
})
const RecordActivityWidget = Schema.Struct({
  ...widgetBase,
  type: Schema.Literal("record-activity"),
})

export const DashboardWidget = Schema.Union(
  MetricWidget,
  ListWidget,
  BreakdownWidget,
  AttentionWidget,
  TrendWidget,
  ActivityWidget,
  AnalyticsWidget,
  TasksWidget,
  MembersWidget,
  WelcomeWidget,
  GoalWidget,
  ShortcutsWidget,
  NoteWidget,
  KanbanWidget,
  CalendarWidget,
  GanttWidget,
  FilesWidget,
  DocumentWidget,
  RecordDetailsWidget,
  RecordConnectionsWidget,
  RecordGraphWidget,
  RecordLabelsWidget,
  RecordVersionsWidget,
  RecordNotesWidget,
  RecordTasksWidget,
  RecordActivityWidget,
  RecordMentionsWidget,
)
export type DashboardWidget = typeof DashboardWidget.Type

// ── auto-layout tree ───────────────────────────────────────────────────────────
// A dashboard is a tree of nodes laid out like Figma auto-layout / CSS flexbox.
// A Group is an invisible container with a `direction` (row/col) that flows its
// children and hands them its own tile budget; nesting is allowed. A Widget is a
// leaf. Every node carries a `Dim` size per axis (`w`/`h`). The window is the
// root container (48×48 tiles). Resolved CLIENT-SIDE to flex CSS.

/** A group node — invisible structural container (discriminated by type:"group"
 *  against the widget `type`s). Recursive: children are nodes (widgets or groups).
 *  `display` picks how it presents its children: "flow" (default) lays them all
 *  out along `direction`; "tabs" shows one child at a time behind a tab bar (each
 *  child is a tab/panel). All tab fields are optional + ignored under "flow", so an
 *  older client decodes a tabs group as a plain flow group (graceful degradation). */
export interface DashboardGroup {
  readonly id: string
  readonly type: "group"
  readonly direction: "row" | "col"
  readonly display?: "flow" | "tabs" | undefined
  /** Optional name — shown in the Layers tree, and used as this node's tab title
   *  when its parent is a tabs group. */
  readonly label?: string | null | undefined
  /** Tabs only: the child id open by default (persisted). Falls back to the first
   *  child when absent/stale. */
  readonly active?: string | null | undefined
  /** Tabs only: which edge the tab bar sits on. Default "top". */
  readonly tabBar?: "top" | "bottom" | "left" | "right" | undefined
  readonly w?: typeof Dim.Type | undefined
  readonly h?: typeof Dim.Type | undefined
  readonly children: ReadonlyArray<DashboardNode>
}
export type DashboardNode = DashboardWidget | DashboardGroup

const DashboardGroup: Schema.Schema<DashboardGroup> = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("group"),
  direction: Schema.Literal("row", "col"),
  display: Schema.optional(Schema.Literal("flow", "tabs")),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  active: Schema.optional(Schema.NullOr(Schema.String)),
  tabBar: Schema.optional(Schema.Literal("top", "bottom", "left", "right")),
  w: Schema.optional(Dim),
  h: Schema.optional(Dim),
  children: Schema.Array(Schema.suspend((): Schema.Schema<DashboardNode> => DashboardNode)),
})
const DashboardNode: Schema.Schema<DashboardNode> = Schema.Union(DashboardWidget, DashboardGroup)

export const DashboardBody = Schema.Struct({
  /** Root container layout (the 48×48 window). New bodies set these. */
  direction: Schema.optional(Schema.Literal("row", "col")),
  children: Schema.optional(Schema.Array(DashboardNode)),
  /** LEGACY flat widget list — pre-auto-layout bodies; client migrates to a tree. */
  widgets: Schema.optional(Schema.Array(DashboardWidget)),
  cols: Schema.optional(Schema.Number),
  rowHeight: Schema.optional(Schema.Number),
})
export type DashboardBody = typeof DashboardBody.Type

export const Dashboard = Schema.Struct({
  id: Schema.String,
  /** null = org-shared (any member); non-null = personal to that user. */
  ownerId: Schema.NullOr(Schema.String),
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  position: Schema.Number,
  hidden: Schema.Boolean,
  body: DashboardBody,
  /** "page" (default/legacy) = free-standing canvas; "record" = a per-concept
   *  single-instance template. Optional for rollout: an older server omits it and
   *  the client treats it as "page". */
  kind: Schema.optional(Schema.Literal("page", "record")),
  /** The owning concept for a "record" dashboard; null for "page". Record
   *  dashboards are ordered by `position`; the first is what a bare reference
   *  opens (no default flag). */
  conceptId: Schema.optional(Schema.NullOr(Schema.String)),
  /** Last-write etag for optimistic concurrency (see `updateDashboard.expectedUpdatedAt`).
   *  Optional for rollout: an older server omits it, leaving the guard inactive. */
  updatedAt: Schema.optional(Schema.Date),
})
export type Dashboard = typeof Dashboard.Type

// ── annotation layer (notes / tasks / statuses / custom-field defs) ────────────
// Notes/tasks hang off an item lineage (`subjectId` = items.id) or off nothing
// (org-level task). `customFields` is the open bag keyed by AnnotationField id.

export const AnnotationType = Schema.Literal("note", "task")
export type AnnotationType = typeof AnnotationType.Type

/** `done` = completed (sets `completedAt`); `cancelled` = closed without
 *  completing (never sets it). */
export const TaskStatusCategory = Schema.Literal("todo", "active", "done", "cancelled")
export type TaskStatusCategory = typeof TaskStatusCategory.Type

/** A rich-text value: ProseMirror doc + server-derived plain text (the same
 *  envelope instance `richtext` fields use; the server re-derives `text`). */
export const RichTextEnvelope = Schema.Struct({
  doc: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  text: Schema.String,
})
export type RichTextEnvelope = typeof RichTextEnvelope.Type

/** A per-org configurable task priority (no semantics beyond position order;
 *  a new task starts with NO priority). */
export const TaskPriority = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  position: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type TaskPriority = typeof TaskPriority.Type

/** A per-org configurable task status. `category` carries completion semantics. */
export const TaskStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  category: TaskStatusCategory,
  isDefault: Schema.Boolean,
  position: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type TaskStatus = typeof TaskStatus.Type

/** A custom-field definition for the annotation layer (scoped by annotationType). */
export const AnnotationField = Schema.Struct({
  id: Schema.String,
  annotationType: AnnotationType,
  name: Schema.String,
  kind: FieldKind,
  config: FieldConfig,
  icon: Schema.NullOr(Schema.String),
  position: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type AnnotationField = typeof AnnotationField.Type

export const Note = Schema.Struct({
  id: Schema.String,
  /** Annotated item lineage (items.id); null = org-level. */
  subjectId: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdBy: Schema.NullOr(Schema.String),
  customFields: State,
  version: Schema.Number,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Note = typeof Note.Type

export const Task = Schema.Struct({
  id: Schema.String,
  /** Annotated item lineage (items.id); null = org-level / standalone. */
  subjectId: Schema.NullOr(Schema.String),
  title: Schema.String,
  /** Rich-text description; null = none. */
  description: Schema.NullOr(RichTextEnvelope),
  statusId: Schema.NullOr(Schema.String),
  /** Priority (task_priorities.id); null = no priority. */
  priorityId: Schema.NullOr(Schema.String),
  /** This task's own label ids (org label vocabulary, orphan-tolerant). */
  labelIds: Schema.Array(Schema.String),
  assignee: Schema.NullOr(Schema.String),
  /** ISO date string or null. */
  dueAt: Schema.NullOr(Schema.String),
  /** Hidden from "open" lists until this passes (ISO string); read-time check. */
  snoozedUntil: Schema.NullOr(Schema.String),
  /** Blocked marker; non-null = blocked (with optional reason + blocking task). */
  blockedAt: Schema.NullOr(Schema.Date),
  blockedReason: Schema.NullOr(Schema.String),
  blockedByTaskId: Schema.NullOr(Schema.String),
  /** Set on entering the `done` category, cleared on leaving; `cancelled` never sets it. */
  completedAt: Schema.NullOr(Schema.Date),
  createdBy: Schema.NullOr(Schema.String),
  customFields: State,
  version: Schema.Number,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Task = typeof Task.Type

/** A task's annotated item resolved for display (global Tasks page): the item's
 *  head version to route to, plus a server-resolved label (instance state is
 *  keyed by field id, which the client can't resolve without that concept's
 *  field defs — same reasoning as `RelatedInstance.label`). */
export const TaskSubjectRef = Schema.Struct({
  subjectId: Schema.String,
  /** Routable head version (latest published, else newest version); null = item gone. */
  instanceId: Schema.NullOr(Schema.String),
  label: Schema.String,
  conceptId: Schema.NullOr(Schema.String),
})
export type TaskSubjectRef = typeof TaskSubjectRef.Type

// ── @ mentions ──────────────────────────────────────────────────────────────────

/** What an `@` mention can point at. Mirrored by `engine/domain/mentions.ts` and
 *  the web client's `lib/mentionKinds.tsx`. */
export const MentionKind = Schema.Literal(
  "record",
  "person",
  "page",
  "concept",
  "dashboard",
  "file",
)
export type MentionKind = typeof MentionKind.Type

/** One mention, as stored in the document: the three node attrs. */
export const MentionTarget = Schema.Struct({
  kind: MentionKind,
  targetId: Schema.String,
})
export type MentionTarget = typeof MentionTarget.Type

/**
 * A mention resolved for display.
 *
 * `href: null` is THE enforcement signal — it means "not reachable by you",
 * covering both "you may not read this" and "this has no page", deliberately
 * indistinguishably. Naming which applies would confirm that a record exists in a
 * concept the reader is barred from, the same existence oracle restricted reads
 * avoid by failing as NotFound rather than 403. A null href renders as inert text.
 *
 * `label: null` means "keep the label already in the document". Unlike
 * `TaskSubjectRef`, this never substitutes an "(unavailable)" sentinel: a task row
 * must show something, whereas a mention already has the author's own prose in
 * place — replacing it with a sentinel would ANNOUNCE the restriction rather than
 * pass over it.
 *
 * `page` is resolved CLIENT-side (see `lib/mentionKinds.tsx`): `GLOBAL_NAV` is a
 * static nav table with no permission dimension, and the server has no business
 * owning a copy of it. Those refs come back all-null by design — do not "fix" it.
 *
 * The response is NOT positionally aligned with the request: it is deduped by
 * (kind, targetId), so callers must join on those rather than by index.
 */
export const MentionRef = Schema.Struct({
  kind: MentionKind,
  targetId: Schema.String,
  href: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  /** Secondary text (concept name, "personal", a file's type). Null when unresolvable. */
  subtitle: Schema.NullOr(Schema.String),
  /** Emoji or `lucide:Name`, the `ConceptIcon` vocabulary. */
  icon: Schema.NullOr(Schema.String),
})
export type MentionRef = typeof MentionRef.Type

/**
 * One inbound mention of a record: a document that references it.
 *
 * Unreachable sources are DROPPED from the list, not degraded to a placeholder —
 * the OPPOSITE of how an inline mention behaves, and deliberately so. An inline
 * mention cannot be dropped: its label is already in prose the reader can see, so
 * hiding it would achieve nothing. A backlink has no such prior exposure, and a
 * "(unavailable) mentions this record" row would newly confirm that a document the
 * reader may not open references this one. Same rule the relation resolver applies
 * to unreadable targets. Do not "fix" the inconsistency — it is the point.
 */
export const BacklinkRef = Schema.Struct({
  /** Which rich-text home the mention was written in. */
  source: Schema.Literal("record", "task"),
  /** Where to go. Null for a task, which has no deep link yet. */
  href: Schema.NullOr(Schema.String),
  label: Schema.String,
  /** The richtext field's name ("Summary"); null for a task description. */
  fieldName: Schema.NullOr(Schema.String),
  conceptName: Schema.NullOr(Schema.String),
})
export type BacklinkRef = typeof BacklinkRef.Type

// ── member deactivation ─────────────────────────────────────────────────────────
// Deactivation is the member analogue of archive — a restorable marker that
// blocks org access and hides the user from pickers.

// A member's instance-detail layout prefs (`InstanceViewTile`/`InstanceViewLayout`
// are defined above, by `Concept.instanceView`): which preset view to render, as
// a global default plus per-concept overrides keyed by concept id. View keys name
// client-defined presets (resolved client-side; unknown keys fall back). A concept
// override may also be "custom", backed by a user-edited tile layout in
// `customByConcept` — content keys are opaque strings (the client drops unknowns).

// Traversal + render settings for the relationship-graph tile content. Stored
// opaquely like the rest of the prefs body; the client clamps/falls back on
// values it doesn't recognise (e.g. an unknown layout key from a newer build).
export const InstanceGraphConfig = Schema.Struct({
  /** Relation field ids the walk may follow; null = all. */
  fieldIds: Schema.NullOr(Schema.Array(Schema.String)),
  /** Max hops from the viewed instance. */
  depth: Schema.Number,
  /** Client-defined layout key (e.g. "dagre-tb"). */
  layout: Schema.String,
})
export type InstanceGraphConfig = typeof InstanceGraphConfig.Type

export const InstanceViewPrefsBody = Schema.Struct({
  defaultView: Schema.NullOr(Schema.String),
  byConcept: Schema.Record({ key: Schema.String, value: Schema.String }),
  customByConcept: Schema.Record({ key: Schema.String, value: InstanceViewLayout }),
  /** Graph-tile settings keyed by concept id; optional — pre-existing rows lack it. */
  graphByConcept: Schema.optional(
    Schema.Record({ key: Schema.String, value: InstanceGraphConfig }),
  ),
})
export type InstanceViewPrefsBody = typeof InstanceViewPrefsBody.Type

export const InstanceViewPrefs = Schema.Struct({
  userId: Schema.String,
  body: InstanceViewPrefsBody,
})
export type InstanceViewPrefs = typeof InstanceViewPrefs.Type

export const DeactivatedMember = Schema.Struct({
  userId: Schema.String,
  deactivatedAt: Schema.Date,
})
export type DeactivatedMember = typeof DeactivatedMember.Type

// ── automations ────────────────────────────────────────────────────────────────
// "when X, if Y, then Z". `trigger` and `actions` are validated documents, and
// the union is APPEND-ONLY exactly like the widget union above: add new kinds at
// the END, never reshape an existing one, because persisted rows must keep
// parsing on an older build. Concepts/fields/labels are referenced by id.

export const AutomationTrigger = Schema.Struct({
  kind: Schema.Literal(
    "record.created",
    "record.changed",
    "record.archived",
    "version.published",
    "record.band.changed",
    "task.created",
    "task.status.changed",
    "schedule",
  ),
  /** Restrict to one concept (record.* + task.created); absent = any. */
  conceptId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `record.changed`: fire only when THIS field is in the patch.
   *  `record.band.changed`: which computed field's band moved. */
  fieldId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `record.band.changed`: the destination band. */
  band: Schema.optional(Schema.NullOr(Schema.String)),
  /** `task.status.changed`: the destination status id. */
  statusId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `schedule` cadence + when. `day` is capped at 28 so every month has it. */
  every: Schema.optional(Schema.Literal("day", "week", "month")),
  hour: Schema.optional(Schema.Number),
  weekday: Schema.optional(Schema.Number),
  day: Schema.optional(Schema.Number),
})
export type AutomationTrigger = typeof AutomationTrigger.Type

const SetFieldAction = Schema.Struct({
  kind: Schema.Literal("setField"),
  fieldId: Schema.String,
  value: Schema.Unknown,
})
const AddLabelAction = Schema.Struct({
  kind: Schema.Literal("addLabel"),
  labelId: Schema.String,
})
const RemoveLabelAction = Schema.Struct({
  kind: Schema.Literal("removeLabel"),
  labelId: Schema.String,
})
const CreateTaskAction = Schema.Struct({
  kind: Schema.Literal("createTask"),
  title: Schema.String,
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  statusId: Schema.optional(Schema.NullOr(Schema.String)),
  priorityId: Schema.optional(Schema.NullOr(Schema.String)),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  /** Days from the run to the due date; absent = no due date. */
  dueInDays: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Hang it off the trigger record (default) vs org-level. */
  onRecord: Schema.optional(Schema.Boolean),
})
const CreateRecordAction = Schema.Struct({
  kind: Schema.Literal("createRecord"),
  conceptId: Schema.String,
  fields: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
/** Archive, never purge: an automation may only do reversible things. */
const ArchiveRecordAction = Schema.Struct({
  kind: Schema.Literal("archiveRecord"),
})
const NotifySlackAction = Schema.Struct({
  kind: Schema.Literal("notifySlack"),
  channel: Schema.String,
  text: Schema.String,
})
const WebhookAction = Schema.Struct({
  kind: Schema.Literal("webhook"),
  url: Schema.String,
  body: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})

// ── Slack ────────────────────────────────────────────────────────────────────
const SlackThreadReplyAction = Schema.Struct({
  kind: Schema.Literal("slack.postThreadReply"),
  channel: Schema.String,
  threadTs: Schema.String,
  text: Schema.String,
})
const SlackBlocksAction = Schema.Struct({
  kind: Schema.Literal("slack.postBlocks"),
  channel: Schema.String,
  /** Raw Block Kit JSON; validated at the write boundary, not by the schema. */
  blocks: Schema.String,
  text: Schema.String,
})
const SlackDmAction = Schema.Struct({
  kind: Schema.Literal("slack.dmUser"),
  slackUserId: Schema.String,
  text: Schema.String,
})
const SlackReactionAction = Schema.Struct({
  kind: Schema.Literal("slack.addReaction"),
  channel: Schema.String,
  ts: Schema.String,
  name: Schema.String,
})

// ── Linear ───────────────────────────────────────────────────────────────────
const LinearUpdateIssueAction = Schema.Struct({
  kind: Schema.Literal("linear.updateIssue"),
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
const LinearCloseIssueAction = Schema.Struct({ kind: Schema.Literal("linear.closeIssue") })
const LinearCommentAction = Schema.Struct({
  kind: Schema.Literal("linear.comment"),
  body: Schema.String,
})
const LinearAssignAction = Schema.Struct({
  kind: Schema.Literal("linear.assign"),
  email: Schema.String,
})
const LinearCreateIssueAction = Schema.Struct({
  kind: Schema.Literal("linear.createIssue"),
  teamId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
})

export const AutomationAction = Schema.Union(
  SetFieldAction,
  AddLabelAction,
  RemoveLabelAction,
  CreateTaskAction,
  CreateRecordAction,
  ArchiveRecordAction,
  NotifySlackAction,
  WebhookAction,
  SlackThreadReplyAction,
  SlackBlocksAction,
  SlackDmAction,
  SlackReactionAction,
  LinearUpdateIssueAction,
  LinearCloseIssueAction,
  LinearCommentAction,
  LinearAssignAction,
  LinearCreateIssueAction,
)
export type AutomationAction = typeof AutomationAction.Type

export const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  conditions: Schema.Array(SidebarCondition),
  match: Schema.Literal("all", "any"),
  actions: Schema.Array(AutomationAction),
  nextRunAt: Schema.NullOr(Schema.Date),
  lastRunAt: Schema.NullOr(Schema.Date),
  runCount: Schema.Number,
  /** Non-null ⇒ the automation paused ITSELF (rate cap). */
  pausedReason: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Automation = typeof Automation.Type

export const AutomationRun = Schema.Struct({
  id: Schema.String,
  automationId: Schema.String,
  eventId: Schema.NullOr(Schema.Number),
  subjectId: Schema.NullOr(Schema.String),
  status: Schema.Literal("ok", "skipped", "failed"),
  detail: Schema.Struct({
    reason: Schema.optional(Schema.String),
    actions: Schema.optional(
      Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          ok: Schema.Boolean,
          note: Schema.optional(Schema.String),
        }),
      ),
    ),
    failedAt: Schema.optional(Schema.Number),
    error: Schema.optional(Schema.String),
  }),
  startedAt: Schema.Date,
  finishedAt: Schema.NullOr(Schema.Date),
})
export type AutomationRun = typeof AutomationRun.Type

/** What a dry run reports — what WOULD happen, having written nothing. */
export const AutomationDryRun = Schema.Struct({
  matched: Schema.Number,
  scanned: Schema.Number,
  samples: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  /** Set when the preview is inherently partial (e.g. transition conditions). */
  note: Schema.NullOr(Schema.String),
})
export type AutomationDryRun = typeof AutomationDryRun.Type

/** One serializable error for the whole API; `code` mirrors the old HTTP codes. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

const Fields = Schema.Record({ key: Schema.String, value: Schema.Unknown })

// ── procedures ────────────────────────────────────────────────────────────────

/** The resource kinds an access rule can target. Mirrors `AccessResourceType` in
 *  engine/domain/access.ts — kept as a literal union so the wire rejects unknowns. */
export const AccessResourceType = Schema.Literal(
  "org",
  "concept",
  "record",
  "field",
  "dashboard",
  "view",
  "automation",
  "bucket",
  "task",
  "note",
  "member",
)
export type AccessResourceType = typeof AccessResourceType.Type

/**
 * `resourceType` as it appears on a rule the server SENDS.
 *
 * Deliberately looser than `AccessResourceType`, which stays a closed literal for
 * INPUTS — a client must never invent a resource type, and the strict union is what
 * rejects a typo at the boundary.
 *
 * On the way out the strictness is actively harmful: Schema validates the whole
 * response, so ONE row with a value this client doesn't know (a newer server, or a
 * hand-written row) makes the ENTIRE rule list fail to decode. Observed: a single
 * unrecognised type turned a role's twelve rules into "No rules yet", which reads as
 * "this role grants nothing" — the most dangerous possible lie for a permissions
 * screen. The UI groups anything it can't name under "Other" instead.
 */
export const AccessResourceTypeOut = Schema.String

/** A grantable action. `"*"` is deliberately NOT on the wire: a client may only ever
 *  grant named actions, so a future action is never handed out by an old dialog. */
export const AccessActionName = Schema.Literal(
  "view",
  "create",
  "edit",
  "archive",
  "delete",
  "share",
  "configure",
)
export type AccessActionName = typeof AccessActionName.Type

/** One grant as the Share dialog sees it. `userId`/`roleId` are exclusive. */
export const AccessGrant = Schema.Struct({
  id: Schema.String,
  userId: Schema.NullOr(Schema.String),
  roleId: Schema.NullOr(Schema.String),
  /** The role's display name, resolved server-side so the dialog needs no second
   *  fetch. Null for a person grant. */
  roleName: Schema.NullOr(Schema.String),
  effect: Schema.Literal("allow", "deny"),
  actions: Schema.Array(Schema.String),
  // See AccessResourceTypeOut: loose on the way OUT so one unknown value cannot
  // blank the whole list.
  resourceType: AccessResourceTypeOut,
  resourceId: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
})
export type AccessGrant = Schema.Schema.Type<typeof AccessGrant>

/** A condition narrowing a rule to a subset of records. Mirrors `AccessCondition`
 *  in engine/domain/access.ts. Every variant must compile to SQL, which is why the
 *  set is small and closed — see the note there. */
export const AccessCondition = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("actorIs"), who: Schema.Literal("creator") }),
  Schema.Struct({ kind: Schema.Literal("fieldIs"), fieldId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("where"),
    state: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
)
export type AccessCondition = Schema.Schema.Type<typeof AccessCondition>

/** A role: a named, reusable bag of rules. `key` non-null = a seeded preset. */
export const AccessRole = Schema.Struct({
  id: Schema.String,
  key: Schema.NullOr(Schema.String),
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  builtin: Schema.Boolean,
  /** Holds a blanket `*` and is exempt from per-resource values. The grid renders
   *  these roles read-only, and create forms leave them out — a full-access role
   *  cannot be "not allowed" to see something. */
  fullAccess: Schema.Boolean,
  position: Schema.Number,
})
export type AccessRole = Schema.Schema.Type<typeof AccessRole>

/** One rule on a role, as the role editor lists them. */
export const AccessRule = Schema.Struct({
  id: Schema.String,
  effect: Schema.Literal("allow", "deny"),
  actions: Schema.Array(Schema.String),
  resourceType: AccessResourceTypeOut,
  resourceId: Schema.NullOr(Schema.String),
  conceptId: Schema.NullOr(Schema.String),
  condition: Schema.NullOr(AccessCondition),
})
export type AccessRule = Schema.Schema.Type<typeof AccessRule>

/** What one member can do, resolved — the effective-access report. */
export const EffectiveAccess = Schema.Struct({
  userId: Schema.String,
  roles: Schema.Array(AccessRole),
  /** Every rule that applies, with the role it came from (null = a direct share). */
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      viaRoleId: Schema.NullOr(Schema.String),
      viaRoleName: Schema.NullOr(Schema.String),
      effect: Schema.Literal("allow", "deny"),
      actions: Schema.Array(Schema.String),
      resourceType: AccessResourceTypeOut,
      resourceId: Schema.NullOr(Schema.String),
      condition: Schema.NullOr(AccessCondition),
    }),
  ),
})
export type EffectiveAccess = Schema.Schema.Type<typeof EffectiveAccess>

export class KingsmakerRpcs extends RpcGroup.make(
  Rpc.make("listConcepts", {
    payload: {
      includeArchived: Schema.optional(Schema.Boolean),
      withCounts: Schema.optional(Schema.Boolean),
    },
    success: Schema.Array(Concept),
    error: RpcError,
  }),
  Rpc.make("createConcept", {
    // The client picks the default color (a free pill-palette hex, unique among
    // the org's concepts) — the server stores it verbatim like an explicit pick.
    payload: {
      name: Schema.String,
      color: Schema.optional(Schema.NullOr(Schema.String)),
      /** Who can see it, per role, chosen while naming it. Absent = the creation
       *  template decides. Only `view`: everything else comes from the template. */
      access: Schema.optional(
        Schema.Array(Schema.Struct({ roleId: Schema.String, view: Schema.Boolean })),
      ),
    },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("updateConcept", {
    payload: {
      id: Schema.String,
      description: Schema.NullOr(Schema.String),
      name: Schema.optional(Schema.String),
      // Omitted → unchanged; null / blank → cleared back to the singular fallback.
      pluralName: Schema.optional(Schema.NullOr(Schema.String)),
      // Omitted → left unchanged (so the name/description save never wipes them).
      icon: Schema.optional(Schema.NullOr(Schema.String)),
      color: Schema.optional(Schema.NullOr(Schema.String)),
      // Toggle per-concept versioning (admin). Disabling is rejected if any item
      // already has multiple versions or an open draft (VERSIONING_IN_USE).
      versioningEnabled: Schema.optional(Schema.Boolean),
      // Allow amending published versions (admin). Needs no guard either way:
      // tightening back to 'draft' just re-freezes them.
      editReach: Schema.optional(EditReach),
      staticLabelIds: Schema.optional(Schema.Array(Schema.String)),
      defaultLabelIds: Schema.optional(Schema.Array(Schema.String)),
    },
    success: Concept,
    error: RpcError,
  }),
  // Set (or clear with null) a concept's org-wide default instance-detail layout.
  // NOT admin-gated — any member may shape the layout (unlike the identity/
  // versioning edits in updateConcept).
  Rpc.make("setConceptInstanceView", {
    payload: { id: Schema.String, instanceView: Schema.NullOr(InstanceViewLayout) },
    success: Concept,
    error: RpcError,
  }),
  // Set (or clear with null) the field used as a concept's instance display label
  // ("title"). Admin-gated (a schema-shaping choice). Rejected for managed concepts
  // (the integration owns it).
  Rpc.make("setConceptTitleField", {
    payload: { id: Schema.String, titleFieldId: Schema.NullOr(Schema.String) },
    success: Concept,
    error: RpcError,
  }),
  // Set who may READ a concept's records. Admin-gated and applied immediately, NOT
  // part of `updateConcept`'s batched patch: it is a security control, so it should
  // not ride along with a name/description save (nor be silently re-sent by an
  // editor that loaded the concept before the setting changed).
  // Set who may READ one field's values (admin-gated, immediate). Concept-level
  // visibility hides a whole concept; this is for the case where the concept must
  // stay readable but one field must not.
  Rpc.make("setFieldVisibility", {
    payload: { id: Schema.String, visibility: ConceptVisibility },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("setConceptVisibility", {
    payload: { id: Schema.String, visibility: ConceptVisibility },
    success: Concept,
    error: RpcError,
  }),
  // Turn "single record" mode on or off. Admin-gated, and applied IMMEDIATELY —
  // NOT part of `updateConcept`'s batched patch, because switching on also creates
  // the concept's one record in the same transaction. `fields` seeds that record;
  // it is required in practice whenever the concept has required fields (the
  // engine runs the ordinary `checkRequired`, so a short payload rolls the whole
  // toggle back). Rejected for managed concepts.
  Rpc.make("setConceptSingleRecord", {
    payload: {
      conceptId: Schema.String,
      singleRecord: Schema.Boolean,
      fields: Schema.optional(Fields),
    },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("archiveConcept", {
    payload: { id: Schema.String },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("restoreConcept", {
    payload: { id: Schema.String },
    success: Concept,
    error: RpcError,
  }),
  // Hard delete — permanently removes the concept and its field defs.
  Rpc.make("deleteConcept", {
    payload: { id: Schema.String },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("listLabels", {
    payload: { includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Label),
    error: RpcError,
  }),
  Rpc.make("createLabel", {
    payload: {
      name: Schema.String,
      color: Schema.optional(Schema.NullOr(Schema.String)),
      primary: Schema.optional(Schema.Boolean),
    },
    success: Label,
    error: RpcError,
  }),
  Rpc.make("renameLabel", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      color: Schema.optional(Schema.NullOr(Schema.String)),
      primary: Schema.optional(Schema.Boolean),
    },
    success: Label,
    error: RpcError,
  }),
  Rpc.make("archiveLabel", {
    payload: { id: Schema.String },
    success: Label,
    error: RpcError,
  }),
  Rpc.make("restoreLabel", {
    payload: { id: Schema.String },
    success: Label,
    error: RpcError,
  }),
  // Hard delete — permanently removes the label from the vocabulary.
  Rpc.make("deleteLabel", {
    payload: { id: Schema.String },
    success: Label,
    error: RpcError,
  }),
  Rpc.make("listFields", {
    payload: { conceptId: Schema.String, includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Field),
    error: RpcError,
  }),
  Rpc.make("getConceptGraph", { success: ConceptGraph, error: RpcError }),
  Rpc.make("getGraphLayout", { success: GraphLayout, error: RpcError }),
  Rpc.make("saveGraphLayout", {
    payload: { positions: GraphLayout },
    success: GraphLayout,
    error: RpcError,
  }),
  // Saved positions for one item's relationship graph (instance-page tile),
  // keyed by the root item; same merge-patch contract as the concept canvas.
  Rpc.make("getInstanceGraphLayout", {
    payload: { itemId: Schema.String },
    success: GraphLayout,
    error: RpcError,
  }),
  Rpc.make("saveInstanceGraphLayout", {
    payload: { itemId: Schema.String, positions: GraphLayout },
    success: GraphLayout,
    error: RpcError,
  }),
  Rpc.make("addField", {
    payload: {
      conceptId: Schema.String,
      name: Schema.String,
      kind: FieldKind,
      config: Schema.optional(FieldConfig),
      formula: Schema.optional(Schema.String),
      icon: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("updateField", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      config: Schema.optional(FieldConfig),
      formula: Schema.optional(Schema.NullOr(Schema.String)),
      icon: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("archiveField", {
    payload: { id: Schema.String },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("restoreField", {
    payload: { id: Schema.String },
    success: Field,
    error: RpcError,
  }),
  // Hard delete — permanently removes the field def.
  Rpc.make("deleteField", {
    payload: { id: Schema.String },
    success: Field,
    error: RpcError,
  }),
  // Batch-set field display positions for a concept (drag reorder).
  Rpc.make("reorderFields", {
    payload: {
      conceptId: Schema.String,
      orders: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
    },
    success: Schema.Array(Field),
    error: RpcError,
  }),
  Rpc.make("listInstances", {
    payload: { conceptId: Schema.String, includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Instance),
    error: RpcError,
  }),
  Rpc.make("getInstance", {
    payload: { id: Schema.String },
    success: InstanceDetail,
    error: RpcError,
  }),
  // The sole record of a single-record concept, in the SAME shape as `getInstance`
  // so `/c/<slug>` renders through the ordinary record view. Null means the concept
  // has no record — impossible while the flag is on, so the client treats it as a
  // recoverable fault rather than an empty state.
  Rpc.make("getSingleRecord", {
    payload: { conceptId: Schema.String },
    success: Schema.NullOr(InstanceDetail),
    error: RpcError,
  }),
  Rpc.make("getChanged", { success: Schema.Array(FeedItem), error: RpcError }),
  // A larger/filterable recent-events window for the dashboard Trend + Activity
  // widgets. `since` = epoch ms lower bound; `conceptId` restricts to that
  // concept's instance events.
  Rpc.make("listEvents", {
    payload: {
      conceptId: Schema.optional(Schema.NullOr(Schema.String)),
      since: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    },
    success: Schema.Array(FeedItem),
    error: RpcError,
  }),
  Rpc.make("createInstance", {
    payload: { conceptId: Schema.String, fields: Fields },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("updateInstance", {
    payload: { id: Schema.String, expectedVersion: Schema.Number, patch: Fields },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("transitionInstance", {
    payload: {
      id: Schema.String,
      expectedVersion: Schema.Number,
      field: Schema.String,
      to: Schema.String,
    },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("archiveInstance", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("restoreInstance", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Instance,
    error: RpcError,
  }),
  // Hard delete — permanently removes the instance and its event stream.
  Rpc.make("deleteInstance", {
    payload: { id: Schema.String },
    success: Instance,
    error: RpcError,
  }),
  // ── versioning ──────────────────────────────────────────────────────────────
  // All versions of an item (draft + published), oldest first — the detail panel.
  Rpc.make("listVersions", {
    payload: { itemId: Schema.String },
    success: Schema.Array(Instance),
    error: RpcError,
  }),
  // Open a new editable draft cloned from the item's latest published version.
  Rpc.make("newVersion", {
    payload: { itemId: Schema.String },
    success: Instance,
    error: RpcError,
  }),
  // Freeze a draft: draft → published (permanent). Bumps the event counter.
  Rpc.make("publishVersion", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Instance,
    error: RpcError,
  }),
  // Discard an open draft (hard delete of the draft row + its cloned edges).
  Rpc.make("discardDraft", {
    payload: { id: Schema.String },
    success: Instance,
    error: RpcError,
  }),
  // Whole-item (lineage) archive / restore — hides or restores every version.
  Rpc.make("archiveItem", {
    payload: { itemId: Schema.String },
    success: Item,
    error: RpcError,
  }),
  Rpc.make("restoreItem", {
    payload: { itemId: Schema.String },
    success: Item,
    error: RpcError,
  }),
  // Search target instances of a concept (head/latest per item) for the relation
  // picker. Returns one candidate per item.
  Rpc.make("searchInstances", {
    payload: {
      conceptId: Schema.String,
      query: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number),
    },
    success: Schema.Array(InstancePick),
    error: RpcError,
  }),
  // Create a relation edge. Target is `toVersionId` (pinned) or `toItemId`
  // (general / "Latest"); `toId` legacy instance id also accepted.
  Rpc.make("createRelation", {
    payload: {
      fieldId: Schema.String,
      fromId: Schema.String,
      toItemId: Schema.optional(Schema.String),
      toVersionId: Schema.optional(Schema.String),
      toId: Schema.optional(Schema.String),
      properties: Schema.optional(Fields),
    },
    success: Relation,
    error: RpcError,
  }),
  Rpc.make("removeRelation", {
    payload: { relationId: Schema.String },
    success: Relation,
    error: RpcError,
  }),
  Rpc.make("listViews", { success: Schema.Array(SidebarView), error: RpcError }),
  Rpc.make("createView", {
    payload: {
      name: Schema.String,
      icon: Schema.optional(Schema.NullOr(Schema.String)),
      scope: Schema.Literal("personal", "org"),
      body: SidebarViewBody,
    },
    success: SidebarView,
    error: RpcError,
  }),
  Rpc.make("updateView", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      icon: Schema.optional(Schema.NullOr(Schema.String)),
      hidden: Schema.optional(Schema.Boolean),
      scope: Schema.optional(Schema.Literal("personal", "org")),
      body: Schema.optional(SidebarViewBody),
    },
    success: SidebarView,
    error: RpcError,
  }),
  Rpc.make("deleteView", {
    payload: { id: Schema.String },
    success: SidebarView,
    error: RpcError,
  }),
  Rpc.make("reorderViews", {
    payload: {
      orders: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
    },
    success: Schema.Array(SidebarView),
    error: RpcError,
  }),
  /** Page dashboards only (the switcher). Record dashboards: `listRecordDashboards`. */
  Rpc.make("listDashboards", { success: Schema.Array(Dashboard), error: RpcError }),
  /** Every dashboard (page + record) — the settings management list groups both. */
  Rpc.make("listAllDashboards", { success: Schema.Array(Dashboard), error: RpcError }),
  /** A concept's record dashboards (org-shared templates), default first. */
  Rpc.make("listRecordDashboards", {
    payload: { conceptId: Schema.String },
    success: Schema.Array(Dashboard),
    error: RpcError,
  }),
  Rpc.make("createDashboard", {
    payload: {
      name: Schema.String,
      icon: Schema.optional(Schema.NullOr(Schema.String)),
      scope: Schema.Literal("personal", "org"),
      body: DashboardBody,
      /** "record" creates a per-concept template (forced org-shared, appended last);
       *  "conceptId" is then required. Absent/"page" = a free-standing dashboard. */
      kind: Schema.optional(Schema.Literal("page", "record")),
      conceptId: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: Dashboard,
    error: RpcError,
  }),
  Rpc.make("updateDashboard", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      icon: Schema.optional(Schema.NullOr(Schema.String)),
      hidden: Schema.optional(Schema.Boolean),
      scope: Schema.optional(Schema.Literal("personal", "org")),
      body: Schema.optional(DashboardBody),
      /** Repoint a RECORD dashboard at a different concept. Its widgets reference
       *  the old concept's fields, so the caller resets `body` alongside this.
       *  The row is appended last in the new concept's view order. */
      conceptId: Schema.optional(Schema.NullOr(Schema.String)),
      /** Optimistic-concurrency guard: if set and it no longer matches the row's
       *  current `updatedAt`, the update is rejected (someone else edited it). */
      expectedUpdatedAt: Schema.optional(Schema.Date),
    },
    success: Dashboard,
    error: RpcError,
  }),
  Rpc.make("deleteDashboard", {
    payload: { id: Schema.String },
    success: Dashboard,
    error: RpcError,
  }),
  Rpc.make("reorderDashboards", {
    payload: {
      orders: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
    },
    success: Schema.Array(Dashboard),
    error: RpcError,
  }),
  // ── annotation layer: notes ───────────────────────────────────────────────────
  Rpc.make("listNotes", {
    payload: { subjectId: Schema.String, includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Note),
    error: RpcError,
  }),
  Rpc.make("createNote", {
    payload: {
      subjectId: Schema.NullOr(Schema.String),
      body: Schema.String,
      customFields: Schema.optional(Fields),
    },
    success: Note,
    error: RpcError,
  }),
  Rpc.make("updateNote", {
    payload: {
      id: Schema.String,
      expectedVersion: Schema.Number,
      body: Schema.optional(Schema.String),
      customFields: Schema.optional(Fields),
    },
    success: Note,
    error: RpcError,
  }),
  Rpc.make("archiveNote", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Note,
    error: RpcError,
  }),
  Rpc.make("restoreNote", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Note,
    error: RpcError,
  }),
  // Hard delete (purge) — author/assignee/admin gated at the boundary.
  Rpc.make("deleteNote", {
    payload: { id: Schema.String },
    success: Note,
    error: RpcError,
  }),
  // ── annotation layer: tasks ───────────────────────────────────────────────────
  // Filter superset: per-item panel passes `subjectId`; global "My Tasks" passes
  // assignee/status/due. Omit `subjectId` to query across all items.
  Rpc.make("listTasks", {
    payload: {
      subjectId: Schema.optional(Schema.NullOr(Schema.String)),
      assignee: Schema.optional(Schema.String),
      statusId: Schema.optional(Schema.String),
      dueBefore: Schema.optional(Schema.String),
      dueAfter: Schema.optional(Schema.String),
      includeArchived: Schema.optional(Schema.Boolean),
      limit: Schema.optional(Schema.Number),
    },
    success: Schema.Array(Task),
    error: RpcError,
  }),
  // Batch-resolve task subjects (item lineage ids) to routable instances +
  // display labels — the global Tasks page's record chips.
  Rpc.make("resolveTaskSubjects", {
    payload: { subjectIds: Schema.Array(Schema.String) },
    success: Schema.Array(TaskSubjectRef),
    error: RpcError,
  }),
  // Batch-resolve the `@` mentions in one document to live labels + routes.
  // Never fails on an individual target: an unresolvable one degrades to a null
  // href, which is how mention permissions are enforced. See `MentionRef`.
  Rpc.make("resolveMentions", {
    payload: { refs: Schema.Array(MentionTarget) },
    success: Schema.Array(MentionRef),
    error: RpcError,
  }),
  // Everything that mentions this record (an item lineage id). Sources the caller
  // may not read are dropped — see `BacklinkRef`.
  Rpc.make("listBacklinks", {
    payload: { itemId: Schema.String },
    success: Schema.Array(BacklinkRef),
    error: RpcError,
  }),
  // Records-only typeahead for the `@` menu, ACROSS every concept the caller may
  // read (`searchInstances` is per-concept, which an `@` menu can't fan out over).
  // Deliberately narrow so it doesn't become a dumping ground: people, concepts,
  // dashboards and pages are all already client-cached and composed there.
  Rpc.make("searchMentionableRecords", {
    payload: { query: Schema.String, limit: Schema.optional(Schema.Number) },
    success: Schema.Array(MentionRef),
    error: RpcError,
  }),
  Rpc.make("createTask", {
    payload: {
      subjectId: Schema.NullOr(Schema.String),
      title: Schema.String,
      description: Schema.optional(Schema.NullOr(RichTextEnvelope)),
      statusId: Schema.optional(Schema.NullOr(Schema.String)),
      priorityId: Schema.optional(Schema.NullOr(Schema.String)),
      labelIds: Schema.optional(Schema.Array(Schema.String)),
      assignee: Schema.optional(Schema.NullOr(Schema.String)),
      dueAt: Schema.optional(Schema.NullOr(Schema.String)),
      customFields: Schema.optional(Fields),
    },
    success: Task,
    error: RpcError,
  }),
  Rpc.make("updateTask", {
    payload: {
      id: Schema.String,
      expectedVersion: Schema.Number,
      title: Schema.optional(Schema.String),
      description: Schema.optional(Schema.NullOr(RichTextEnvelope)),
      priorityId: Schema.optional(Schema.NullOr(Schema.String)),
      labelIds: Schema.optional(Schema.Array(Schema.String)),
      dueAt: Schema.optional(Schema.NullOr(Schema.String)),
      customFields: Schema.optional(Fields),
    },
    success: Task,
    error: RpcError,
  }),
  Rpc.make("setTaskStatus", {
    payload: { id: Schema.String, expectedVersion: Schema.Number, statusId: Schema.String },
    success: Task,
    error: RpcError,
  }),
  Rpc.make("assignTask", {
    payload: {
      id: Schema.String,
      expectedVersion: Schema.Number,
      assignee: Schema.NullOr(Schema.String),
    },
    success: Task,
    error: RpcError,
  }),
  // Snooze (hide from "open" lists until `until` passes) / unsnooze (null).
  Rpc.make("snoozeTask", {
    payload: {
      id: Schema.String,
      expectedVersion: Schema.Number,
      until: Schema.NullOr(Schema.String),
    },
    success: Task,
    error: RpcError,
  }),
  // Block (optional reason + optional blocking-task pointer) / unblock (null).
  Rpc.make("setTaskBlocked", {
    payload: {
      id: Schema.String,
      expectedVersion: Schema.Number,
      blocked: Schema.NullOr(
        Schema.Struct({
          reason: Schema.optional(Schema.NullOr(Schema.String)),
          taskId: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    },
    success: Task,
    error: RpcError,
  }),
  Rpc.make("archiveTask", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Task,
    error: RpcError,
  }),
  Rpc.make("restoreTask", {
    payload: { id: Schema.String, expectedVersion: Schema.Number },
    success: Task,
    error: RpcError,
  }),
  Rpc.make("deleteTask", {
    payload: { id: Schema.String },
    success: Task,
    error: RpcError,
  }),
  // Per-item activity: union of the lineage's instance/item events + its
  // annotations' note/task/attachment events. `subjectId` = the item lineage id.
  Rpc.make("getActivity", {
    payload: { subjectId: Schema.String, limit: Schema.optional(Schema.Number) },
    success: Schema.Array(FeedItem),
    error: RpcError,
  }),
  // ── annotation layer: files ───────────────────────────────────────────────────
  // Metadata only — the bytes ride plain HTTP (multipart POST /api/items/:id/
  // attachments or /api/buckets/:id/attachments, binary GET /api/attachments/:id/
  // download). Exactly one scope: itemId (or instanceId, resolved to its lineage
  // server-side — the Files widget stores an instance ref) = one record;
  // bucketId = one widget's own files; conceptId = recent across its items;
  // none = org-wide recent, which omits files in a non-shared bucket.
  Rpc.make("listFiles", {
    payload: {
      itemId: Schema.optional(Schema.String),
      instanceId: Schema.optional(Schema.String),
      bucketId: Schema.optional(Schema.String),
      conceptId: Schema.optional(Schema.String),
      includeArchived: Schema.optional(Schema.Boolean),
      limit: Schema.optional(Schema.Number),
    },
    success: Schema.Array(Attachment),
    error: RpcError,
  }),
  Rpc.make("archiveFile", {
    payload: { id: Schema.String },
    success: Attachment,
    error: RpcError,
  }),
  Rpc.make("restoreFile", {
    payload: { id: Schema.String },
    success: Attachment,
    error: RpcError,
  }),
  // Hard delete (purge): row + blob gone, the event tombstone stays.
  Rpc.make("deleteFile", {
    payload: { id: Schema.String },
    success: Attachment,
    error: RpcError,
  }),
  // Purge a whole widget bucket — used when a Files widget or its dashboard is
  // deleted and the user chooses to discard the files. An empty/unknown bucket
  // returns []; a bucket holding another member's upload needs admin.
  Rpc.make("purgeBucket", {
    payload: { bucketId: Schema.String },
    success: Schema.Array(Attachment),
    error: RpcError,
  }),
  // Apply the widget's "Also list elsewhere" toggle to the files already in the
  // bucket — the flag is stamped per row at upload, so without this a bucket the
  // user just made private would keep listing its existing files org-wide.
  // Returns only the rows that changed ([] when already in that state).
  Rpc.make("setBucketShared", {
    payload: { bucketId: Schema.String, shared: Schema.Boolean },
    success: Schema.Array(Attachment),
    error: RpcError,
  }),
  // ── annotation layer: task statuses (admin) ───────────────────────────────────
  Rpc.make("listTaskStatuses", {
    payload: { includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(TaskStatus),
    error: RpcError,
  }),
  Rpc.make("createTaskStatus", {
    payload: {
      name: Schema.String,
      category: TaskStatusCategory,
      color: Schema.optional(Schema.NullOr(Schema.String)),
      isDefault: Schema.optional(Schema.Boolean),
    },
    success: TaskStatus,
    error: RpcError,
  }),
  Rpc.make("updateTaskStatus", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      color: Schema.optional(Schema.NullOr(Schema.String)),
      category: Schema.optional(TaskStatusCategory),
      isDefault: Schema.optional(Schema.Boolean),
    },
    success: TaskStatus,
    error: RpcError,
  }),
  Rpc.make("archiveTaskStatus", {
    payload: { id: Schema.String },
    success: TaskStatus,
    error: RpcError,
  }),
  Rpc.make("restoreTaskStatus", {
    payload: { id: Schema.String },
    success: TaskStatus,
    error: RpcError,
  }),
  Rpc.make("reorderTaskStatuses", {
    payload: {
      orders: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
    },
    success: Schema.Array(TaskStatus),
    error: RpcError,
  }),
  // ── annotation layer: task priorities (admin) ─────────────────────────────────
  Rpc.make("listTaskPriorities", {
    payload: { includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(TaskPriority),
    error: RpcError,
  }),
  Rpc.make("createTaskPriority", {
    payload: {
      name: Schema.String,
      color: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: TaskPriority,
    error: RpcError,
  }),
  Rpc.make("updateTaskPriority", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      color: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: TaskPriority,
    error: RpcError,
  }),
  Rpc.make("archiveTaskPriority", {
    payload: { id: Schema.String },
    success: TaskPriority,
    error: RpcError,
  }),
  Rpc.make("restoreTaskPriority", {
    payload: { id: Schema.String },
    success: TaskPriority,
    error: RpcError,
  }),
  Rpc.make("reorderTaskPriorities", {
    payload: {
      orders: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
    },
    success: Schema.Array(TaskPriority),
    error: RpcError,
  }),
  // ── annotation layer: custom-field definitions (admin) ─────────────────────────
  Rpc.make("listAnnotationFields", {
    payload: { annotationType: AnnotationType, includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(AnnotationField),
    error: RpcError,
  }),
  Rpc.make("addAnnotationField", {
    payload: {
      annotationType: AnnotationType,
      name: Schema.String,
      kind: FieldKind,
      config: Schema.optional(FieldConfig),
      icon: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: AnnotationField,
    error: RpcError,
  }),
  Rpc.make("updateAnnotationField", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      config: Schema.optional(FieldConfig),
      icon: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: AnnotationField,
    error: RpcError,
  }),
  Rpc.make("archiveAnnotationField", {
    payload: { id: Schema.String },
    success: AnnotationField,
    error: RpcError,
  }),
  Rpc.make("restoreAnnotationField", {
    payload: { id: Schema.String },
    success: AnnotationField,
    error: RpcError,
  }),
  Rpc.make("reorderAnnotationFields", {
    payload: {
      annotationType: AnnotationType,
      orders: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
    },
    success: Schema.Array(AnnotationField),
    error: RpcError,
  }),
  // Instance-view layout prefs: both calls target the CALLER's own row
  // (owner-only by construction — no userId in the payload).
  Rpc.make("getInstanceViewPrefs", {
    success: InstanceViewPrefs,
    error: RpcError,
  }),
  Rpc.make("updateInstanceViewPrefs", {
    payload: { body: InstanceViewPrefsBody },
    success: InstanceViewPrefs,
    error: RpcError,
  }),
  // Deactivation markers (admin-gated writes; the list is readable by any
  // member — it drives picker filtering and the directory toggle). A member
  // purge is NOT an RPC: it is DELETE /api/org/members/:userId (it must remove
  // the BetterAuth membership, which needs the raw request headers).
  Rpc.make("listDeactivatedMembers", {
    success: Schema.Array(DeactivatedMember),
    error: RpcError,
  }),
  Rpc.make("deactivateMember", {
    payload: { userId: Schema.String },
    success: DeactivatedMember,
    error: RpcError,
  }),
  Rpc.make("reactivateMember", {
    payload: { userId: Schema.String },
    success: Schema.Struct({ userId: Schema.String }),
    error: RpcError,
  }),
  // ── automations ─────────────────────────────────────────────────────────────
  // Admin-gated writes (an automation writes to everyone's records, so it is a
  // settings-level power, not a per-member one); the list is readable by any
  // member so a record's activity trail can be explained.
  Rpc.make("listAutomations", {
    payload: { includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Automation),
    error: RpcError,
  }),
  Rpc.make("getAutomation", {
    payload: { id: Schema.String },
    success: Automation,
    error: RpcError,
  }),
  Rpc.make("createAutomation", {
    payload: {
      name: Schema.String,
      trigger: AutomationTrigger,
      conditions: Schema.optional(Schema.Array(SidebarCondition)),
      match: Schema.optional(Schema.Literal("all", "any")),
      actions: Schema.Array(AutomationAction),
      enabled: Schema.optional(Schema.Boolean),
    },
    success: Automation,
    error: RpcError,
  }),
  Rpc.make("updateAutomation", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      trigger: Schema.optional(AutomationTrigger),
      conditions: Schema.optional(Schema.Array(SidebarCondition)),
      match: Schema.optional(Schema.Literal("all", "any")),
      actions: Schema.optional(Schema.Array(AutomationAction)),
      enabled: Schema.optional(Schema.Boolean),
    },
    success: Automation,
    error: RpcError,
  }),
  Rpc.make("archiveAutomation", {
    payload: { id: Schema.String },
    success: Automation,
    error: RpcError,
  }),
  Rpc.make("restoreAutomation", {
    payload: { id: Schema.String },
    success: Automation,
    error: RpcError,
  }),
  Rpc.make("deleteAutomation", {
    payload: { id: Schema.String },
    success: Schema.Struct({ id: Schema.String }),
    error: RpcError,
  }),
  Rpc.make("listAutomationRuns", {
    payload: { automationId: Schema.String, limit: Schema.optional(Schema.Number) },
    success: Schema.Array(AutomationRun),
    error: RpcError,
  }),
  /** The Test button: evaluate against recent records, write nothing. */
  Rpc.make("testAutomation", {
    payload: { id: Schema.String, limit: Schema.optional(Schema.Number) },
    success: AutomationDryRun,
    error: RpcError,
  }),
  // ── sharing ─────────────────────────────────────────────────────────────────
  /** Current grants on one resource — what the Share dialog lists. */
  Rpc.make("listGrants", {
    payload: { resourceType: AccessResourceType, resourceId: Schema.String },
    success: Schema.Array(AccessGrant),
    error: RpcError,
  }),
  /**
   * Grant access to a person or a role. Requires `share` on the resource, and never
   * grants more than the sharer holds.
   */
  Rpc.make("share", {
    payload: {
      resourceType: AccessResourceType,
      /** For a record this is the ITEM id (the lineage), so the grant survives a
       *  new version being published. */
      resourceId: Schema.String,
      /** Exactly one of these. */
      userId: Schema.optional(Schema.String),
      roleId: Schema.optional(Schema.String),
      actions: Schema.Array(AccessActionName),
    },
    success: AccessGrant,
    error: RpcError,
  }),
  /** Revoke a grant. Any holder of `share` may revoke, not only the granter. */
  Rpc.make("revoke", {
    payload: { grantId: Schema.String },
    success: Schema.Struct({ id: Schema.String }),
    error: RpcError,
  }),
  // ── roles ───────────────────────────────────────────────────────────────────
  /** Every role in the org. Readable by ANY member: role names are org vocabulary
   *  (they show as pills on /members and populate the Share dialog). The RULES
   *  inside a role need `configure` — see `listRules`. */
  Rpc.make("listRoles", { success: Schema.Array(AccessRole), error: RpcError }),
  /** Which roles a member holds. Readable by any member (the pills). */
  Rpc.make("rolesOf", {
    payload: { userId: Schema.String },
    success: Schema.Array(AccessRole),
    error: RpcError,
  }),
  /** The rules a role carries. `configure` — this is the sensitive half. */
  Rpc.make("listRules", {
    payload: { roleId: Schema.String },
    success: Schema.Array(AccessRule),
    error: RpcError,
  }),
  Rpc.make("createRole", {
    payload: {
      name: Schema.String,
      description: Schema.optional(Schema.String),
      /** Copy this role's rules and templates as a starting point. A SNAPSHOT — later
       *  changes to the source do not propagate. */
      startFrom: Schema.optional(Schema.String),
    },
    success: AccessRole,
    error: RpcError,
  }),
  Rpc.make("updateRole", {
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: AccessRole,
    error: RpcError,
  }),
  /** Delete a custom role. A preset is refused (the seed would re-create it). */
  Rpc.make("deleteRole", {
    payload: { id: Schema.String },
    success: Schema.Struct({ id: Schema.String }),
    error: RpcError,
  }),
  Rpc.make("assignRole", {
    payload: { roleId: Schema.String, userId: Schema.String },
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }),
  Rpc.make("unassignRole", {
    payload: { roleId: Schema.String, userId: Schema.String },
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }),
  Rpc.make("addRule", {
    payload: {
      roleId: Schema.String,
      effect: Schema.Literal("allow", "deny"),
      actions: Schema.Array(AccessActionName),
      resourceType: AccessResourceType,
      resourceId: Schema.optional(Schema.NullOr(Schema.String)),
      conceptId: Schema.optional(Schema.NullOr(Schema.String)),
      condition: Schema.optional(Schema.NullOr(AccessCondition)),
    },
    success: Schema.Struct({ id: Schema.String }),
    error: RpcError,
  }),
  /** Replace a rule in place — it keeps its id, so the audit trail stays one subject. */
  Rpc.make("updateRule", {
    payload: {
      ruleId: Schema.String,
      effect: Schema.Literal("allow", "deny"),
      actions: Schema.Array(AccessActionName),
      resourceType: AccessResourceType,
      resourceId: Schema.optional(Schema.NullOr(Schema.String)),
      conceptId: Schema.optional(Schema.NullOr(Schema.String)),
      condition: Schema.optional(Schema.NullOr(AccessCondition)),
    },
    success: Schema.Struct({ id: Schema.String }),
    error: RpcError,
  }),
  /** Replace every targeted rule of one resource type on a role — what the
   *  permissions matrix writes. Blanket rules are untouched. */
  Rpc.make("setScopedRules", {
    payload: {
      roleId: Schema.String,
      resourceType: AccessResourceType,
      /** "concept" scopes by CONTAINER — the Records grid, whose rows are concepts. */
      scopeBy: Schema.optional(Schema.Literal("resource", "concept")),
      entries: Schema.Array(
        Schema.Struct({
          resourceId: Schema.String,
          allow: Schema.Array(AccessActionName),
          deny: Schema.Array(AccessActionName),
        }),
      ),
    },
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }),
  Rpc.make("removeRule", {
    payload: { ruleId: Schema.String },
    success: Schema.Struct({ id: Schema.String }),
    error: RpcError,
  }),
  /** THE CREATION TEMPLATE: what a NEWLY created resource of each type grants each
   *  role. Not a rule — nothing consults it at request time; it is copied into real
   *  rules when a concept/dashboard/view/automation is created. */
  Rpc.make("listAccessDefaults", {
    success: Schema.Array(
      Schema.Struct({
        roleId: Schema.String,
        resourceType: AccessResourceTypeOut,
        actions: Schema.Array(Schema.String),
      }),
    ),
    error: RpcError,
  }),
  /** Set one role's template for one type. Empty `actions` clears it — a new
   *  resource then grants that role nothing. */
  Rpc.make("setAccessDefault", {
    payload: {
      roleId: Schema.String,
      resourceType: AccessResourceType,
      actions: Schema.Array(AccessActionName),
    },
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }),
  /** "What can this member see and do, and what grants it?" Anyone may ask about
   *  THEMSELVES (the self-serve answer to "why can't I see this?"); asking about
   *  someone else needs `configure`. */
  Rpc.make("effectiveAccess", {
    payload: { userId: Schema.optional(Schema.String) },
    success: EffectiveAccess,
    error: RpcError,
  }),
) {}
