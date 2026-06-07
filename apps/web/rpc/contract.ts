import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

/**
 * The Kingsmaker RPC contract — the single typed source of truth shared by the
 * server (handlers) and the browser client. Imports ONLY effect + @effect/rpc,
 * so it is safe to bundle into the client (no engine / node deps).
 */

// ── wire schemas ──────────────────────────────────────────────────────────────

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
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
})
export type Concept = typeof Concept.Type

export const FieldKind = Schema.Literal(
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "relation",
  "file",
  "computed",
)
export type FieldKind = typeof FieldKind.Type

/** Mirrors the engine's `FieldConfig` (kept here so the contract stays engine-free). */
export const FieldConfig = Schema.Struct({
  options: Schema.optional(Schema.Array(Schema.String)),
  transitions: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  ),
  relationType: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  cardinality: Schema.optional(Schema.Literal("one", "many")),
  computedKind: Schema.optional(Schema.Literal("decay", "momentum")),
  params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})
export type FieldConfig = typeof FieldConfig.Type

export const Field = Schema.Struct({
  id: Schema.String,
  conceptId: Schema.String,
  name: Schema.String,
  kind: FieldKind,
  formula: Schema.NullOr(Schema.String),
  config: FieldConfig,
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

export const Owed = Schema.Struct({
  openTasks: Schema.Array(Instance),
  decayingDeals: Schema.Array(Instance),
  dueRenewals: Schema.Array(Instance),
})
export type Owed = typeof Owed.Type

export const FeedItem = Schema.Struct({
  id: Schema.Number,
  occurredAt: Schema.Date,
  actor: Schema.NullOr(Schema.String),
  eventType: Schema.String,
  subjectKind: Schema.String,
  subjectId: Schema.String,
})
export type FeedItem = typeof FeedItem.Type

export const DemandItem = Schema.Struct({
  signal: Instance,
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  weight: Schema.Number,
})
export type DemandItem = typeof DemandItem.Type

/** One serializable error for the whole API; `code` mirrors the old HTTP codes. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

const Fields = Schema.Record({ key: Schema.String, value: Schema.Unknown })

// ── procedures ────────────────────────────────────────────────────────────────

export class KingsmakerRpcs extends RpcGroup.make(
  Rpc.make("listConcepts", { success: Schema.Array(Concept), error: RpcError }),
  Rpc.make("createConcept", {
    payload: { name: Schema.String },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("updateConcept", {
    payload: { id: Schema.String, description: Schema.NullOr(Schema.String) },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("deleteConcept", {
    payload: { id: Schema.String },
    success: Concept,
    error: RpcError,
  }),
  Rpc.make("listFields", {
    payload: { conceptId: Schema.String },
    success: Schema.Array(Field),
    error: RpcError,
  }),
  Rpc.make("addField", {
    payload: {
      conceptId: Schema.String,
      name: Schema.String,
      kind: FieldKind,
      config: Schema.optional(FieldConfig),
      formula: Schema.optional(Schema.String),
    },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("updateField", {
    payload: {
      id: Schema.String,
      config: Schema.optional(FieldConfig),
      formula: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("deleteField", {
    payload: { id: Schema.String },
    success: Field,
    error: RpcError,
  }),
  Rpc.make("listInstances", {
    payload: { conceptName: Schema.String },
    success: Schema.Array(Instance),
    error: RpcError,
  }),
  Rpc.make("getOwed", { success: Owed, error: RpcError }),
  Rpc.make("getChanged", { success: Schema.Array(FeedItem), error: RpcError }),
  Rpc.make("getDemand", { success: Schema.Array(DemandItem), error: RpcError }),
  Rpc.make("createInstance", {
    payload: { conceptName: Schema.String, fields: Fields },
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
) {}
