import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { ConceptService } from "./ConceptService"
import { OrgContext } from "./OrgContext"
import { type InstanceRow, toInstance } from "./rows"

export interface FindInstancesInput {
  readonly conceptName: string
  /** JSONB containment filter: `state @> where`. */
  readonly where?: Record<string, unknown>
  /** Restrict to instances that are the `from` of a relation pointing at `toId`. */
  readonly relatedToTo?: { readonly relationType: string; readonly toId: string }
  /** Restrict to instances that are the `to` of a relation coming from `fromId`. */
  readonly relatedToFrom?: { readonly relationType: string; readonly fromId: string }
  readonly orderBy?: { readonly field: string; readonly dir?: "asc" | "desc" }
  readonly limit?: number
}

/** Read-side: JSONB-filtered, relation-aware instance queries — always org-scoped. */
export class QueryService extends Effect.Service<QueryService>()("engine/QueryService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const concepts = yield* ConceptService

    const findInstances = (input: FindInstancesInput) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const concept = yield* concepts.getByName(input.conceptName)
        const limit = input.limit ?? 100

        const whereExtra = input.where ? sql` AND state @> ${sql.json(input.where)}` : sql``
        const relExtra = input.relatedToTo
          ? sql` AND id IN (SELECT from_id FROM relations WHERE org_id = ${orgId} AND relation_type = ${input.relatedToTo.relationType} AND to_id = ${input.relatedToTo.toId} AND deleted_at IS NULL)`
          : input.relatedToFrom
            ? sql` AND id IN (SELECT to_id FROM relations WHERE org_id = ${orgId} AND relation_type = ${input.relatedToFrom.relationType} AND from_id = ${input.relatedToFrom.fromId} AND deleted_at IS NULL)`
            : sql``
        const orderCol =
          !input.orderBy || input.orderBy.field === "created_at"
            ? sql`created_at`
            : sql`state->>${input.orderBy.field}`
        const dir = input.orderBy?.dir === "asc" ? sql.unsafe("ASC") : sql.unsafe("DESC")

        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE org_id = ${orgId} AND concept_id = ${concept.id} AND deleted_at IS NULL${whereExtra}${relExtra}
          ORDER BY ${orderCol} ${dir}
          LIMIT ${limit}`
        return rows.map(toInstance)
      })

    return { findInstances } as const
  }),
  dependencies: [ConceptService.Default],
}) {}
