import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { BlobStore } from "../blob/BlobStore"
import type { Attachment, Id } from "../domain/types"
import { AttachmentNotFound, InstanceNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AttachmentRow, toAttachment } from "./rows"

export interface UploadInput {
  readonly instanceId: Id
  readonly filename: string
  readonly mimeType?: string
  readonly data: Uint8Array
}

/**
 * Files on instances (Artifacts). Bytes go to the BlobStore; metadata is an
 * org-scoped row + an `AttachmentAdded` event on the instance's stream.
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
            const { orgId } = yield* OrgContext
            const owner = yield* sql<{ readonly id: string }>`
            SELECT id FROM instances
            WHERE id = ${input.instanceId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
            if (!owner[0])
              return yield* Effect.fail(new InstanceNotFound({ instanceId: input.instanceId }))

            const key = `${orgId}/${randomUUID()}`
            yield* blob.put(key, input.data, input.mimeType)
            const rows = yield* sql<AttachmentRow>`
            INSERT INTO attachments (org_id, instance_id, filename, content_ref, mime_type, size_bytes)
            VALUES (${orgId}, ${input.instanceId}, ${input.filename}, ${key}, ${input.mimeType ?? null}, ${input.data.length})
            RETURNING *`
            const attachment = toAttachment(rows[0]!)
            yield* events.append({
              subjectKind: "instance",
              subjectId: input.instanceId,
              eventType: "AttachmentAdded",
              payload: {
                _tag: "AttachmentAdded",
                attachmentId: attachment.id,
                filename: attachment.filename,
              },
            })
            return attachment
          }),
        )

      const list = (instanceId: Id) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AttachmentRow>`
          SELECT * FROM attachments
          WHERE org_id = ${orgId} AND instance_id = ${instanceId} ORDER BY created_at ASC`
          return rows.map(toAttachment)
        })

      const download = (attachmentId: Id) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AttachmentRow>`
          SELECT * FROM attachments WHERE id = ${attachmentId} AND org_id = ${orgId} LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AttachmentNotFound({ attachmentId }))
          const attachment = toAttachment(row)
          const data = yield* blob.get(attachment.contentRef)
          return { attachment, data } as { attachment: Attachment; data: Uint8Array }
        })

      return { upload, list, download } as const
    }),
    dependencies: [EventStore.Default],
  },
) {}
