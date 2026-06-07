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

export const Attachment = Schema.Struct({
  id: Schema.String,
  instanceId: Schema.String,
  filename: Schema.String,
  mimeType: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Number),
  createdAt: Schema.Date,
})
export type Attachment = typeof Attachment.Type

const ArtifactWithFiles = Schema.Struct({
  ...InstanceFields,
  attachments: Schema.Array(Attachment),
})

export const AccountHub = Schema.Struct({
  account: Instance,
  contacts: Schema.Array(Instance),
  owners: Schema.Array(Instance),
  interactions: Schema.Array(Instance),
  signals: Schema.Array(Instance),
  tasks: Schema.Array(Instance),
  deals: Schema.Array(Instance),
  artifacts: Schema.Array(ArtifactWithFiles),
})
export type AccountHub = typeof AccountHub.Type

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
  Rpc.make("listInstances", {
    payload: { conceptName: Schema.String },
    success: Schema.Array(Instance),
    error: RpcError,
  }),
  Rpc.make("getAccountHub", {
    payload: { accountId: Schema.String },
    success: AccountHub,
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
  Rpc.make("createContact", {
    payload: { accountId: Schema.String, fields: Fields },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("createDeal", {
    payload: { accountId: Schema.String, fields: Fields },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("logSignal", {
    payload: { accountId: Schema.String, fields: Fields },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("createTask", {
    payload: { accountId: Schema.String, fields: Fields },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("logInteraction", {
    payload: {
      accountId: Schema.String,
      fields: Fields,
      contactId: Schema.optional(Schema.String),
    },
    success: Instance,
    error: RpcError,
  }),
  Rpc.make("createArtifact", {
    payload: { accountId: Schema.String, fields: Fields },
    success: Instance,
    error: RpcError,
  }),
) {}
