import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { BlobStore } from "../blob/BlobStore"
import type { Attachment, Id } from "../domain/types"
import { AttachmentNotFound, ItemNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AttachmentRow, toAttachment } from "./rows"

export interface UploadInput {
  readonly itemId: Id
  readonly filename: string
  readonly mimeType?: string
  readonly data: Uint8Array
}

/** Exactly one scope: `itemId` (or `instanceId`, resolved to its lineage) = one
 *  record's files; `conceptId` = recent across its items; none = org-wide. */
export interface ListFilesFilter {
  readonly itemId?: string
  readonly instanceId?: string
  readonly conceptId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

/**
 * Files on items (the binary side of the annotation substrate). Bytes go to the
 * BlobStore; metadata is an org-scoped `attachments` row keyed by the item
 * lineage (like `annotations.subject_id`), so files survive re-publishes.
 * CRUD-with-audit-events (the AnnotationService pattern): each mutation appends
 * an `events` row on the attachment's own stream (subjectKind "attachment",
 * payload.subjectId = the host item) for the activity feed / live-sync.
 */
export class AttachmentService extends Effect.Service<AttachmentService>()(
  "engine/AttachmentService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore
      const blob = yield* BlobStore

      const upload = (input: UploadInput) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            // Whole-item archive blocks new uploads (block-not-cascade).
            const owner = yield* sql<{ readonly id: string }>`
            SELECT id FROM items
            WHERE id = ${input.itemId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
            if (!owner[0]) return yield* Effect.fail(new ItemNotFound({ itemId: input.itemId }))

            const key = `${orgId}/${randomUUID()}`
            yield* blob.put(key, input.data, input.mimeType)
            const rows = yield* sql<AttachmentRow>`
            INSERT INTO attachments (org_id, item_id, filename, content_ref, mime_type, size_bytes, created_by)
            VALUES (${orgId}, ${input.itemId}, ${input.filename}, ${key}, ${input.mimeType ?? null}, ${input.data.length}, ${actor})
            RETURNING *`
            const attachment = toAttachment(rows[0]!)
            yield* events.append({
              subjectKind: "attachment",
              subjectId: attachment.id,
              eventType: "AttachmentAdded",
              payload: {
                _tag: "AttachmentAdded",
                attachmentId: attachment.id,
                filename: attachment.filename,
                subjectId: input.itemId,
              },
            })
            return attachment
          }),
        )

      const list = (filter: ListFilesFilter = {}) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // A widget may key by an instance row — resolve it to the lineage. A
          // dangling id reads as empty, not an error (the host may be purged).
          let itemId = filter.itemId
          if (!itemId && filter.instanceId) {
            const rows = yield* sql<{ readonly item_id: string }>`
            SELECT item_id FROM instances WHERE id = ${filter.instanceId} AND org_id = ${orgId} LIMIT 1`
            if (!rows[0]) return [] as Attachment[]
            itemId = rows[0].item_id
          }
          const liveOnly = filter.includeArchived ? sql`` : sql` AND a.archived_at IS NULL`
          const limit = Math.min(filter.limit ?? 500, 2000)
          const rows = itemId
            ? yield* sql<AttachmentRow>`
              SELECT a.* FROM attachments a
              WHERE a.org_id = ${orgId} AND a.item_id = ${itemId}${liveOnly}
              ORDER BY a.id DESC LIMIT ${limit}`
            : filter.conceptId
              ? yield* sql<AttachmentRow>`
                SELECT a.* FROM attachments a
                JOIN items it ON it.id = a.item_id
                WHERE a.org_id = ${orgId} AND it.concept_id = ${filter.conceptId}${liveOnly}
                ORDER BY a.id DESC LIMIT ${limit}`
              : yield* sql<AttachmentRow>`
                SELECT a.* FROM attachments a
                WHERE a.org_id = ${orgId}${liveOnly}
                ORDER BY a.id DESC LIMIT ${limit}`
          return rows.map(toAttachment)
        })

      const load = (attachmentId: Id) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AttachmentRow>`
          SELECT * FROM attachments WHERE id = ${attachmentId} AND org_id = ${orgId} LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AttachmentNotFound({ attachmentId }))
          return row
        })

      // Archived files stay downloadable (visible under "show archived").
      const download = (attachmentId: Id) =>
        Effect.gen(function* () {
          const attachment = toAttachment(yield* load(attachmentId))
          const data = yield* blob.get(attachment.contentRef)
          return { attachment, data } as { attachment: Attachment; data: Uint8Array }
        })

      const flipArchive = (attachmentId: Id, archived: boolean, eventType: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* load(attachmentId)
            const archivedAt = archived ? sql`now()` : sql`NULL`
            const rows = yield* sql<AttachmentRow>`
            UPDATE attachments SET archived_at = ${archivedAt}
            WHERE org_id = ${orgId} AND id = ${attachmentId} RETURNING *`
            const attachment = toAttachment(rows[0]!)
            yield* events.append({
              subjectKind: "attachment",
              subjectId: attachment.id,
              eventType,
              payload: {
                _tag: eventType as "AttachmentArchived" | "AttachmentRestored",
                attachmentId: attachment.id,
                filename: attachment.filename,
                subjectId: attachment.itemId,
              },
            })
            return attachment
          }),
        )

      const archive = (attachmentId: Id) => flipArchive(attachmentId, true, "AttachmentArchived")
      const restore = (attachmentId: Id) => flipArchive(attachmentId, false, "AttachmentRestored")

      /** Hard delete: row + blob gone, the event tombstone stays as history.
       *  The blob is removed after commit (best-effort — an orphan blob is
       *  harmless; a dangling row would not be). */
      const purge = (attachmentId: Id) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const { orgId } = yield* OrgContext
              const row = yield* load(attachmentId)
              yield* sql`DELETE FROM attachments WHERE org_id = ${orgId} AND id = ${attachmentId}`
              const attachment = toAttachment(row)
              yield* events.append({
                subjectKind: "attachment",
                subjectId: attachment.id,
                eventType: "AttachmentPurged",
                payload: {
                  _tag: "AttachmentPurged",
                  attachmentId: attachment.id,
                  filename: attachment.filename,
                  subjectId: attachment.itemId,
                },
              })
              return attachment
            }),
          )
          .pipe(Effect.tap((attachment) => blob.del(attachment.contentRef).pipe(Effect.ignore)))

      return { upload, list, download, archive, restore, purge } as const
    }),
    dependencies: [EventStore.Default],
  },
) {}
