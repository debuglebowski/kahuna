import { Etag, FileSystem, HttpPlatform, Path } from "@effect/platform"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import { type EngineServices, OrgContext, type OrgScope } from "@kingsmaker/engine"
import { Effect, Layer } from "effect"
import {
  type Concept,
  type ConceptGraph,
  type Field,
  type InstanceDetail,
  KingsmakerRpcs,
  RpcError,
} from "../rpc/contract"
import { auth } from "./auth"
import { pool } from "./db"
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

/**
 * Enforce that every `user`-kind field value is a real member of the org. The
 * engine treats a user id as an opaque logical FK (like org_id / actor) and never
 * touches the auth tables, so membership — an auth-tier concern — is validated
 * here against `bauth_member` via the shared pool (the same way auth.ts reaches
 * engine tables). Throws RpcError(422) listing any non-members.
 */
async function assertMembers(
  orgId: string,
  conceptId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const defs = await pool.query<{ id: string }>(
    "SELECT id FROM fields WHERE org_id = $1 AND concept_id = $2 AND kind = 'user' AND deleted_at IS NULL",
    [orgId, conceptId],
  )
  if (defs.rows.length === 0) return
  const ids = new Set<string>()
  for (const { id } of defs.rows) {
    const v = values[id]
    if (Array.isArray(v)) {
      for (const x of v) if (typeof x === "string") ids.add(x)
    } else if (typeof v === "string") {
      ids.add(v)
    }
  }
  if (ids.size === 0) return
  const members = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM bauth_member WHERE organization_id = $1",
    [orgId],
  )
  const present = new Set(members.rows.map((r) => r.user_id))
  const missing = [...ids].filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new RpcError({
      code: "VALIDATION",
      message: `not org members: ${missing.join(", ")}`,
      status: 422,
    })
  }
}

/** Resolve an instance's concept, then run the member check against the patch. */
async function assertMembersForInstance(
  orgId: string,
  instanceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const r = await pool.query<{ concept_id: string }>(
    "SELECT concept_id FROM instances WHERE id = $1 AND org_id = $2 LIMIT 1",
    [instanceId, orgId],
  )
  const conceptId = r.rows[0]?.concept_id
  if (conceptId) await assertMembers(orgId, conceptId, patch)
}

/** Run a member pre-check (resolved against the request's org), then the use-case. */
const checkThen = <A>(
  precheck: (orgId: string) => Promise<void>,
  run: Effect.Effect<A, unknown, OrgContext | EngineServices>,
): Effect.Effect<A, RpcError, OrgContext | EngineServices> =>
  Effect.gen(function* () {
    const { orgId } = yield* OrgContext
    yield* Effect.tryPromise({
      try: () => precheck(orgId),
      catch: (e) =>
        e instanceof RpcError
          ? e
          : new RpcError({ code: "INTERNAL", message: "membership check failed", status: 500 }),
    })
    return yield* mapErr(run)
  })

const ServerRpcs = KingsmakerRpcs.middleware(AuthMiddleware)

const HandlersLive = ServerRpcs.toLayer({
  listConcepts: () => as<ReadonlyArray<Concept>>(uc.listConcepts),
  createConcept: ({ name }) => as<Concept>(uc.createConcept(name)),
  updateConcept: ({ id, name, description }) =>
    admin<Concept>(uc.updateConcept(id, { name, description })),
  deleteConcept: ({ id }) => admin<Concept>(uc.deleteConcept(id)),
  listFields: ({ conceptId }) => as<ReadonlyArray<Field>>(uc.listFields(conceptId)),
  getConceptGraph: () => as<ConceptGraph>(uc.getConceptGraph),
  addField: ({ conceptId, name, kind, config, formula }) =>
    admin<Field>(uc.addField({ conceptId, name, kind, config, formula })),
  updateField: ({ id, name, config, formula }) =>
    admin<Field>(uc.updateField({ id, name, config, formula })),
  deleteField: ({ id }) => admin<Field>(uc.deleteField(id)),
  listInstances: ({ conceptId }) => mapErr(uc.listInstances(conceptId, { decorate: true })),
  getInstance: ({ id }) => as<InstanceDetail>(uc.getInstanceDetail(id)),
  getChanged: () => mapErr(uc.getChanged),
  createInstance: ({ conceptId, fields }) =>
    checkThen(
      (orgId) => assertMembers(orgId, conceptId, fields),
      uc.createInstance(conceptId, fields),
    ),
  updateInstance: ({ id, expectedVersion, patch }) =>
    checkThen(
      (orgId) => assertMembersForInstance(orgId, id, patch),
      uc.updateInstance(id, expectedVersion, patch),
    ),
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
