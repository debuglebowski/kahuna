import { Context } from "effect"
import type { Actor, OrgId } from "../domain/types"

/**
 * Request-scoped org scope. Provided per request via `Effect.provideService` /
 * a `Layer.succeed` at the boundary. Every DB-touching engine method reads
 * `orgId` from here and injects it — no engine method takes `org_id` as a
 * parameter, so no query can forget to scope.
 */
export interface OrgScope {
  readonly orgId: OrgId
  readonly actor: Actor
}

export class OrgContext extends Context.Tag("engine/OrgContext")<OrgContext, OrgScope>() {}
