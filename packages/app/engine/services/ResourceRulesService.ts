import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { AccessResourceType } from "../domain/access"
import { OrgContext } from "./OrgContext"
import { PolicyService } from "./PolicyService"

/**
 * Orphan cleanup for `access_rules`, and nothing else.
 *
 * This is what survives `AccessDefaultsService`. That service did two unrelated
 * jobs: it held the creation TEMPLATE (retired — a role's blanket rule already
 * covers resources made later, which is what the template was standing in for),
 * and it swept up rules pointing at deleted resources. The second job has nothing
 * to do with templates and did not go away with them.
 *
 * WHY IT HAS TO EXIST. `access_rules.resource_id` has no foreign key and cannot
 * have one: it points at any of five different tables depending on
 * `resource_type`. So nothing in the database removes a rule when its resource is
 * deleted, the orphans are silent, and every one of them loads into every resolved
 * policy from then on — forever.
 */
export class ResourceRulesService extends Effect.Service<ResourceRulesService>()(
  "engine/ResourceRulesService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const policies = yield* PolicyService

      /**
       * Drop every rule naming a resource that is going away. Call this on every
       * delete path, inside the deleting transaction.
       *
       * `conceptId` is the container form — "the records inside this concept" — and
       * is filtered on `resource_id IS NULL` so it clears only the concept-scoped
       * column, never a rule naming one specific record.
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
          // The removal changes what every holder resolves, so the memoized policies
          // have to be invalidated — a warm server would otherwise keep deciding from
          // rules that name a resource which no longer exists.
          yield* policies.bump(orgId)
        }).pipe(Effect.orDie)

      return { forget } as const
    }),
    dependencies: [PolicyService.Default],
  },
) {}
