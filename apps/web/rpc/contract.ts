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
  /** Label ids inherited by every instance (static); and snapshotted onto new
   *  instances (default). Both drawn from the org-wide label vocabulary. */
  staticLabelIds: Schema.Array(Schema.String),
  defaultLabelIds: Schema.Array(Schema.String),
  /** Opt-in per-concept versioning (draft→published versions + pinned references). */
  versioningEnabled: Schema.Boolean,
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
  /** Display glyph: literal emoji or `lucide:Name` (see `Concept.icon`). */
  icon: Schema.NullOr(Schema.String),
  /** Display order within the concept (ascending); ties broken by name. */
  position: Schema.Number,
  /** Archive marker: non-null = archived (hidden from the live list, restorable). */
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Field = typeof Field.Type

export const Attachment = Schema.Struct({
  id: Schema.String,
  instanceId: Schema.String,
  filename: Schema.String,
  mimeType: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Number),
  createdAt: Schema.Date,
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

// ── sidebar views (configurable nav layouts) ───────────────────────────────────
// A View is an ordered stack of sections, switched via the sidebar pager. The
// whole layout is `SidebarViewBody` and is resolved CLIENT-SIDE against the live
// concept/instance collections — the server only persists/serves the document.

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
  ),
  value: Schema.Unknown,
})
export type SidebarCondition = typeof SidebarCondition.Type

/** How a condition set combines: every condition or at least one (absent = all). */
const ConditionMatch = { match: Schema.optional(Schema.Literal("all", "any")) }

/** A manually-pinned group member — a concept link or a single instance. */
export const SidebarMember = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("concept"), conceptId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("instance"),
    conceptId: Schema.String,
    instanceId: Schema.String,
  }),
)

/** An auto-membership rule: matching concepts, or matching instances of a concept. */
export const SidebarRule = Schema.Union(
  Schema.Struct({
    target: Schema.Literal("concepts"),
    conditions: Schema.Array(SidebarCondition),
    ...ConditionMatch,
  }),
  Schema.Struct({
    target: Schema.Literal("items"),
    conceptId: Schema.String,
    conditions: Schema.Array(SidebarCondition),
    ...ConditionMatch,
  }),
)

const SidebarStaticItem = Schema.Literal(
  "overview",
  "dashboards",
  "members",
  "automations",
  "settings",
)

const SidebarLink = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  /** `/instances/:id`, a concept route, or an external URL. */
  to: Schema.String,
})

export const SidebarSource = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("static"), items: Schema.Array(SidebarStaticItem) }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    members: Schema.Array(SidebarMember),
    rules: Schema.Array(SidebarRule),
  }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    conceptId: Schema.String,
    conditions: Schema.Array(SidebarCondition),
    ...ConditionMatch,
    orderBy: Schema.optional(Schema.NullOr(Schema.String)),
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
  Schema.Struct({ kind: Schema.Literal("links"), items: Schema.Array(SidebarLink) }),
)
export type SidebarMember = typeof SidebarMember.Type
export type SidebarRule = typeof SidebarRule.Type
export type SidebarSource = typeof SidebarSource.Type

export const SidebarSection = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  collapsed: Schema.optional(Schema.Boolean),
  source: SidebarSource,
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

/** A widget's placement on the grid canvas (react-grid-layout coords). */
const WidgetLayout = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
})

/** Fields shared by every widget. */
const widgetBase = {
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  layout: WidgetLayout,
}
/** `conceptId` is optional on every concept-scoped widget so the same body can
 *  render in per-concept context (implicit conceptId) later. */
const ConceptScoped = { conceptId: Schema.optional(Schema.NullOr(Schema.String)) }

const MetricWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("metric"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  agg: Schema.Literal("count", "sum", "avg"),
  field: Schema.optional(Schema.NullOr(Schema.String)),
})
const ListWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("list"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  orderBy: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  columns: Schema.optional(Schema.Array(Schema.String)),
})
const BreakdownWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("breakdown"),
  conditions: Schema.Array(SidebarCondition),
  ...ConditionMatch,
  groupBy: Schema.String,
  chart: Schema.Literal("bar", "pie"),
})
const AttentionWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("attention"),
  computedField: Schema.optional(Schema.NullOr(Schema.String)),
  bands: Schema.optional(Schema.Array(Schema.Literal("cooling", "cold", "heating", "steady"))),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
})
const TrendWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("trend"),
  eventTypes: Schema.optional(Schema.Array(Schema.String)),
  bucket: Schema.Literal("day", "week"),
  since: Schema.Literal("7d", "30d", "90d"),
})
const ActivityWidget = Schema.Struct({
  ...widgetBase,
  ...ConceptScoped,
  type: Schema.Literal("activity"),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
})

export const DashboardWidget = Schema.Union(
  MetricWidget,
  ListWidget,
  BreakdownWidget,
  AttentionWidget,
  TrendWidget,
  ActivityWidget,
)
export type DashboardWidget = typeof DashboardWidget.Type

export const DashboardBody = Schema.Struct({
  widgets: Schema.Array(DashboardWidget),
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

export const TaskStatusCategory = Schema.Literal("todo", "active", "done")
export type TaskStatusCategory = typeof TaskStatusCategory.Type

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
  statusId: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.String),
  /** ISO date string or null. */
  dueAt: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  customFields: State,
  version: Schema.Number,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  archivedAt: Schema.NullOr(Schema.Date),
})
export type Task = typeof Task.Type

// ── member pages + deactivation ─────────────────────────────────────────────────
// A member's profile page is a widget canvas with the SAME body document as
// dashboards, but a fixed scope: one page per (org, user), the owner edits,
// every org member reads. Deactivation is the member analogue of archive — a
// restorable marker that blocks org access and hides the user from pickers.

export const MemberPage = Schema.Struct({
  userId: Schema.String,
  body: DashboardBody,
})
export type MemberPage = typeof MemberPage.Type

// A member's instance-detail layout prefs: which preset view to render, as a
// global default plus per-concept overrides keyed by concept id. View keys
// name client-defined presets (resolved client-side; unknown keys fall back).
// A concept override may also be "custom", backed by a user-edited tile
// layout in `customByConcept` — same grid coords as presets; content keys are
// opaque strings here (the client drops ones it doesn't know).
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

/** One serializable error for the whole API; `code` mirrors the old HTTP codes. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

const Fields = Schema.Record({ key: Schema.String, value: Schema.Unknown })

// ── procedures ────────────────────────────────────────────────────────────────

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
    payload: { name: Schema.String, color: Schema.optional(Schema.NullOr(Schema.String)) },
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
      staticLabelIds: Schema.optional(Schema.Array(Schema.String)),
      defaultLabelIds: Schema.optional(Schema.Array(Schema.String)),
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
  Rpc.make("listDashboards", { success: Schema.Array(Dashboard), error: RpcError }),
  Rpc.make("createDashboard", {
    payload: {
      name: Schema.String,
      icon: Schema.optional(Schema.NullOr(Schema.String)),
      scope: Schema.Literal("personal", "org"),
      body: DashboardBody,
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
  Rpc.make("createTask", {
    payload: {
      subjectId: Schema.NullOr(Schema.String),
      title: Schema.String,
      statusId: Schema.optional(Schema.NullOr(Schema.String)),
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
  // annotations' note/task events. `subjectId` = the item lineage id.
  Rpc.make("getActivity", {
    payload: { subjectId: Schema.String, limit: Schema.optional(Schema.Number) },
    success: Schema.Array(FeedItem),
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
  // Member pages: any member reads any page; a write always targets the
  // CALLER's own page (owner-only by construction — no userId in the payload).
  Rpc.make("getMemberPage", {
    payload: { userId: Schema.String },
    success: MemberPage,
    error: RpcError,
  }),
  Rpc.make("updateMemberPage", {
    payload: { body: DashboardBody },
    success: MemberPage,
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
) {}
