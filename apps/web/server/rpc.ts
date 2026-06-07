import { Etag, FileSystem, HttpPlatform, Path } from "@effect/platform"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import { type EngineServices, OrgContext, type OrgScope } from "@kingsmaker/engine"
import { Effect, Layer } from "effect"
import {
  type Concept,
  type DemandItem,
  type Field,
  KingsmakerRpcs,
  type Owed,
  RpcError,
} from "../rpc/contract"
import { auth } from "./auth"
import { can } from "./policy"
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

/**
 * Admin gate for schema-mutating RPCs (concept configuration). Reuses the
 * OrgContext already provided by AuthMiddleware plus the BetterAuth member role
 * — one indexed lookup, only on the handlers that need it.
 */
const requireAdmin: Effect.Effect<void, RpcError, OrgContext> = Effect.gen(function* () {
  const { orgId, actor } = yield* OrgContext
  const role = yield* Effect.tryPromise({
    try: () => roleOf(actor, orgId),
    catch: () => new RpcError({ code: "INTERNAL", message: "role lookup failed", status: 500 }),
  })
  if (!role || !can(role, "admin")) {
    return yield* Effect.fail(
      new RpcError({ code: "FORBIDDEN", message: "Admin only", status: 403 }),
    )
  }
})

/** Run an admin-only use-case behind the gate, mapping engine errors. */
const admin = <A>(eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
  requireAdmin.pipe(Effect.zipRight(as<A>(eff)))

// Casting helper for the loosely-typed (UC<unknown>) use-cases — runtime values
// already match the wire schema; this just informs the handler's return type.
const as = <A>(eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
  mapErr(eff) as Effect.Effect<A, RpcError, OrgContext | EngineServices>

const ServerRpcs = KingsmakerRpcs.middleware(AuthMiddleware)

const HandlersLive = ServerRpcs.toLayer({
  listConcepts: () => as<ReadonlyArray<Concept>>(uc.listConcepts),
  createConcept: ({ name }) => as<Concept>(uc.createConcept(name)),
  updateConcept: ({ id, name, description }) =>
    admin<Concept>(uc.updateConcept(id, { name, description })),
  deleteConcept: ({ id }) => admin<Concept>(uc.deleteConcept(id)),
  listFields: ({ conceptId }) => as<ReadonlyArray<Field>>(uc.listFields(conceptId)),
  addField: ({ conceptId, name, kind, config, formula }) =>
    admin<Field>(uc.addField({ conceptId, name, kind, config, formula })),
  updateField: ({ id, config, formula }) => admin<Field>(uc.updateField({ id, config, formula })),
  deleteField: ({ id }) => admin<Field>(uc.deleteField(id)),
  listInstances: ({ conceptId }) => mapErr(uc.listInstances(conceptId, { decorate: true })),
  getOwed: () => as<Owed>(uc.getOwed),
  getChanged: () => mapErr(uc.getChanged),
  getDemand: () => as<ReadonlyArray<DemandItem>>(uc.getDemand),
  createInstance: ({ conceptId, fields }) => mapErr(uc.createInstance(conceptId, fields)),
  updateInstance: ({ id, expectedVersion, patch }) =>
    mapErr(uc.updateInstance(id, expectedVersion, patch)),
  transitionInstance: ({ id, expectedVersion, field, to }) =>
    mapErr(uc.transitionInstance(id, expectedVersion, field, to)),
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
