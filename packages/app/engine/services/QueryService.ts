import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { compileRecordFilter, filterFragment } from "../domain/accessSql"
import type { ConceptRef } from "../domain/types"
import { scopeConceptRead } from "../domain/visibility"
import { ConceptService } from "./ConceptService"
import { OrgContext } from "./OrgContext"
import { type RecordVersionRow, toRecordVersion } from "./rows"

/** Identify the concept by id or name (exactly one), plus the query options. */
export type FindRecordsInput = ConceptRef & {
  /** JSONB containment filter: `state @> where` (keys are field ids). */
  readonly where?: Record<string, unknown>
  /** Restrict to record versions that are the `from` of a `fieldId` relation pointing at `toId`. */
  readonly relatedToTo?: { readonly fieldId: string; readonly toId: string }
  /** Restrict to record versions that are the `to` of a `fieldId` relation coming from `fromId`. */
  readonly relatedToFrom?: { readonly fieldId: string; readonly fromId: string }
  /** `field` is a field id (or `"created_at"`). */
  readonly orderBy?: { readonly field: string; readonly dir?: "asc" | "desc" }
  readonly limit?: number
  /** Include archived (soft-deleted) record versions too — defaults to live-only. */
  readonly includeArchived?: boolean
}

/** Read-side: JSONB-filtered, relation-aware record version queries — always org-scoped. */
export class QueryService extends Effect.Service<QueryService>()("engine/QueryService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const concepts = yield* ConceptService

    const findRecords = (input: FindRecordsInput) =>
      Effect.gen(function* () {
        const scope = yield* OrgContext
        const { orgId } = scope
        // `getByIdForRead` (not `getById`): this is THE list read, so a restricted
        // concept must fail here rather than return rows. `getByName` is only
        // reachable from engine-internal callers (seeds/tests), which run as system.
        const concept =
          "conceptId" in input
            ? yield* concepts.getByIdForRead(input.conceptId)
            : yield* concepts.getByName(input.conceptName)
        const limit = input.limit ?? 100

        // ── RECORD-LEVEL ACCESS ────────────────────────────────────────────────
        // Compiled INTO the query, never applied to the returned rows. This read
        // carries a LIMIT (50k from the RPC boundary), so filtering afterwards would
        // make LIMIT bound the wrong set — wrong counts, wrong truncation. See
        // domain/accessSql.ts.
        //
        // The concept gate above only proved the concept is REACHABLE. Whether its
        // records are readable without a per-record rule is a separate question — see
        // `scopeConceptRead`. A share-only caller is reachable but `recordsByDefault`
        // is false, so the filter below yields exactly the rows shared with them.
        const { recordsByDefault } = scopeConceptRead(scope, concept.id)
        const fallback = recordsByDefault
        const accessExtra = scope.policy
          ? filterFragment(sql, compileRecordFilter(sql, scope.policy, concept.id, fallback))
          : sql``

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

        // Versioned concept ⇒ "head-only": one row per record (the latest published,
        // non-archived version of a non-archived record). DISTINCT ON forces record_id
        // as the lead sort, so we dedupe in an inner query and re-sort/limit outside
        // (LIMIT then bounds records, not versions). The non-versioned path below is
        // left byte-for-byte unchanged. Record-archive is filtered via a subquery so
        // the inner FROM stays a single table. The where/relation filters apply in
        // the OUTER query — they must test the HEAD row, not every version, or a
        // filter could resurrect a superseded version whose old state still matches.
        if (concept.versioningEnabled) {
          const itemLive = input.includeArchived
            ? sql``
            : sql` AND record_id IN (SELECT id FROM records WHERE org_id = ${orgId} AND archived_at IS NULL)`
          const rows = yield* sql<RecordVersionRow>`
            SELECT * FROM (
              SELECT DISTINCT ON (record_id) * FROM record_versions
              WHERE org_id = ${orgId} AND concept_id = ${concept.id}
                AND version_status = 'published' AND archived_at IS NULL${itemLive}
              ORDER BY record_id, version_seq DESC
            ) head
            WHERE TRUE${whereExtra}${relExtra}${accessExtra}
            ORDER BY ${orderCol} ${dir}
            LIMIT ${limit}`
          return rows.map(toRecordVersion)
        }

        const rows = yield* sql<RecordVersionRow>`
          SELECT * FROM record_versions
          WHERE org_id = ${orgId} AND concept_id = ${concept.id}${liveOnly}${whereExtra}${relExtra}${accessExtra}
          ORDER BY ${orderCol} ${dir}
          LIMIT ${limit}`
        return rows.map(toRecordVersion)
      })

    return { findRecords } as const
  }),
  dependencies: [ConceptService.Default],
}) {}
