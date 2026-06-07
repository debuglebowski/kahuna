import { Etag, FileSystem, HttpPlatform, Path } from "@effect/platform"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import { type EngineServices, OrgContext, type OrgScope } from "@kingsmaker/engine"
import { Effect, Layer } from "effect"
import {
  type AccountHub,
  type Concept,
  type DemandItem,
  KingsmakerRpcs,
  type Owed,
  RpcError,
} from "../rpc/contract"
import { auth } from "./auth"
import { EngineBase, ERROR_MAP } from "./runtime"
import { roleOf } from "./session"
import * as uc from "./use-cases"

/**
 * Per-request auth: derive OrgContext (org_id + actor) from the session cookie
 * in the request headers. Provided to every handler; fails the RPC otherwise.
 */
export class AuthMiddleware extends RpcMiddleware.Tag<AuthMiddleware>()(
  "kingsmaker/AuthMiddleware",
  {
    provides: OrgContext,
    failure: RpcError,
  },
) {}

const AuthMiddlewareLive = Layer.succeed(AuthMiddleware, (options) =>
  Effect.gen(function* () {
    const headers = new Headers(options.headers as Record<string, string>)
    const session = yield* Effect.tryPromise({
      try: () => auth.api.getSession({ headers }),
      catch: () =>
        new RpcError({ code: "INTERNAL", message: "session lookup failed", status: 500 }),
    })
    if (!session?.user) {
      return yield* Effect.fail(
        new RpcError({ code: "UNAUTHENTICATED", message: "Not signed in", status: 401 }),
      )
    }
    const orgId = session.session.activeOrganizationId
    if (!orgId) {
      return yield* Effect.fail(
        new RpcError({ code: "NO_ACTIVE_ORG", message: "No active org", status: 409 }),
      )
    }
    const role = yield* Effect.tryPromise({
      try: () => roleOf(session.user.id, orgId),
      catch: () => new RpcError({ code: "INTERNAL", message: "role lookup failed", status: 500 }),
    })
    if (!role) {
      return yield* Effect.fail(
        new RpcError({ code: "NOT_A_MEMBER", message: "Not a member", status: 403 }),
      )
    }
    return { orgId, actor: session.user.id } satisfies OrgScope
  }),
)

/** Map any engine failure to the single serializable RpcError (mirrors HTTP codes). */
const toRpcError = (e: unknown): RpcError => {
  const tag = typeof e === "object" && e !== null ? (e as { _tag?: string })._tag : undefined
  const mapped = tag ? ERROR_MAP[tag] : undefined
  return mapped
    ? new RpcError({ code: mapped.code, message: tag ?? "error", status: mapped.status })
    : new RpcError({ code: "INTERNAL", message: "Internal error", status: 500 })
}

const mapErr = <A, E>(eff: Effect.Effect<A, E, OrgContext | EngineServices>) =>
  eff.pipe(Effect.catchAll((e) => Effect.fail(toRpcError(e))))

// Casting helper for the loosely-typed (UC<unknown>) use-cases — runtime values
// already match the wire schema; this just informs the handler's return type.
const as = <A>(eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
  mapErr(eff) as Effect.Effect<A, RpcError, OrgContext | EngineServices>

const ServerRpcs = KingsmakerRpcs.middleware(AuthMiddleware)

const HandlersLive = ServerRpcs.toLayer({
  listConcepts: () => as<ReadonlyArray<Concept>>(uc.listConcepts),
  createConcept: ({ name }) => as<Concept>(uc.createConcept(name)),
  listInstances: ({ conceptName }) => mapErr(uc.listInstances(conceptName, { decorate: true })),
  getAccountHub: ({ accountId }) => as<AccountHub>(uc.getAccountHub(accountId)),
  getOwed: () => as<Owed>(uc.getOwed),
  getChanged: () => mapErr(uc.getChanged),
  getDemand: () => as<ReadonlyArray<DemandItem>>(uc.getDemand),
  createInstance: ({ conceptName, fields }) => mapErr(uc.createInstance(conceptName, fields)),
  updateInstance: ({ id, expectedVersion, patch }) =>
    mapErr(uc.updateInstance(id, expectedVersion, patch)),
  transitionInstance: ({ id, expectedVersion, field, to }) =>
    mapErr(uc.transitionInstance(id, expectedVersion, field, to)),
  createContact: ({ accountId, fields }) => mapErr(uc.createContact(accountId, fields)),
  createDeal: ({ accountId, fields }) => mapErr(uc.createDeal(accountId, fields)),
  logSignal: ({ accountId, fields }) => mapErr(uc.logSignal(accountId, fields)),
  createTask: ({ accountId, fields }) => mapErr(uc.createTask(accountId, fields)),
  logInteraction: ({ accountId, fields, contactId }) =>
    mapErr(uc.logInteraction(accountId, fields, contactId)),
  createArtifact: ({ accountId, fields }) => mapErr(uc.createArtifact(accountId, fields)),
}).pipe(Layer.provide(EngineBase))

// HttpRouter.DefaultServices (HttpPlatform | Etag | FileSystem | Path) — pure
// layers (no-op FileSystem) since the RPC handler never touches the filesystem.
const HttpServices = Layer.mergeAll(HttpPlatform.layer, Etag.layerWeak, Path.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
)

const ServerLayer = Layer.mergeAll(
  HandlersLive,
  AuthMiddlewareLive,
  RpcSerialization.layerNdjson,
  HttpServices,
)

/** A `(Request) => Promise<Response>` for the RPC endpoint, mounted in Bun.serve. */
export const { handler: rpcHandler } = RpcServer.toWebHandler(ServerRpcs, { layer: ServerLayer })
