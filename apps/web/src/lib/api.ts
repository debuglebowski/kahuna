import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { type FieldConfig, type FieldKind, KingsmakerRpcs } from "../../rpc/contract"

export type {
  Attachment,
  Concept,
  DemandItem,
  FeedItem,
  Field,
  FieldConfig,
  FieldKind,
  Instance,
  Owed,
} from "../../rpc/contract"

/** Computed-field shapes (carried inside an instance's `state`). */
export interface DecayValue {
  readonly days: number | null
  readonly band: "fresh" | "warm" | "cooling" | "cold"
}
export interface MomentumValue {
  readonly label: "heating" | "steady" | "cooling"
  readonly recent: number
  readonly prior: number
}

// Build the RPC client once: fetch transport + ndjson, pointed at /api/rpc.
const ProtocolLive = RpcClient.layerProtocolHttp({ url: "/api/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
)

const makeClient = RpcClient.make(KingsmakerRpcs)
type Client = Effect.Effect.Success<typeof makeClient>

class ApiClient extends Context.Tag("kingsmaker/ApiClient")<ApiClient, Client>() {}

const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)

const call = <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(ApiClient, f))

type Fields = Record<string, unknown>

/** Typed, end-to-end client — replaces the old hand-written fetch wrappers. */
export const api = {
  listConcepts: () => call((c) => c.listConcepts()),
  createConcept: (name: string) => call((c) => c.createConcept({ name })),
  updateConcept: (id: string, description: string | null) =>
    call((c) => c.updateConcept({ id, description })),
  deleteConcept: (id: string) => call((c) => c.deleteConcept({ id })),
  listFields: (conceptId: string) => call((c) => c.listFields({ conceptId })),
  addField: (input: {
    conceptId: string
    name: string
    kind: FieldKind
    config?: FieldConfig
    formula?: string
  }) => call((c) => c.addField(input)),
  updateField: (input: { id: string; config?: FieldConfig; formula?: string | null }) =>
    call((c) => c.updateField(input)),
  deleteField: (id: string) => call((c) => c.deleteField({ id })),
  listInstances: (conceptName: string) => call((c) => c.listInstances({ conceptName })),
  getOwed: () => call((c) => c.getOwed()),
  getChanged: () => call((c) => c.getChanged()),
  getDemand: () => call((c) => c.getDemand()),
  createInstance: (conceptName: string, fields: Fields) =>
    call((c) => c.createInstance({ conceptName, fields })),
  updateInstance: (id: string, expectedVersion: number, patch: Fields) =>
    call((c) => c.updateInstance({ id, expectedVersion, patch })),
  transitionInstance: (id: string, expectedVersion: number, field: string, to: string) =>
    call((c) => c.transitionInstance({ id, expectedVersion, field, to })),
}
