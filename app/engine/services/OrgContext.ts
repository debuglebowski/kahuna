import { Context } from "effect"
import type { PolicySet } from "../domain/access"
import type { Actor, OrgId } from "../domain/types"

/**
 * Who a scope acts as, for READ visibility.
 *
 * `"system"` is not a membership role — it is the engine's own privilege level,
 * used by callers that are not a person: the automations runner, the decay tick,
 * integration syncs, seeds and backfills. It sees everything.
 *
 * A real request's role is always resolved from the BetterAuth membership at the
 * session boundary, never written as a literal, so `"system"` is unreachable from
 * HTTP. `Role` (server/policy.ts) is deliberately NOT assignable to `"system"` —
 * see `sessionScope` / `systemScope` in server/runtime.ts.
 */
export type ScopeRole = "owner" | "admin" | "member" | "system"

/**
 * Request-scoped org scope. Provided per request via `Effect.provideService` /
 * a `Layer.succeed` at the boundary. Every DB-touching engine method reads
 * `orgId` from here and injects it — no engine method takes `org_id` as a
 * parameter, so no query can forget to scope.
 *
 * `role` is the ONE exception to the engine's otherwise permission-agnostic
 * design (write-side gates all live at the server boundary — see the "auth-tier"
 * comments in server/rpc.ts). It lives here because READ filtering has to apply
 * to every path that resolves a concept, and there are ~20 such handlers plus a
 * recursive relation expansion: one gate inside the engine is far harder to
 * bypass than N gates outside it.
 */
export interface OrgScope {
  readonly orgId: OrgId
  readonly actor: Actor
  readonly role: ScopeRole
  /**
   * The caller's resolved access rules — their roles' rules plus their own shares,
   * unioned (see `domain/access.ts`). Resolved ONCE per request at the boundary,
   * because a list read needs the whole set before it can filter.
   *
   * Optional during the migration onto the access model: absent means "no rules",
   * so every decision falls through to the resource defaults — which is exactly
   * today's behaviour. Every real request path fills it in; tests and scripts that
   * only exercise role-based visibility may leave it off.
   */
  readonly policy?: PolicySet
}

export class OrgContext extends Context.Tag("engine/OrgContext")<OrgContext, OrgScope>() {}
