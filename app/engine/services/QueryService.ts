import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { ConceptRef } from "../domain/types"
import { ConceptService } from "./ConceptService"
import { OrgContext } from "./OrgContext"
import { type InstanceRow, toInstance } from "./rows"

/** Identify the concept by id or name (exactly one), plus the query options. */
export type FindInstancesInput = ConceptRef & {
  /** JSONB containment filter: `state @> where` (keys are field ids). */
  readonly where?: Record<string, unknown>
  /** Restrict to instances that are the `from` of a `fieldId` relation pointing at `toId`. */
  readonly relatedToTo?: { readonly fieldId: string; readonly toId: string }
  /** Restrict to instances that are the `to` of a `fieldId` relation coming from `fromId`. */
  readonly relatedToFrom?: { readonly fieldId: string; readonly fromId: string }
  /** `field` is a field id (or `"created_at"`). */
  readonly orderBy?: { readonly field: string; readonly dir?: "asc" | "desc" }
  readonly limit?: number
  /** Include archived (soft-deleted) instances too — defaults to live-only. */
  readonly includeArchived?: boolean
}

/** Read-side: JSONB-filtered, relation-aware instance queries — always org-scoped. */
export class QueryService extends Effect.Service<QueryService>()("engine/QueryService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const concepts = yield* ConceptService

    const findInstances = (input: FindInstancesInput) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const concept =
          "conceptId" in input
            ? yield* concepts.getById(input.conceptId)
            : yield* concepts.getByName(input.conceptName)
        const limit = input.limit ?? 100

        const liveOnly = input.includeArchived ? sql`` : sql` AND archived_at IS NULL`
        const whereExtra = input.where ? sql` AND state @> ${sql.json(input.where)}` : sql``
        const relExtra = input.relatedToTo
          ? sql` AND id IN (SELECT from_id FROM relations WHERE org_id = ${orgId} AND field_id = ${input.relatedToTo.fieldId} AND to_id = ${input.relatedToTo.toId} AND archived_at IS NULL)`
          : input.relatedToFrom
            ? sql` AND id IN (SELECT to_id FROM relations WHERE org_id = ${orgId} AND field_id = ${input.relatedToFrom.fieldId} AND from_id = ${input.relatedToFrom.fromId} AND archived_at IS NULL)`
            : sql``
        const orderCol =
          !input.orderBy || input.orderBy.field === "created_at"
            ? sql`created_at`
            : sql`state->>${input.orderBy.field}`
        const dir = input.orderBy?.dir === "asc" ? sql.unsafe("ASC") : sql.unsafe("DESC")

        // Versioned concept ⇒ "head-only": one row per item (the latest published,
        // non-archived version of a non-archived item). DISTINCT ON forces item_id
        // as the lead sort, so we dedupe in an inner query and re-sort/limit outside
        // (LIMIT then bounds items, not versions). The non-versioned path below is
        // left byte-for-byte unchanged. Item-archive is filtered via a subquery so
        // the inner FROM stays a single table. The where/relation filters apply in
        // the OUTER query — they must test the HEAD row, not every version, or a
        // filter could resurrect a superseded version whose old state still matches.
        if (concept.versioningEnabled) {
          const itemLive = input.includeArchived
            ? sql``
            : sql` AND item_id IN (SELECT id FROM items WHERE org_id = ${orgId} AND archived_at IS NULL)`
          const rows = yield* sql<InstanceRow>`
            SELECT * FROM (
              SELECT DISTINCT ON (item_id) * FROM instances
              WHERE org_id = ${orgId} AND concept_id = ${concept.id}
                AND version_status = 'published' AND archived_at IS NULL${itemLive}
              ORDER BY item_id, version_seq DESC
            ) head
            WHERE TRUE${whereExtra}${relExtra}
            ORDER BY ${orderCol} ${dir}
            LIMIT ${limit}`
          return rows.map(toInstance)
        }

        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE org_id = ${orgId} AND concept_id = ${concept.id}${liveOnly}${whereExtra}${relExtra}
          ORDER BY ${orderCol} ${dir}
          LIMIT ${limit}`
        return rows.map(toInstance)
      })

    return { findInstances } as const
  }),
  dependencies: [ConceptService.Default],
}) {}
