import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { BlobStore } from "../blob/BlobStore"
import type { Attachment, Id } from "../domain/types"
import { AttachmentNotFound, AttachmentTooLarge, ItemNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AttachmentRow, toAttachment } from "./rows"

/** Upload ceiling. The HTTP routes buffer the whole body in memory before this
 *  service sees it, so the cap is about process memory, not storage policy. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Who owns the new file — exactly one, mirroring the `attachments_one_owner`
 *  CHECK. `itemId` = a record's file; `bucketId` = a dashboard widget's own file
 *  (`shared` decides whether org-scope lists may see it). */
export type UploadOwner =
  | { readonly itemId: Id }
  | { readonly bucketId: Id; readonly shared?: boolean }

export interface UploadInput {
  readonly owner: UploadOwner
  readonly filename: string
  readonly mimeType?: string
  readonly data: Uint8Array
}

/** Exactly one scope: `itemId` (or `instanceId`, resolved to its lineage) = one
 *  record's files; `bucketId` = one widget's own files; `conceptId` = recent
 *  across its items; none = org-wide (which excludes private bucket files). */
export interface ListFilesFilter {
  readonly itemId?: string
  readonly instanceId?: string
  readonly bucketId?: string
  readonly conceptId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

/**
 * Files (the binary side of the annotation substrate). Bytes go to the
 * BlobStore; metadata is an org-scoped `attachments` row owned by EITHER an item
 * lineage (like `annotations.subject_id`, so files survive re-publishes) OR a
 * dashboard-widget bucket (a file belonging to no record at all).
 * CRUD-with-audit-events (the AnnotationService pattern): each mutation appends
 * an `events` row on the attachment's own stream (subjectKind "attachment",
 * payload carrying the host item or bucket) for the activity feed / live-sync.
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
            if (input.data.length > MAX_UPLOAD_BYTES)
              return yield* Effect.fail(
                new AttachmentTooLarge({
                  sizeBytes: input.data.length,
                  maxBytes: MAX_UPLOAD_BYTES,
                }),
              )
            const itemId = "itemId" in input.owner ? input.owner.itemId : null
            const bucketId = "bucketId" in input.owner ? input.owner.bucketId : null
            // A bucket is a client-minted uuid living in a dashboard body — there
            // is no row to validate. An item must exist and be live: whole-item
            // archive blocks new uploads (block-not-cascade).
            if (itemId) {
              const owner = yield* sql<{ readonly id: string }>`
              SELECT id FROM items
              WHERE id = ${itemId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
              if (!owner[0]) return yield* Effect.fail(new ItemNotFound({ itemId }))
            }
            const shared = "bucketId" in input.owner ? (input.owner.shared ?? true) : true

            const key = `${orgId}/${randomUUID()}`
            yield* blob.put(key, input.data, input.mimeType)
            const rows = yield* sql<AttachmentRow>`
            INSERT INTO attachments (org_id, item_id, bucket_id, bucket_shared, filename, content_ref, mime_type, size_bytes, created_by)
            VALUES (${orgId}, ${itemId}, ${bucketId}, ${shared}, ${input.filename}, ${key}, ${input.mimeType ?? null}, ${input.data.length}, ${actor})
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
                ...(itemId ? { subjectId: itemId } : { bucketId: bucketId! }),
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
            : filter.bucketId
              ? // A widget's own bucket — the only scope that lists private files.
                yield* sql<AttachmentRow>`
                SELECT a.* FROM attachments a
                WHERE a.org_id = ${orgId} AND a.bucket_id = ${filter.bucketId}${liveOnly}
                ORDER BY a.id DESC LIMIT ${limit}`
              : filter.conceptId
                ? // The items JOIN excludes bucket files for free (item_id IS NULL).
                  yield* sql<AttachmentRow>`
                  SELECT a.* FROM attachments a
                  JOIN items it ON it.id = a.item_id
                  WHERE a.org_id = ${orgId} AND it.concept_id = ${filter.conceptId}${liveOnly}
                  ORDER BY a.id DESC LIMIT ${limit}`
                : // Org-wide: every record file, plus only the SHARED bucket files.
                  // Private buckets are visible solely through their own widget.
                  yield* sql<AttachmentRow>`
                  SELECT a.* FROM attachments a
                  WHERE a.org_id = ${orgId}
                    AND (a.bucket_id IS NULL OR a.bucket_shared)${liveOnly}
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
      //
      // A PRIVATE bucket file (bucket_shared = false) is deliberately excluded
      // from org-scope `list`, so it must not be fetchable org-wide here either —
      // otherwise the flag only hides files from the UI while the bytes stay one
      // request away for anyone holding the id. Its uploader keeps access (they
      // reach it through the owning widget, which is the one scope that lists
      // private files). Record files and shared buckets are unaffected.
      const download = (attachmentId: Id) =>
        Effect.gen(function* () {
          const { actor } = yield* OrgContext
          const row = yield* load(attachmentId)
          if (row.bucket_id && !row.bucket_shared && row.created_by !== actor) {
            return yield* Effect.fail(new AttachmentNotFound({ attachmentId }))
          }
          const attachment = toAttachment(row)
          const data = yield* blob.get(attachment.contentRef)
          return { attachment, data } as { attachment: Attachment; data: Uint8Array }
        })

      /** The owner half of an event payload — `subjectId` (host item, so the
       *  per-item feed matches) or `bucketId`, never both. */
      const ownerPayload = (a: Attachment) =>
        a.itemId ? { subjectId: a.itemId } : { bucketId: a.bucketId! }

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
                ...ownerPayload(attachment),
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
                  ...ownerPayload(attachment),
                },
              })
              return attachment
            }),
          )
          .pipe(Effect.tap((attachment) => blob.del(attachment.contentRef).pipe(Effect.ignore)))

      /**
       * Purge a whole widget bucket — every row (archived included), one txn, one
       * tombstone each. Called when a Files widget or its dashboard is deleted and
       * the user chooses to discard the files; a no-op empty bucket is fine.
       * Blobs are swept after commit, best-effort, like {@link purge}.
       */
      const purgeBucket = (bucketId: Id) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const { orgId } = yield* OrgContext
              const rows = yield* sql<AttachmentRow>`
              DELETE FROM attachments
              WHERE org_id = ${orgId} AND bucket_id = ${bucketId} RETURNING *`
              const purged = rows.map(toAttachment)
              for (const attachment of purged) {
                yield* events.append({
                  subjectKind: "attachment",
                  subjectId: attachment.id,
                  eventType: "AttachmentPurged",
                  payload: {
                    _tag: "AttachmentPurged",
                    attachmentId: attachment.id,
                    filename: attachment.filename,
                    bucketId,
                  },
                })
              }
              return purged
            }),
          )
          .pipe(
            Effect.tap((purged) =>
              Effect.forEach(purged, (a) => blob.del(a.contentRef).pipe(Effect.ignore), {
                discard: true,
              }),
            ),
          )

      /**
       * Re-stamp a whole bucket's sharing flag. `bucket_shared` lives on each row
       * (set at upload from the widget's setting), so flipping the widget's toggle
       * has to reconcile the files already in the bucket — otherwise a bucket the
       * user just marked private keeps listing its existing files org-wide, which
       * is exactly the guarantee the setting makes. Returns the affected rows; an
       * empty bucket is a no-op.
       */
      const setBucketShared = (bucketId: Id, shared: boolean) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const rows = yield* sql<AttachmentRow>`
            UPDATE attachments SET bucket_shared = ${shared}
            WHERE org_id = ${orgId} AND bucket_id = ${bucketId} AND bucket_shared <> ${shared}
            RETURNING *`
            return rows.map(toAttachment)
          }),
        )

      return {
        upload,
        list,
        download,
        archive,
        restore,
        purge,
        purgeBucket,
        setBucketShared,
      } as const
    }),
    dependencies: [EventStore.Default],
  },
) {}
