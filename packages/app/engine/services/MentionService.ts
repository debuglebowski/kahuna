import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Id } from "../domain/types"
import { OrgContext } from "./OrgContext"

/** One inbound mention of a record: where it was written, not what it said. */
export interface Backlink {
  /** Which rich-text home the mention lives in. */
  readonly source: "record" | "task"
  /** For `record`: the source record version VERSION holding the mention. */
  readonly fromVersionId: Id | null
  /** For `record`: the source lineage — what a link should address. */
  readonly fromRecordId: Id | null
  /** For `record`: the field the mention sits in, so the panel can name it. */
  readonly fromFieldId: Id | null
  readonly fromConceptId: Id | null
  /** For `task`: the annotation holding the mention. */
  readonly fromAnnotationId: Id | null
}

interface BacklinkRow {
  readonly source: string
  readonly from_version_id: string | null
  readonly from_record_id: string | null
  readonly from_field_id: string | null
  readonly from_concept_id: string | null
  readonly from_annotation_id: string | null
}

/**
 * Reads over the `mentions` index — the inbound half of `@` mentions.
 *
 * Deliberately read-only. Index MAINTENANCE lives with the writes that own each
 * rich-text home (`RecordService` for record version fields, `AnnotationService` for
 * task descriptions), because a rebuild has to happen inside the same transaction
 * as the document write or the index can disagree with the doc.
 *
 * NOTE: this service resolves no labels and applies no permission filter — it
 * answers "which sources mention this lineage". Deciding what the caller may SEE
 * of those sources (and dropping the ones they may not) belongs at the use-case
 * boundary, alongside the field-mask projection, exactly as relation targets are
 * resolved in `getInstanceDetail`.
 */
export class MentionService extends Effect.Service<MentionService>()("engine/MentionService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    /**
     * Inbound record mentions of one lineage.
     *
     * Mirrors `RelationService.listTo`'s rules for what counts as a public
     * reference: the source version must be PUBLISHED and not archived, because a
     * draft is private and must not announce itself from the target's side.
     *
     * The `DISTINCT ON (record_id)` is not decoration. A concept with
     * `edit_reach: "any"` can hold several published versions at once, each
     * carrying the same mention, which would otherwise show the same source five
     * times over. Collapsing to the newest version per lineage is the same shape
     * `QueryService.findRecords` uses for its head-only reads.
     */
    const listBacklinks = (recordId: Id) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<BacklinkRow>`
          (
            SELECT DISTINCT ON (src.record_id)
                   'record'          AS source,
                   src.id            AS from_version_id,
                   src.record_id       AS from_record_id,
                   m.from_field_id   AS from_field_id,
                   src.concept_id    AS from_concept_id,
                   NULL::uuid        AS from_annotation_id
              FROM mentions m
              JOIN record_versions src
                ON src.id = m.from_version_id
               AND src.version_status = 'published'
               AND src.archived_at IS NULL
             WHERE m.org_id = ${orgId} AND m.target_record_id = ${recordId}
             ORDER BY src.record_id, src.version_seq DESC
          )
          UNION ALL
          (
            SELECT 'task'      AS source,
                   NULL::uuid  AS from_version_id,
                   NULL::uuid  AS from_record_id,
                   NULL::uuid  AS from_field_id,
                   NULL::uuid  AS from_concept_id,
                   a.id        AS from_annotation_id
              FROM mentions m
              JOIN annotations a
                ON a.id = m.from_annotation_id
               AND a.type = 'task'
               AND a.archived_at IS NULL
             WHERE m.org_id = ${orgId} AND m.target_record_id = ${recordId}
          )`
        return rows.map(
          (r): Backlink => ({
            source: r.source === "task" ? "task" : "record",
            fromVersionId: r.from_version_id,
            fromRecordId: r.from_record_id,
            fromFieldId: r.from_field_id,
            fromConceptId: r.from_concept_id,
            fromAnnotationId: r.from_annotation_id,
          }),
        )
      })

    return { listBacklinks } as const
  }),
}) {}
