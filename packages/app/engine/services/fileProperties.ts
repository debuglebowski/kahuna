import type { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Attachment, Field, Id } from "../domain/types"
import { AttachmentNotFound, FieldNotFound, FieldValidationError } from "../errors"
import type { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AttachmentRow, toAttachment } from "./rows"

/**
 * File-property SQL shared by AttachmentService (upload / move / archive) and
 * RecordService (claiming staged files inside the create transaction, and the
 * `required` checks at create and publish).
 *
 * Plain functions taking `sql` + `events` rather than a service: RecordService
 * must run these INSIDE its own transaction, and depending on AttachmentService
 * would drag the blob store into every RecordService consumer for no reason —
 * nothing here touches bytes.
 */

type Sql = PgClient.PgClient

/** How long an upload may wait for its record before the sweep removes it. */
export const STAGED_TTL_HOURS = 24

/** A resolved file property. */
export interface FilePropertyDef {
  readonly id: Id
  readonly name: string
  readonly multiple: boolean
  readonly required: boolean
}

/** The owner half of an attachment event payload — `subjectId` (host record, so
 *  the per-record feed matches) or `bucketId`, never both — plus the file
 *  property when the file is one's value. */
export const ownerPayload = (a: Attachment) => ({
  ...(a.recordId ? { subjectId: a.recordId } : a.bucketId ? { bucketId: a.bucketId } : {}),
  ...(a.fieldId ? { fieldId: a.fieldId } : {}),
})

/**
 * Resolve `fieldId` as a file property of `recordId`'s concept: live, kind
 * `file`, and not integration-managed (a synced field is the connector's to fill —
 * the same read-only rule managed fields carry everywhere else). Any mismatch is
 * an error, never a silent loose upload: the caller named a property and must not
 * get a file somewhere else.
 */
export const resolveFileProperty = (sql: Sql, recordId: Id, fieldId: Id) =>
  Effect.gen(function* () {
    const { orgId } = yield* OrgContext
    const rows = yield* sql<{
      readonly id: string
      readonly name: string
      readonly kind: string
      readonly config: { readonly multiple?: boolean; readonly requirement?: string } | null
      readonly managed_by: string | null
      readonly archived_at: Date | null
      readonly same_concept: boolean
    }>`
      SELECT f.id, f.name, f.kind, f.config, f.managed_by, f.archived_at,
             (f.concept_id = r.concept_id) AS same_concept
      FROM fields f
      JOIN records r ON r.id = ${recordId} AND r.org_id = f.org_id
      WHERE f.org_id = ${orgId} AND f.id = ${fieldId} LIMIT 1`
    const f = rows[0]
    if (!f?.same_concept || f.archived_at) return yield* Effect.fail(new FieldNotFound({ fieldId }))
    const fail = (message: string) =>
      Effect.fail(new FieldValidationError({ message, field: f.name }))
    if (f.kind !== "file") return yield* fail(`field "${f.name}" is not a file property`)
    if (f.managed_by)
      return yield* fail(`field "${f.name}" is synced by an integration and read-only`)
    return {
      id: f.id,
      name: f.name,
      multiple: !!f.config?.multiple,
      required: f.config?.requirement === "required",
    } satisfies FilePropertyDef
  })

/** Append position for a new value of one property (max + 1; 0 when empty). */
export const nextPosition = (sql: Sql, recordId: Id, fieldId: Id) =>
  Effect.gen(function* () {
    const { orgId } = yield* OrgContext
    const rows = yield* sql<{ readonly max: number | string | null }>`
      SELECT MAX(position) AS max FROM attachments
      WHERE org_id = ${orgId} AND record_id = ${recordId} AND field_id = ${fieldId}`
    return Number(rows[0]?.max ?? -1) + 1
  })

/** Archive every OTHER live file in `keep`'s property — the single-file replace.
 *  One AttachmentArchived each, so the feed explains where they went. */
export const displace = (sql: Sql, events: EventStore, keep: Attachment) =>
  Effect.gen(function* () {
    const { orgId } = yield* OrgContext
    const rows = yield* sql<AttachmentRow>`
      UPDATE attachments SET archived_at = now()
      WHERE org_id = ${orgId} AND record_id = ${keep.recordId} AND field_id = ${keep.fieldId}
        AND id <> ${keep.id} AND archived_at IS NULL
      RETURNING *`
    for (const row of rows) {
      const a = toAttachment(row)
      yield* events.append({
        subjectKind: "attachment",
        subjectId: a.id,
        eventType: "AttachmentArchived",
        payload: {
          _tag: "AttachmentArchived",
          attachmentId: a.id,
          filename: a.filename,
          ...ownerPayload(a),
        },
      })
    }
  })

/** Live files per file property of one record — `fieldId → count`. */
export const liveFileCounts = (sql: Sql, recordId: Id) =>
  Effect.gen(function* () {
    const { orgId } = yield* OrgContext
    const rows = yield* sql<{ readonly field_id: string; readonly n: number | string }>`
      SELECT field_id, COUNT(*)::int AS n FROM attachments
      WHERE org_id = ${orgId} AND record_id = ${recordId}
        AND field_id IS NOT NULL AND archived_at IS NULL
      GROUP BY field_id`
    return new Map(rows.map((r) => [r.field_id, Number(r.n)] as const))
  })

/**
 * Refuse taking away the LAST live file of a `required` file property — the
 * file-property form of "a required value can never be cleared" (scalars enforce
 * it on update). Called before archive, purge, and a move out of the property.
 * A single-file REPLACE never comes here: the new file is the value.
 */
export const assertNotLastRequired = (sql: Sql, a: Attachment) =>
  Effect.gen(function* () {
    if (!a.recordId || !a.fieldId || a.archivedAt) return
    const { orgId } = yield* OrgContext
    const rows = yield* sql<{ readonly name: string; readonly n: number | string }>`
      SELECT f.name,
        (SELECT COUNT(*)::int FROM attachments x
         WHERE x.org_id = ${orgId} AND x.record_id = ${a.recordId} AND x.field_id = f.id
           AND x.archived_at IS NULL) AS n
      FROM fields f
      WHERE f.org_id = ${orgId} AND f.id = ${a.fieldId} AND f.archived_at IS NULL
        AND f.config->>'requirement' = 'required'`
    const f = rows[0]
    if (f && Number(f.n) <= 1)
      return yield* Effect.fail(
        new FieldValidationError({
          message: `field "${f.name}" is required — add another file before removing this one`,
          field: f.name,
        }),
      )
  })

/**
 * Attach STAGED uploads to a just-created record, inside the caller's
 * transaction: `files` is `fieldId → staged attachment ids` in display order.
 * Every id must be a live, unexpired upload staged by THIS actor — anything else
 * reads as not found (another member's staged file is invisible, not forbidden).
 * A single-file property takes at most one. Emits AttachmentAdded per file, now
 * that it has a subject.
 */
export const claimStaged = (
  sql: Sql,
  events: EventStore,
  recordId: Id,
  defs: ReadonlyArray<Field>,
  files: Readonly<Record<string, ReadonlyArray<Id>>>,
) =>
  Effect.gen(function* () {
    const { orgId, actor } = yield* OrgContext
    const byId = new Map(defs.map((d) => [d.id, d] as const))
    const seen = new Set<Id>()
    for (const [fieldId, ids] of Object.entries(files)) {
      const def = byId.get(fieldId)
      if (!def) return yield* Effect.fail(new FieldNotFound({ fieldId }))
      if (ids.length === 0) continue
      const field = yield* resolveFileProperty(sql, recordId, fieldId)
      if (!field.multiple && ids.length > 1)
        return yield* Effect.fail(
          new FieldValidationError({
            message: `field "${field.name}" takes one file`,
            field: field.name,
          }),
        )
      for (const [position, id] of ids.entries()) {
        if (seen.has(id)) return yield* Effect.fail(new AttachmentNotFound({ attachmentId: id }))
        seen.add(id)
        const rows = yield* sql<AttachmentRow>`
          UPDATE attachments
          SET record_id = ${recordId}, field_id = ${field.id}, position = ${position}, staged_until = NULL
          WHERE org_id = ${orgId} AND id = ${id} AND created_by = ${actor}
            AND staged_until IS NOT NULL AND staged_until > now() AND archived_at IS NULL
          RETURNING *`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new AttachmentNotFound({ attachmentId: id }))
        const a = toAttachment(row)
        yield* events.append({
          subjectKind: "attachment",
          subjectId: a.id,
          eventType: "AttachmentAdded",
          payload: {
            _tag: "AttachmentAdded",
            attachmentId: a.id,
            filename: a.filename,
            ...ownerPayload(a),
          },
        })
      }
    }
  })
