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

const InstanceFields = {
  id: Schema.String,
  conceptId: Schema.String,
  state: State,
  version: Schema.Number,
  createdAt: Schema.Date,
  deletedAt: Schema.NullOr(Schema.Date),
}
export const Instance = Schema.Struct(InstanceFields)
export type Instance = typeof Instance.Type

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
  /** Label ids inherited by every instance (static); and snapshotted onto new
   *  instances (default). Both drawn from the org-wide label vocabulary. */
  staticLabelIds: Schema.Array(Schema.String),
  defaultLabelIds: Schema.Array(Schema.String),
  /** Archive marker: non-null = archived (hidden from the live list, restorable). */
  deletedAt: Schema.NullOr(Schema.Date),
})
export type Concept = typeof Concept.Type

/** A label in the org-wide, flat vocabulary. */
export const Label = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  /** A plain flag for now (rendered with a crown); future features key off it. */
  primary: Schema.Boolean,
  deletedAt: Schema.NullOr(Schema.Date),
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
)
export type FieldKind = typeof FieldKind.Type

/** Mirrors the engine's `FieldConfig` (kept here so the contract stays engine-free). */
export const FieldConfig = Schema.Struct({
  options: Schema.optional(Schema.Array(Schema.String)),
  transitions: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  ),
  /** relation: the target concept's id (the relation's identity is the field id). */
  target: Schema.optional(Schema.String),
  cardinality: Schema.optional(Schema.Literal("one", "many")),
  computedKind: Schema.optional(Schema.Literal("decay", "momentum")),
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  /** any scalar kind: store/validate a list of values. */
  multiple: Schema.optional(Schema.Boolean),
  /** text/number: an extra format constraint. */
  format: Schema.optional(Schema.String),
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
  /** Archive marker: non-null = archived (hidden from the live list, restorable). */
  deletedAt: Schema.NullOr(Schema.Date),
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
})
export type FeedItem = typeof FeedItem.Type

/** One instance connected to another via a relation, with its concept resolved. */
export const RelatedInstance = Schema.Struct({
  relationId: Schema.String,
  /** The relation field def this edge realises (identity); name is decorative. */
  fieldId: Schema.String,
  relationName: Schema.String,
  /** Server-resolved display label of the connected instance (its state is keyed
   *  by field id, which the client can't resolve without that concept's fields). */
  label: Schema.String,
  /** `out` = this instance is the relation's `from`; `in` = it is the `to`. */
  direction: Schema.Literal("out", "in"),
  conceptId: Schema.String,
  conceptName: Schema.String,
  instance: Instance,
})
export type RelatedInstance = typeof RelatedInstance.Type

/** A single instance plus everything needed to render its detail view. */
export const InstanceDetail = Schema.Struct({
  instance: Instance,
  concept: Concept,
  fields: Schema.Array(Field),
  related: Schema.Array(RelatedInstance),
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

// ── sidebar views (configurable nav layouts) ───────────────────────────────────
// A View is an ordered stack of sections, switched via the sidebar pager. The
// whole layout is `SidebarViewBody` and is resolved CLIENT-SIDE against the live
// concept/instance collections — the server only persists/serves the document.

/** One filter condition. `field` = a field id, or `__labels` for `hasLabel`. */
export const SidebarCondition = Schema.Struct({
  field: Schema.String,
  op: Schema.Literal("eq", "hasLabel"),
  value: Schema.Unknown,
})
export type SidebarCondition = typeof SidebarCondition.Type

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
  Schema.Struct({ target: Schema.Literal("concepts"), conditions: Schema.Array(SidebarCondition) }),
  Schema.Struct({
    target: Schema.Literal("items"),
    conceptId: Schema.String,
    conditions: Schema.Array(SidebarCondition),
  }),
)

const SidebarStaticItem = Schema.Literal("overview", "dashboards", "automations", "settings")

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
    payload: { includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Concept),
    error: RpcError,
  }),
  Rpc.make("createConcept", {
    payload: { name: Schema.String },
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
) {}
