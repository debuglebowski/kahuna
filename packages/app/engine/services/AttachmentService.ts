import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { BlobStore } from "../blob/BlobStore"
import type { Attachment, Id } from "../domain/types"
import {
  AttachmentNotFound,
  AttachmentTooLarge,
  FieldValidationError,
  RecordNotFound,
} from "../errors"
import { EventStore } from "./EventStore"
import * as fp from "./fileProperties"
import { type FilePropertyDef, ownerPayload, resolveFileProperty } from "./fileProperties"
import { OrgContext } from "./OrgContext"
import { type AttachmentRow, toAttachment } from "./rows"

/** Upload ceiling. The HTTP routes buffer the whole body in memory before this
 *  service sees it, so the cap is about process memory, not storage policy. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Who owns the new file — exactly one, mirroring the `attachments_one_owner`
 *  CHECK. `recordId` = a record's file (with `fieldId`, the value of that file
 *  PROPERTY; without, a loose Files-panel file); `bucketId` = a dashboard widget's
 *  own file (`shared` decides whether org-scope lists may see it). */
export type UploadOwner =
  | { readonly recordId: Id; readonly fieldId?: Id | null }
  | { readonly bucketId: Id; readonly shared?: boolean }
  /** No owner yet: an upload for a record about to be created (see
   *  `fileProperties.claimStaged`). Uploader-only until claimed; swept after
   *  `STAGED_TTL_HOURS`. */
  | { readonly staged: true }

/** A file property's files, keyed `recordId → fieldId → files` (position order). */
export type FieldFilesIndex = ReadonlyMap<Id, ReadonlyMap<Id, ReadonlyArray<Attachment>>>

export interface UploadInput {
  readonly owner: UploadOwner
  readonly filename: string
  readonly mimeType?: string
  readonly data: Uint8Array
}

/** Exactly one scope: `recordId` (or `recordVersionId`, resolved to its lineage) = one
 *  record's files; `bucketId` = one widget's own files; `conceptId` = recent
 *  across its records; none = org-wide (which excludes private bucket files). */
export interface ListFilesFilter {
  readonly recordId?: string
  readonly recordVersionId?: string
  readonly bucketId?: string
  readonly conceptId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

/**
 * Files (the binary side of the annotation substrate). Bytes go to the
 * BlobStore; metadata is an org-scoped `attachments` row owned by EITHER a record
 * lineage (like `annotations.subject_id`, so files survive re-publishes) OR a
 * dashboard-widget bucket (a file belonging to no record at all).
 * CRUD-with-audit-events (the AnnotationService pattern): each mutation appends
 * an `events` row on the attachment's own stream (subjectKind "attachment",
 * payload carrying the host record or bucket) for the activity feed / live-sync.
 */
export class AttachmentService extends Effect.Service<AttachmentService>()(
  "engine/AttachmentService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore
      const blob = yield* BlobStore

      const fileProperty = (recordId: Id, fieldId: Id) =>
        resolveFileProperty(sql, recordId, fieldId)
      const nextPosition = (recordId: Id, fieldId: Id) => fp.nextPosition(sql, recordId, fieldId)
      const displace = (keep: Attachment) => fp.displace(sql, events, keep)

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
            const recordId = "recordId" in input.owner ? input.owner.recordId : null
            const bucketId = "bucketId" in input.owner ? input.owner.bucketId : null
            // A bucket is a client-minted uuid living in a dashboard body — there
            // is no row to validate. A record must exist and be live: whole-record
            // archive blocks new uploads (block-not-cascade).
            const fieldId = "recordId" in input.owner ? (input.owner.fieldId ?? null) : null
            let field: FilePropertyDef | null = null
            if (recordId) {
              const owner = yield* sql<{ readonly id: string }>`
              SELECT id FROM records
              WHERE id = ${recordId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
              if (!owner[0]) return yield* Effect.fail(new RecordNotFound({ recordId }))
              if (fieldId) field = yield* fileProperty(recordId, fieldId)
            }
            const shared = "bucketId" in input.owner ? (input.owner.shared ?? true) : true
            const position = field ? yield* nextPosition(recordId!, field.id) : 0
            const staged = "staged" in input.owner
            const stagedUntil = staged
              ? sql`now() + make_interval(hours => ${fp.STAGED_TTL_HOURS})`
              : sql`NULL`

            const key = `${orgId}/${randomUUID()}`
            yield* blob.put(key, input.data, input.mimeType)
            const rows = yield* sql<AttachmentRow>`
            INSERT INTO attachments (org_id, record_id, bucket_id, bucket_shared, field_id, position, staged_until, filename, content_ref, mime_type, size_bytes, created_by)
            VALUES (${orgId}, ${recordId}, ${bucketId}, ${shared}, ${field?.id ?? null}, ${position}, ${stagedUntil}, ${input.filename}, ${key}, ${input.mimeType ?? null}, ${input.data.length}, ${actor})
            RETURNING *`
            const attachment = toAttachment(rows[0]!)
            // A staged upload has no subject yet; its AttachmentAdded is emitted
            // when a create claims it (fileProperties.claimStaged).
            if (staged) return attachment
            yield* events.append({
              subjectKind: "attachment",
              subjectId: attachment.id,
              eventType: "AttachmentAdded",
              payload: {
                _tag: "AttachmentAdded",
                attachmentId: attachment.id,
                filename: attachment.filename,
                ...ownerPayload(attachment),
              },
            })
            // A single-file property holds ONE live file: the new upload replaces
            // the old, which is archived (soft, restorable) rather than lost.
            if (field && !field.multiple) yield* displace(attachment)
            return attachment
          }),
        )

      const list = (filter: ListFilesFilter = {}) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // A widget may key by a record version row — resolve it to the lineage. A
          // dangling id reads as empty, not an error (the host may be purged).
          let recordId = filter.recordId
          if (!recordId && filter.recordVersionId) {
            const rows = yield* sql<{ readonly record_id: string }>`
            SELECT record_id FROM record_versions WHERE id = ${filter.recordVersionId} AND org_id = ${orgId} LIMIT 1`
            if (!rows[0]) return [] as Attachment[]
            recordId = rows[0].record_id
          }
          const liveOnly = filter.includeArchived ? sql`` : sql` AND a.archived_at IS NULL`
          const limit = Math.min(filter.limit ?? 500, 2000)
          const rows = recordId
            ? yield* sql<AttachmentRow>`
              SELECT a.* FROM attachments a
              WHERE a.org_id = ${orgId} AND a.record_id = ${recordId}${liveOnly}
              ORDER BY a.id DESC LIMIT ${limit}`
            : filter.bucketId
              ? // A widget's own bucket — the only scope that lists private files.
                yield* sql<AttachmentRow>`
                SELECT a.* FROM attachments a
                WHERE a.org_id = ${orgId} AND a.bucket_id = ${filter.bucketId}${liveOnly}
                ORDER BY a.id DESC LIMIT ${limit}`
              : filter.conceptId
                ? // The records JOIN excludes bucket files for free (record_id IS NULL).
                  yield* sql<AttachmentRow>`
                  SELECT a.* FROM attachments a
                  JOIN records it ON it.id = a.record_id
                  WHERE a.org_id = ${orgId} AND it.concept_id = ${filter.conceptId}${liveOnly}
                  ORDER BY a.id DESC LIMIT ${limit}`
                : // Org-wide: every record file, plus only the SHARED bucket files.
                  // Private buckets are visible solely through their own widget.
                  yield* sql<AttachmentRow>`
                  SELECT a.* FROM attachments a
                  WHERE a.org_id = ${orgId}
                    AND (a.bucket_id IS NULL OR a.bucket_shared)
                    AND a.staged_until IS NULL${liveOnly}
                  ORDER BY a.id DESC LIMIT ${limit}`
          return rows.map(toAttachment)
        })

      /** Private bucket files and STAGED uploads belong to their uploader alone:
       *  invisible (not forbidden — no existence oracle) to anyone else holding
       *  the id. Record files and shared buckets are member-reachable. */
      const hiddenFrom = (row: AttachmentRow, actor: string): boolean =>
        row.created_by !== actor &&
        ((!!row.bucket_id && !row.bucket_shared) || row.staged_until !== null)

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
          if (hiddenFrom(row, actor)) {
            return yield* Effect.fail(new AttachmentNotFound({ attachmentId }))
          }
          const attachment = toAttachment(row)
          const data = yield* blob.get(attachment.contentRef)
          return { attachment, data } as { attachment: Attachment; data: Uint8Array }
        })

      /** Metadata for one attachment, without fetching the blob — for resolving an
       *  `@` mention of a file to a label and a route. Applies `download`'s
       *  private-bucket rule; the CONCEPT-level read gate is the caller's job (an
       *  attachment carries no concept column, so it goes via its host lineage —
       *  the `listFiles` pattern). */
      const get = (attachmentId: Id) =>
        Effect.gen(function* () {
          const { actor } = yield* OrgContext
          const row = yield* load(attachmentId)
          if (hiddenFrom(row, actor)) {
            return yield* Effect.fail(new AttachmentNotFound({ attachmentId }))
          }
          return toAttachment(row)
        })

      const flipArchive = (attachmentId: Id, archived: boolean, eventType: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const before = toAttachment(yield* load(attachmentId))
            if (archived) yield* fp.assertNotLastRequired(sql, before)
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
            // Restoring into a single-file property brings it back AS the value —
            // the inverse of the replace that archived it — so the current one
            // is archived in turn. A property since archived/purged is left alone.
            if (!archived && attachment.recordId && attachment.fieldId) {
              const single = yield* sql<{ readonly id: string }>`
                SELECT id FROM fields
                WHERE org_id = ${orgId} AND id = ${attachment.fieldId} AND archived_at IS NULL
                  AND kind = 'file' AND COALESCE((config->>'multiple')::boolean, false) = false
                LIMIT 1`
              if (single[0]) yield* displace(attachment)
            }
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
              yield* fp.assertNotLastRequired(sql, toAttachment(row))
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

      /**
       * Move a RECORD file into a file property of the same record, out of one
       * (`fieldId` null → a loose Files-panel file), or between two. Bytes and
       * ownership never change — only which property presents the file. Moving
       * into a single-file property replaces its current value (archived).
       */
      const move = (attachmentId: Id, fieldId: Id | null) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* load(attachmentId)
            const current = toAttachment(row)
            if (!current.recordId)
              return yield* Effect.fail(
                new FieldValidationError({
                  message: "only a record's file can be a property value",
                }),
              )
            if (current.fieldId === fieldId) return current
            // Leaving a required property must not empty it.
            yield* fp.assertNotLastRequired(sql, current)
            const field = fieldId ? yield* fileProperty(current.recordId, fieldId) : null
            const position = field ? yield* nextPosition(current.recordId, field.id) : 0
            const rows = yield* sql<AttachmentRow>`
              UPDATE attachments SET field_id = ${field?.id ?? null}, position = ${position}
              WHERE org_id = ${orgId} AND id = ${attachmentId} RETURNING *`
            const moved = toAttachment(rows[0]!)
            yield* events.append({
              subjectKind: "attachment",
              subjectId: moved.id,
              eventType: "AttachmentMoved",
              payload: {
                _tag: "AttachmentMoved",
                attachmentId: moved.id,
                filename: moved.filename,
                subjectId: current.recordId,
                fieldId: moved.fieldId,
                fromFieldId: current.fieldId,
              },
            })
            if (field && !field.multiple && !moved.archivedAt) yield* displace(moved)
            return moved
          }),
        )

      /**
       * Set the display order of one property's files on one record. `ids` come
       * first, in the given order; any live file the caller didn't list (a
       * concurrent upload its view hadn't seen yet) keeps its relative order after
       * them, rather than failing the whole reorder. An id that is not a file of
       * this property is refused. Presentation only — no event, like field reorder.
       */
      const reorder = (recordId: Id, fieldId: Id, ids: ReadonlyArray<Id>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const rows = yield* sql<AttachmentRow>`
              SELECT * FROM attachments
              WHERE org_id = ${orgId} AND record_id = ${recordId} AND field_id = ${fieldId}
              ORDER BY position ASC, id ASC`
            const byId = new Map(rows.map((r) => [r.id, r] as const))
            for (const id of ids) {
              if (!byId.has(id))
                return yield* Effect.fail(new AttachmentNotFound({ attachmentId: id }))
            }
            const listed = new Set(ids)
            const order = [
              ...new Set(ids),
              ...rows.map((r) => r.id).filter((id) => !listed.has(id)),
            ]
            yield* Effect.forEach(
              order,
              (id, i) =>
                sql`UPDATE attachments SET position = ${i} WHERE org_id = ${orgId} AND id = ${id}`,
              { discard: true },
            )
            const out = yield* sql<AttachmentRow>`
              SELECT * FROM attachments
              WHERE org_id = ${orgId} AND record_id = ${recordId} AND field_id = ${fieldId}
              ORDER BY position ASC, id ASC`
            return out.map(toAttachment)
          }),
        )

      /**
       * Live property files for a set of records — the read-time value of every
       * file property on them, `recordId → fieldId → files` in position order.
       * Either a concept (one query for a whole `listRecords`, never N+1) or an
       * explicit record list. Loose files and archived files are not values.
       */
      const fieldFiles = (
        scope: { readonly conceptId: Id } | { readonly recordIds: ReadonlyArray<Id> },
      ) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows =
            "conceptId" in scope
              ? yield* sql<AttachmentRow>`
                SELECT a.* FROM attachments a
                JOIN records r ON r.id = a.record_id AND r.org_id = a.org_id
                WHERE a.org_id = ${orgId} AND r.concept_id = ${scope.conceptId}
                  AND a.field_id IS NOT NULL AND a.archived_at IS NULL
                ORDER BY a.position ASC, a.id ASC`
              : scope.recordIds.length === 0
                ? []
                : yield* sql<AttachmentRow>`
                SELECT a.* FROM attachments a
                WHERE a.org_id = ${orgId} AND ${sql.in("a.record_id", scope.recordIds)}
                  AND a.field_id IS NOT NULL AND a.archived_at IS NULL
                ORDER BY a.position ASC, a.id ASC`
          const index = new Map<Id, Map<Id, Attachment[]>>()
          for (const row of rows) {
            const a = toAttachment(row)
            let byField = index.get(a.recordId!)
            if (!byField) {
              byField = new Map()
              index.set(a.recordId!, byField)
            }
            const list = byField.get(a.fieldId!)
            if (list) list.push(a)
            else byField.set(a.fieldId!, [a])
          }
          return index as FieldFilesIndex
        })

      return {
        upload,
        move,
        reorder,
        fieldFiles,
        list,
        get,
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

/**
 * Remove STAGED uploads no create claimed before `staged_until` — rows and
 * blobs, across every org (a maintenance sweep, so no OrgContext). Rows go in
 * one statement; blobs after, best-effort, like `purge` (an orphan blob is
 * harmless, a dangling row would not be). No event: a staged file never had a
 * subject, so there is no feed it ever appeared in. Returns the count removed.
 */
export const sweepExpiredStaged = (now: Date = new Date()) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const blob = yield* BlobStore
    const rows = yield* sql<{ readonly content_ref: string }>`
      DELETE FROM attachments
      WHERE staged_until IS NOT NULL AND staged_until < ${now}
      RETURNING content_ref`
    yield* Effect.forEach(rows, (r) => blob.del(r.content_ref).pipe(Effect.ignore), {
      discard: true,
    })
    return rows.length
  })
