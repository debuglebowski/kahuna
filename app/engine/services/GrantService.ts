import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { AccessAction, AccessCondition, AccessResourceType } from "../domain/access"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { PolicyService } from "./PolicyService"

/** One grant, as the Share dialog sees it. `userId`/`roleId` are exclusive. */
export interface Grant {
  readonly id: string
  readonly userId: string | null
  readonly roleId: string | null
  /** Resolved server-side so the dialog needs no second fetch. Null for a person. */
  readonly roleName: string | null
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<string>
  readonly resourceType: AccessResourceType
  readonly resourceId: string | null
  readonly createdBy: string | null
  readonly createdAt: Date
}

interface GrantRow {
  readonly id: string
  readonly user_id: string | null
  readonly role_id: string | null
  readonly role_name: string | null
  readonly effect: string
  readonly actions: ReadonlyArray<string>
  readonly resource_type: string
  readonly resource_id: string | null
  readonly created_by: string | null
  readonly created_at: Date
}

const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  userId: r.user_id,
  roleId: r.role_id,
  roleName: r.role_name,
  effect: r.effect === "allow" ? "allow" : "deny",
  actions: r.actions,
  resourceType: r.resource_type as AccessResourceType,
  resourceId: r.resource_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
})

export interface CreateGrantInput {
  readonly resourceType: AccessResourceType
  /** For a record this is the ITEM id, so the grant survives a new version. */
  readonly resourceId: string
  readonly userId?: string
  readonly roleId?: string
  readonly actions: ReadonlyArray<AccessAction>
  readonly conceptId?: string
  readonly condition?: AccessCondition | null
  readonly effect?: "allow" | "deny"
}

/**
 * Grants on individual resources — the Share dialog's engine half.
 *
 * A share IS an `access_rules` row with `actor_id` set instead of `role_id`, so this
 * writes the same table `AccessRoleService` does. Separate service because the two
 * have different callers and different authorization: role rules are `configure`,
 * shares are `share` on the one resource (enforced at the RPC boundary, like every
 * other write gate).
 *
 * Every write bumps the org's policy generation, so a share lands on the recipient's
 * very next request.
 */
export class GrantService extends Effect.Service<GrantService>()("engine/GrantService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const policies = yield* PolicyService
    const events = yield* EventStore

    /** Current grants on one resource, newest last. */
    const listFor = (
      resourceType: AccessResourceType,
      resourceId: string,
    ): Effect.Effect<ReadonlyArray<Grant>, never, OrgContext> =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<GrantRow>`
          SELECT r.id, r.actor_id AS user_id, r.role_id, ro.name AS role_name,
                 r.effect, r.actions, r.resource_type, r.resource_id,
                 r.created_by, r.created_at
          FROM access_rules r
          LEFT JOIN access_roles ro ON ro.id = r.role_id
          WHERE r.org_id = ${orgId}
            AND r.resource_type = ${resourceType}
            AND r.resource_id = ${resourceId}
          ORDER BY r.created_at ASC`
        return rows.map(toGrant)
      }).pipe(Effect.orDie)

    /** One grant by id, or null — the revoke path needs it to emit a full event. */
    const getById = (id: string): Effect.Effect<Grant | null, never, OrgContext> =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<GrantRow>`
          SELECT r.id, r.actor_id AS user_id, r.role_id, ro.name AS role_name,
                 r.effect, r.actions, r.resource_type, r.resource_id,
                 r.created_by, r.created_at
          FROM access_rules r
          LEFT JOIN access_roles ro ON ro.id = r.role_id
          WHERE r.org_id = ${orgId} AND r.id = ${id} LIMIT 1`
        return rows[0] ? toGrant(rows[0]) : null
      }).pipe(Effect.orDie)

    /**
     * Write a grant. The CHECK constraint enforces exactly-one-subject, so a caller
     * passing both or neither fails at the database rather than silently picking one.
     *
     * Audited on the ordinary event log (`AccessShared`), so "who gave the contractor
     * this record, and when?" is answerable in the activity feed, and the history
     * outlives the grant being revoked.
     */
    const create = (input: CreateGrantInput): Effect.Effect<Grant, never, OrgContext> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            const rows = yield* sql<GrantRow>`
              INSERT INTO access_rules
                (org_id, role_id, actor_id, effect, actions, resource_type, resource_id,
                 concept_id, condition, created_by)
              VALUES (${orgId}, ${input.roleId ?? null}, ${input.userId ?? null},
                      ${input.effect ?? "allow"}, ${[...input.actions]},
                      ${input.resourceType}, ${input.resourceId},
                      ${input.conceptId ?? null},
                      ${input.condition ? JSON.stringify(input.condition) : null}::jsonb,
                      ${actor})
              RETURNING id, actor_id AS user_id, role_id, NULL AS role_name, effect, actions,
                        resource_type, resource_id, created_by, created_at`
            const grant = toGrant(rows[0]!)
            yield* events.append({
              subjectKind: "accessRule",
              subjectId: grant.id,
              eventType: "AccessShared",
              payload: {
                _tag: "AccessShared",
                resourceType: input.resourceType,
                resourceId: input.resourceId,
                userId: input.userId ?? null,
                roleId: input.roleId ?? null,
                actions: [...input.actions],
                effect: input.effect ?? "allow",
              } as never,
            })
            yield* policies.bump(orgId)
            return grant
          }),
        )
        .pipe(Effect.orDie)

    /**
     * Revoke a grant. Idempotent: a missing row is a no-op, so a double-click or a
     * concurrent revoke does not error.
     *
     * Deliberately allows ANY holder of `share` to revoke, not only whoever granted —
     * access belongs to the org, so a departed employee's shares must stay revocable.
     * That check is the RPC boundary's; this is the write.
     */
    const revoke = (id: string): Effect.Effect<boolean, never, OrgContext> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const existing = yield* getById(id)
            if (!existing) return false
            yield* sql`DELETE FROM access_rules WHERE org_id = ${orgId} AND id = ${id}`
            yield* events.append({
              subjectKind: "accessRule",
              subjectId: id,
              eventType: "AccessRevoked",
              payload: {
                _tag: "AccessRevoked",
                resourceType: existing.resourceType,
                resourceId: existing.resourceId,
                userId: existing.userId,
                roleId: existing.roleId,
              } as never,
            })
            yield* policies.bump(orgId)
            return true
          }),
        )
        .pipe(Effect.orDie)

    return { listFor, getById, create, revoke } as const
  }),
  dependencies: [PolicyService.Default, EventStore.Default],
}) {}
