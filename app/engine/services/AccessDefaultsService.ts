import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { ACTION_ALL, AccessAction, AccessResourceType } from "../domain/access"
import { OrgContext } from "./OrgContext"
import { PolicyService } from "./PolicyService"

/**
 * ── THE CREATION TEMPLATE ────────────────────────────────────────────────────
 *
 * What a NEWLY created resource grants each role, and the machinery that copies it
 * into real rules the moment a concept, dashboard, view or automation is created.
 *
 * WHY THIS EXISTS. Access used to have two layers: a `visibility` column answering
 * "who sees this normally?", and `access_rules` as exceptions over it. That is why
 * every cell in the permissions grid had to carry an "Inherit" state — "no rule
 * here, something else decides". Collapsing to one layer means every (resource,
 * role) pair holds its own value, which in turn means something has to decide what
 * a brand-new resource starts with. That is this table.
 *
 * IT IS NOT A RULE. Nothing in `decide()` reads `access_defaults`, and nothing may
 * start: the instant it is consulted at request time it has become the second layer
 * again, and the grid goes back to needing "Inherit". `access-defaults.test.ts` pins
 * this by asserting a resolved `PolicySet` is unchanged by writing a template row.
 *
 * ── WHAT "NOT ALLOWED" LOOKS LIKE ────────────────────────────────────────────
 *
 * The ABSENCE of an allow — never a deny row. A deny is absolute and beats per-record
 * shares (see `scopeConceptRead`), so materializing "this role can't see Deals" as
 * `deny(role, Deals)` would silently kill every share of a Deal to that role's
 * holders. Templates and materialization therefore write allows only.
 */

/** The resource types that carry per-resource values (and so have a grid). The rest
 *  — field, bucket, task, note, member, org — keep their existing defaults and are
 *  edited as ordinary rules under "Other". */
export const TEMPLATED_TYPES: ReadonlyArray<AccessResourceType> = [
  "concept",
  "record",
  "dashboard",
  "view",
  "automation",
]

const isTemplated = (t: AccessResourceType): boolean => TEMPLATED_TYPES.includes(t)

/** One role's template for one resource type. */
export interface AccessDefault {
  readonly roleId: string
  readonly resourceType: AccessResourceType
  readonly actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>
}

interface DefaultRow {
  readonly role_id: string
  readonly resource_type: string
  readonly actions: ReadonlyArray<string>
}

export class AccessDefaultsService extends Effect.Service<AccessDefaultsService>()(
  "engine/AccessDefaultsService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const policies = yield* PolicyService

      /** Every template row for the org, allow-effect only (see the header). */
      const list = (): Effect.Effect<ReadonlyArray<AccessDefault>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<DefaultRow>`
            SELECT role_id, resource_type, actions FROM access_defaults
            WHERE org_id = ${orgId} AND effect = 'allow'`
          return rows.map((r) => ({
            roleId: r.role_id,
            resourceType: r.resource_type as AccessResourceType,
            actions: r.actions as ReadonlyArray<AccessAction>,
          }))
        }).pipe(Effect.orDie)

      /**
       * Set one role's template for one type. Empty `actions` clears it — that is how
       * "a new concept grants this role nothing" is expressed, and it is a delete
       * rather than an empty array so the absent-means-nothing rule holds everywhere.
       */
      const set = (input: {
        readonly roleId: string
        readonly resourceType: AccessResourceType
        readonly actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          if (input.actions.length === 0) {
            yield* sql`
              DELETE FROM access_defaults
              WHERE org_id = ${orgId} AND role_id = ${input.roleId}
                AND resource_type = ${input.resourceType} AND effect = 'allow'`
          } else {
            yield* sql`
              INSERT INTO access_defaults
                (org_id, role_id, resource_type, effect, actions, created_by)
              VALUES (${orgId}, ${input.roleId}, ${input.resourceType}, 'allow',
                      ${[...input.actions]}, ${actor})
              ON CONFLICT (role_id, resource_type, effect)
              DO UPDATE SET actions = EXCLUDED.actions, updated_at = now()`
          }
          // No policy bump: templates are not rules and no resolved PolicySet
          // contains them. Bumping here would invalidate every cached policy in the
          // org for a change that cannot affect a single decision.
        }).pipe(Effect.orDie)

      /**
       * THE HOOK. Copy the template into real rules for one just-created resource.
       *
       * MUST run inside the creating transaction. A crash between the INSERT and this
       * call leaves a resource with no rules at all — and once the fallback is
       * fail-closed, that resource is invisible to everyone except full-access roles,
       * including to the admin who created it and sees it working fine.
       *
       * `conceptId` is passed for `record`, whose rules are scoped by container
       * rather than by id — "records in this concept", `concept_id` set and
       * `resource_id` null.
       *
       * Full-access roles are skipped: they hold one blanket `allow ['*']` and are
       * exempt by design (see `access_roles.full_access`).
       */
      const materialize = (input: {
        readonly resourceType: AccessResourceType
        readonly resourceId?: string
        readonly conceptId?: string
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          if (!isTemplated(input.resourceType)) return 0
          const rows = yield* sql<DefaultRow>`
            SELECT d.role_id, d.resource_type, d.actions
            FROM access_defaults d
            JOIN access_roles r ON r.id = d.role_id
            WHERE d.org_id = ${orgId} AND d.resource_type = ${input.resourceType}
              AND d.effect = 'allow' AND r.full_access = false`
          for (const row of rows) {
            yield* sql`
              INSERT INTO access_rules
                (org_id, role_id, effect, actions, resource_type, resource_id,
                 concept_id, created_by)
              VALUES (${orgId}, ${row.role_id}, 'allow', ${[...row.actions]},
                      ${input.resourceType}, ${input.resourceId ?? null},
                      ${input.conceptId ?? null}, ${actor})`
          }
          if (rows.length > 0) yield* policies.bump(orgId)
          return rows.length
        }).pipe(Effect.orDie)

      /**
       * Drop every per-resource rule naming a resource that is going away.
       *
       * `access_rules.resource_id` has no foreign key and cannot have one — it points
       * at any of five tables. So orphans are silent and permanent, and once every
       * resource carries a row per role they accumulate into every resolved policy
       * forever. Call this on every delete path.
       */
      const forget = (input: {
        readonly resourceType: AccessResourceType
        readonly resourceId?: string
        readonly conceptId?: string
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          if (input.resourceId) {
            yield* sql`
              DELETE FROM access_rules
              WHERE org_id = ${orgId} AND resource_type = ${input.resourceType}
                AND resource_id = ${input.resourceId}`
          }
          if (input.conceptId) {
            yield* sql`
              DELETE FROM access_rules
              WHERE org_id = ${orgId} AND resource_type = ${input.resourceType}
                AND concept_id = ${input.conceptId} AND resource_id IS NULL`
          }
          yield* policies.bump(orgId)
        }).pipe(Effect.orDie)

      return { list, set, materialize, forget } as const
    }),
    dependencies: [PolicyService.Default],
  },
) {}
