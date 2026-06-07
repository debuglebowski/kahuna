import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../../rpc/contract"

export type {
  AccountHub,
  Attachment,
  Concept,
  DemandItem,
  FeedItem,
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
  listInstances: (conceptName: string) => call((c) => c.listInstances({ conceptName })),
  getAccountHub: (accountId: string) => call((c) => c.getAccountHub({ accountId })),
  getOwed: () => call((c) => c.getOwed()),
  getChanged: () => call((c) => c.getChanged()),
  getDemand: () => call((c) => c.getDemand()),
  createInstance: (conceptName: string, fields: Fields) =>
    call((c) => c.createInstance({ conceptName, fields })),
  updateInstance: (id: string, expectedVersion: number, patch: Fields) =>
    call((c) => c.updateInstance({ id, expectedVersion, patch })),
  transitionInstance: (id: string, expectedVersion: number, field: string, to: string) =>
    call((c) => c.transitionInstance({ id, expectedVersion, field, to })),
  createContact: (accountId: string, fields: Fields) =>
    call((c) => c.createContact({ accountId, fields })),
  createDeal: (accountId: string, fields: Fields) =>
    call((c) => c.createDeal({ accountId, fields })),
  logSignal: (accountId: string, fields: Fields) => call((c) => c.logSignal({ accountId, fields })),
  createTask: (accountId: string, fields: Fields) =>
    call((c) => c.createTask({ accountId, fields })),
  logInteraction: (accountId: string, fields: Fields, contactId?: string) =>
    call((c) => c.logInteraction({ accountId, fields, contactId })),
  createArtifact: (accountId: string, fields: Fields) =>
    call((c) => c.createArtifact({ accountId, fields })),
}
