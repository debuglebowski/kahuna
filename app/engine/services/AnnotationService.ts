import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { extractMentions, isUuid } from "../domain/mentions"
import {
  deriveRichText,
  isRichText,
  MAX_RICHTEXT_CHARS,
  type RichTextValue,
} from "../domain/richtext"
import { validateCustomFields } from "../domain/scalar"
import type { AnnotationType, EngineEvent } from "../domain/types"
import {
  AnnotationNotFound,
  FieldValidationError,
  RecordNotFound,
  VersionConflict,
} from "../errors"
import { AnnotationFieldService } from "./AnnotationFieldService"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AnnotationRow, type EventRow, toEvent, toNote, toTask } from "./rows"
import { TaskPriorityService } from "./TaskPriorityService"
import { TaskStatusService } from "./TaskStatusService"

export interface ListTasksFilter {
  readonly subjectId?: string | null
  readonly assignee?: string
  readonly statusId?: string
  readonly dueBefore?: string
  readonly dueAfter?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

/**
 * The annotation layer: notes + tasks that hang off an record (or, for
 * tasks, off nothing). CRUD-with-audit-events (the `LabelService` pattern): the
 * row is the source of truth and each mutation appends an `events` row for the
 * activity feed / live-sync — annotations are NOT folded projections. Their event
 * stream uses subject_kind "note"/"task" (subject_id = the annotation id), so they
 * never enter the record version reducer. Optimistic concurrency mirrors record_versions.
 */
export class AnnotationService extends Effect.Service<AnnotationService>()(
  "engine/AnnotationService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore
      const annotationFields = yield* AnnotationFieldService
      const statuses = yield* TaskStatusService
      const priorities = yield* TaskPriorityService

      // ── shared helpers ──────────────────────────────────────────────────────

      /** The annotated record must exist (when non-null). subjectId targets records.id. */
      const assertSubject = (subjectId: string | null) =>
        Effect.gen(function* () {
          if (subjectId === null) return
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM records WHERE org_id = ${orgId} AND id = ${subjectId} LIMIT 1`
          if (!rows[0]) return yield* Effect.fail(new RecordNotFound({ recordId: subjectId }))
        })

      const validateCustom = (type: AnnotationType, input: Record<string, unknown> | undefined) =>
        Effect.gen(function* () {
          if (!input || Object.keys(input).length === 0) return {} as Record<string, unknown>
          const defs = yield* annotationFields.list(type)
          return yield* validateCustomFields(defs, input)
        })

      const loadForUpdate = (id: string, type: AnnotationType) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AnnotationRow>`
            SELECT * FROM annotations
            WHERE org_id = ${orgId} AND id = ${id} AND type = ${type}
            FOR UPDATE`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AnnotationNotFound({ annotationId: id }))
          return row
        })

      const assertVersion = (row: AnnotationRow, expected: number) =>
        Number(row.version) === expected
          ? Effect.void
          : Effect.fail(
              new VersionConflict({
                recordVersionId: row.id,
                expected,
                actual: Number(row.version),
              }),
            )

      /** Shape-check + cap a description envelope, re-deriving its plain text
       *  server-side (the record version `richtext` rules). `null` clears. */
      const validateDescription = (
        v: unknown,
      ): Effect.Effect<RichTextValue | null, FieldValidationError> => {
        if (v === null) return Effect.succeed(null)
        if (!isRichText(v))
          return Effect.fail(
            new FieldValidationError({
              message: `description expects { doc, text } rich text`,
              field: "description",
            }),
          )
        if (JSON.stringify(v.doc).length > MAX_RICHTEXT_CHARS)
          return Effect.fail(
            new FieldValidationError({ message: `description is too large`, field: "description" }),
          )
        return Effect.succeed(deriveRichText(v))
      }

      /**
       * Rebuild the `mentions` index for one task's description. Same rebuild-not-
       * diff approach as the record version side (`RecordService.reindexRecordVersionMentions`);
       * a task has exactly one rich-text home, so there is no per-field dimension
       * and `from_field_id` stays null.
       */
      const reindexTaskMentions = (orgId: string, taskId: string, description: unknown) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM mentions WHERE org_id = ${orgId} AND from_annotation_id = ${taskId}`
          if (!isRichText(description)) return
          const refs = extractMentions(description.doc)
          if (refs.length === 0) return
          // A `record` mention whose target is gone indexes with a null
          // `target_record_id` rather than failing the save — see the record version copy.
          const candidates = [
            ...new Set(
              refs.filter((r) => r.kind === "record" && isUuid(r.targetId)).map((r) => r.targetId),
            ),
          ]
          const live = new Set<string>()
          if (candidates.length > 0) {
            const found = yield* sql<{ readonly id: string }>`
              SELECT id FROM records WHERE org_id = ${orgId} AND ${sql.in("id", candidates)}`
            for (const f of found) live.add(f.id)
          }
          for (const r of refs) {
            const targetRecordId = r.kind === "record" && live.has(r.targetId) ? r.targetId : null
            yield* sql`
              INSERT INTO mentions (org_id, from_annotation_id, kind, target_id, target_record_id)
              VALUES (${orgId}, ${taskId}, ${r.kind}, ${r.targetId}, ${targetRecordId})`
          }
        })

      /** Label ids are stored raw and resolved to live labels at read time
       *  (orphan-tolerant, mirroring record version `__labels`) — only shape-checked. */
      const coerceLabelIds = (v: ReadonlyArray<string>): ReadonlyArray<string> =>
        v.filter((id): id is string => typeof id === "string" && id.length > 0)

      const assertValidSnooze = (until: string | null) =>
        until !== null && Number.isNaN(Date.parse(until))
          ? Effect.fail(
              new FieldValidationError({
                message: `snoozedUntil expects an ISO date`,
                field: "snoozedUntil",
              }),
            )
          : Effect.void

      // ── notes ────────────────────────────────────────────────────────────────

      const getNote = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AnnotationRow>`
            SELECT * FROM annotations
            WHERE org_id = ${orgId} AND id = ${id} AND type = 'note' LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AnnotationNotFound({ annotationId: id }))
          return toNote(row)
        })

      const createNote = (input: {
        readonly subjectId: string | null
        readonly body: string
        readonly customFields?: Record<string, unknown>
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            yield* assertSubject(input.subjectId)
            const custom = yield* validateCustom("note", input.customFields)
            const subjectKind = input.subjectId === null ? null : "record"
            const rows = yield* sql<AnnotationRow>`
              INSERT INTO annotations (org_id, type, subject_id, subject_kind, body, created_by, custom_fields)
              VALUES (${orgId}, 'note', ${input.subjectId}, ${subjectKind}, ${input.body}, ${actor}, ${sql.json(custom)})
              RETURNING *`
            const note = toNote(rows[0]!)
            yield* events.append({
              subjectKind: "note",
              subjectId: note.id,
              eventType: "NoteCreated",
              payload: {
                _tag: "NoteCreated",
                subjectId: note.subjectId,
                body: note.body,
                customFields: note.customFields,
              },
            })
            return note
          }),
        )

      const updateNote = (input: {
        readonly id: string
        readonly expectedVersion: number
        readonly body?: string
        readonly customFields?: Record<string, unknown>
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(input.id, "note")
            yield* assertVersion(row, input.expectedVersion)
            const body = input.body ?? row.body ?? ""
            const customPatch = yield* validateCustom("note", input.customFields)
            const current = toNote(row)
            const custom =
              input.customFields === undefined
                ? current.customFields
                : { ...current.customFields, ...customPatch }
            const rows = yield* sql<AnnotationRow>`
              UPDATE annotations
              SET body = ${body}, custom_fields = ${sql.json(custom)},
                  version = version + 1, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const note = toNote(rows[0]!)
            yield* events.append({
              subjectKind: "note",
              subjectId: note.id,
              eventType: "NoteUpdated",
              payload: { _tag: "NoteUpdated", body: note.body, customFields: note.customFields },
            })
            return note
          }),
        )

      // ── tasks ────────────────────────────────────────────────────────────────

      const getTask = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AnnotationRow>`
            SELECT * FROM annotations
            WHERE org_id = ${orgId} AND id = ${id} AND type = 'task' LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AnnotationNotFound({ annotationId: id }))
          return toTask(row)
        })

      const createTask = (input: {
        readonly subjectId: string | null
        readonly title: string
        readonly description?: RichTextValue | null
        readonly statusId?: string | null
        readonly priorityId?: string | null
        readonly labelIds?: ReadonlyArray<string>
        readonly assignee?: string | null
        readonly dueAt?: string | null
        readonly customFields?: Record<string, unknown>
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            yield* assertSubject(input.subjectId)
            const statusId = input.statusId ?? (yield* statuses.defaultStatusId())
            if (statusId) yield* statuses.assertLive(statusId)
            if (input.priorityId) yield* priorities.assertLive(input.priorityId)
            const description = yield* validateDescription(input.description ?? null)
            const labelIds = coerceLabelIds(input.labelIds ?? [])
            const custom = yield* validateCustom("task", input.customFields)
            const subjectKind = input.subjectId === null ? null : "record"
            const dueAt = input.dueAt ?? null
            const rows = yield* sql<AnnotationRow>`
              INSERT INTO annotations
                (org_id, type, subject_id, subject_kind, title, description, status_id, priority_id, label_ids, assignee, due_at, created_by, custom_fields)
              VALUES
                (${orgId}, 'task', ${input.subjectId}, ${subjectKind}, ${input.title}, ${description ? sql.json(description) : null}, ${statusId}, ${input.priorityId ?? null}, ${JSON.stringify(labelIds)}, ${input.assignee ?? null}, ${dueAt}, ${actor}, ${sql.json(custom)})
              RETURNING *`
            const task = toTask(rows[0]!)
            yield* reindexTaskMentions(orgId, task.id, task.description)
            yield* events.append({
              subjectKind: "task",
              subjectId: task.id,
              eventType: "TaskCreated",
              payload: {
                _tag: "TaskCreated",
                subjectId: task.subjectId,
                title: task.title,
                statusId: task.statusId,
                assignee: task.assignee,
                dueAt: task.dueAt,
                customFields: task.customFields,
                priorityId: task.priorityId,
                labelIds: task.labelIds,
                hasDescription: task.description !== null,
              },
            })
            return task
          }),
        )

      const updateTask = (input: {
        readonly id: string
        readonly expectedVersion: number
        readonly title?: string
        readonly description?: RichTextValue | null
        readonly priorityId?: string | null
        readonly labelIds?: ReadonlyArray<string>
        readonly dueAt?: string | null
        readonly customFields?: Record<string, unknown>
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(input.id, "task")
            yield* assertVersion(row, input.expectedVersion)
            const current = toTask(row)
            const title = input.title ?? current.title
            const dueAt = input.dueAt === undefined ? current.dueAt : input.dueAt
            const description =
              input.description === undefined
                ? current.description
                : yield* validateDescription(input.description)
            if (input.priorityId) yield* priorities.assertLive(input.priorityId)
            const priorityId =
              input.priorityId === undefined ? current.priorityId : input.priorityId
            const labelIds =
              input.labelIds === undefined ? current.labelIds : coerceLabelIds(input.labelIds)
            const customPatch = yield* validateCustom("task", input.customFields)
            const custom =
              input.customFields === undefined
                ? current.customFields
                : { ...current.customFields, ...customPatch }
            const rows = yield* sql<AnnotationRow>`
              UPDATE annotations
              SET title = ${title}, due_at = ${dueAt}, custom_fields = ${sql.json(custom)},
                  description = ${description ? sql.json(description) : null},
                  -- A top-level array must be stringified: sql.json/raw params
                  -- serialize JS arrays as Postgres array literals, not JSON.
                  priority_id = ${priorityId}, label_ids = ${JSON.stringify(labelIds)},
                  version = version + 1, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const task = toTask(rows[0]!)
            // Unconditional: `description` above already resolved "undefined means
            // leave alone" to the value actually written, so re-deriving from the
            // persisted row is correct whether or not this update touched it.
            yield* reindexTaskMentions(orgId, task.id, task.description)
            yield* events.append({
              subjectKind: "task",
              subjectId: task.id,
              eventType: "TaskUpdated",
              payload: {
                _tag: "TaskUpdated",
                title: task.title,
                dueAt: task.dueAt,
                customFields: task.customFields,
                priorityId: task.priorityId,
                labelIds: task.labelIds,
                descriptionChanged: input.description !== undefined,
              },
            })
            return task
          }),
        )

      const setTaskStatus = (input: {
        readonly id: string
        readonly expectedVersion: number
        readonly statusId: string
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(input.id, "task")
            yield* assertVersion(row, input.expectedVersion)
            yield* statuses.assertLive(input.statusId)
            const from = row.status_id
            // completedAt keys off the `done` CATEGORY: set on entering, cleared
            // on leaving, kept across done→done moves. `cancelled` never sets it
            // (closed ≠ completed). An orphaned from-status counts as not-done.
            const toStatus = yield* statuses.getById(input.statusId)
            const fromCategory = from
              ? yield* statuses.getById(from).pipe(
                  Effect.map((s) => s.category),
                  Effect.catchAll(() => Effect.succeed(null)),
                )
              : null
            const completedAt =
              toStatus.category === "done"
                ? fromCategory === "done"
                  ? sql`completed_at`
                  : sql`now()`
                : sql`NULL`
            const rows = yield* sql<AnnotationRow>`
              UPDATE annotations
              SET status_id = ${input.statusId}, completed_at = ${completedAt},
                  version = version + 1, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const task = toTask(rows[0]!)
            yield* events.append({
              subjectKind: "task",
              subjectId: task.id,
              eventType: "TaskStatusChanged",
              payload: { _tag: "TaskStatusChanged", from, to: input.statusId },
            })
            return task
          }),
        )

      /** Snooze (hide from "open" lists until `until` passes — a read-time check,
       *  no sweeper) or unsnooze (`until` null). */
      const snoozeTask = (input: {
        readonly id: string
        readonly expectedVersion: number
        readonly until: string | null
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(input.id, "task")
            yield* assertVersion(row, input.expectedVersion)
            yield* assertValidSnooze(input.until)
            const rows = yield* sql<AnnotationRow>`
              UPDATE annotations SET snoozed_until = ${input.until}, version = version + 1, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const task = toTask(rows[0]!)
            yield* events.append({
              subjectKind: "task",
              subjectId: task.id,
              eventType: input.until ? "TaskSnoozed" : "TaskUnsnoozed",
              payload: input.until
                ? { _tag: "TaskSnoozed", until: input.until }
                : { _tag: "TaskUnsnoozed" },
            })
            return task
          }),
        )

      /** Block (with optional reason + optional pointer to the blocking task) or
       *  unblock (`blocked` null). The link is informational — no auto-unblock.
       *  Re-saving reason/link while already blocked keeps the original time. */
      const setTaskBlocked = (input: {
        readonly id: string
        readonly expectedVersion: number
        readonly blocked: null | {
          readonly reason?: string | null
          readonly taskId?: string | null
        }
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(input.id, "task")
            yield* assertVersion(row, input.expectedVersion)
            const reason = input.blocked?.reason?.trim() || null
            const taskId = input.blocked?.taskId || null
            if (taskId) {
              if (taskId === input.id)
                return yield* Effect.fail(
                  new FieldValidationError({
                    message: "a task cannot be blocked by itself",
                    field: "blockedByTaskId",
                  }),
                )
              const blocker = yield* sql<{ readonly id: string }>`
                SELECT id FROM annotations
                WHERE org_id = ${orgId} AND id = ${taskId} AND type = 'task' AND archived_at IS NULL
                LIMIT 1`
              if (!blocker[0])
                return yield* Effect.fail(new AnnotationNotFound({ annotationId: taskId }))
            }
            const blockedAt = input.blocked ? sql`COALESCE(blocked_at, now())` : sql`NULL`
            const rows = yield* sql<AnnotationRow>`
              UPDATE annotations
              SET blocked_at = ${blockedAt}, blocked_reason = ${input.blocked ? reason : null},
                  blocked_by_task_id = ${input.blocked ? taskId : null},
                  version = version + 1, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const task = toTask(rows[0]!)
            yield* events.append({
              subjectKind: "task",
              subjectId: task.id,
              eventType: input.blocked ? "TaskBlocked" : "TaskUnblocked",
              payload: input.blocked
                ? { _tag: "TaskBlocked", reason, taskId }
                : { _tag: "TaskUnblocked" },
            })
            return task
          }),
        )

      const assignTask = (input: {
        readonly id: string
        readonly expectedVersion: number
        readonly assignee: string | null
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(input.id, "task")
            yield* assertVersion(row, input.expectedVersion)
            const from = row.assignee
            const rows = yield* sql<AnnotationRow>`
              UPDATE annotations SET assignee = ${input.assignee}, version = version + 1, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const task = toTask(rows[0]!)
            yield* events.append({
              subjectKind: "task",
              subjectId: task.id,
              eventType: "TaskAssigned",
              payload: { _tag: "TaskAssigned", from, to: input.assignee },
            })
            return task
          }),
        )

      // ── archive / restore / purge ──────────────────────────────────────────────

      /** Flip archived_at on a row (bumping version), returning the updated row. */
      const flipArchive = (
        id: string,
        type: AnnotationType,
        expectedVersion: number,
        archived: boolean,
      ) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const row = yield* loadForUpdate(id, type)
          yield* assertVersion(row, expectedVersion)
          const archivedAt = archived ? sql`now()` : sql`NULL`
          const rows = yield* sql<AnnotationRow>`
            UPDATE annotations SET archived_at = ${archivedAt}, version = version + 1, updated_at = now()
            WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          return rows[0]!
        })

      const archiveNote = (id: string, expectedVersion: number) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* flipArchive(id, "note", expectedVersion, true)
            yield* events.append({
              subjectKind: "note",
              subjectId: id,
              eventType: "NoteArchived",
              payload: { _tag: "NoteArchived", subjectId: row.subject_id },
            })
            return toNote(row)
          }),
        )

      const restoreNote = (id: string, expectedVersion: number) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* flipArchive(id, "note", expectedVersion, false)
            yield* events.append({
              subjectKind: "note",
              subjectId: id,
              eventType: "NoteRestored",
              payload: { _tag: "NoteRestored", subjectId: row.subject_id },
            })
            return toNote(row)
          }),
        )

      const archiveTask = (id: string, expectedVersion: number) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* flipArchive(id, "task", expectedVersion, true)
            yield* events.append({
              subjectKind: "task",
              subjectId: id,
              eventType: "TaskArchived",
              payload: { _tag: "TaskArchived", subjectId: row.subject_id },
            })
            return toTask(row)
          }),
        )

      const restoreTask = (id: string, expectedVersion: number) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* flipArchive(id, "task", expectedVersion, false)
            yield* events.append({
              subjectKind: "task",
              subjectId: id,
              eventType: "TaskRestored",
              payload: { _tag: "TaskRestored", subjectId: row.subject_id },
            })
            return toTask(row)
          }),
        )

      const purgeNote = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(id, "note")
            yield* sql`DELETE FROM annotations WHERE org_id = ${orgId} AND id = ${id}`
            yield* events.append({
              subjectKind: "note",
              subjectId: id,
              eventType: "NotePurged",
              payload: { _tag: "NotePurged", subjectId: row.subject_id },
            })
            return toNote(row)
          }),
        )

      const purgeTask = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* loadForUpdate(id, "task")
            // Mention rows FK into `annotations`.
            yield* sql`DELETE FROM mentions WHERE org_id = ${orgId} AND from_annotation_id = ${id}`
            yield* sql`DELETE FROM annotations WHERE org_id = ${orgId} AND id = ${id}`
            yield* events.append({
              subjectKind: "task",
              subjectId: id,
              eventType: "TaskPurged",
              payload: { _tag: "TaskPurged", subjectId: row.subject_id },
            })
            return toTask(row)
          }),
        )

      // ── reads ──────────────────────────────────────────────────────────────────

      /** A subject's notes/tasks (per-record panel). subjectId = record id. */
      const listForSubject = (
        subjectId: string,
        opts: { readonly type?: AnnotationType; readonly includeArchived?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
          const typeFilter = opts.type ? sql` AND type = ${opts.type}` : sql``
          const rows = yield* sql<AnnotationRow>`
            SELECT * FROM annotations
            WHERE org_id = ${orgId} AND subject_id = ${subjectId}${typeFilter}${liveOnly}
            ORDER BY id DESC`
          return rows.map((r) => (r.type === "note" ? toNote(r) : toTask(r)))
        }).pipe(Effect.orDie)

      const listNotes = (subjectId: string, opts: { readonly includeArchived?: boolean } = {}) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
          const rows = yield* sql<AnnotationRow>`
            SELECT * FROM annotations
            WHERE org_id = ${orgId} AND type = 'note' AND subject_id = ${subjectId}${liveOnly}
            ORDER BY id DESC`
          return rows.map(toNote)
        }).pipe(Effect.orDie)

      /** Tasks, filterable — powers both the per-record panel (subjectId set) and the
       *  global "My Tasks" view (assignee/status/due). */
      const listTasks = (filter: ListTasksFilter = {}) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const clauses = [sql`org_id = ${orgId}`, sql`type = 'task'`]
          if (filter.subjectId !== undefined) {
            clauses.push(
              filter.subjectId === null
                ? sql`subject_id IS NULL`
                : sql`subject_id = ${filter.subjectId}`,
            )
          }
          if (filter.assignee !== undefined) clauses.push(sql`assignee = ${filter.assignee}`)
          if (filter.statusId !== undefined) clauses.push(sql`status_id = ${filter.statusId}`)
          if (filter.dueBefore !== undefined) clauses.push(sql`due_at <= ${filter.dueBefore}`)
          if (filter.dueAfter !== undefined) clauses.push(sql`due_at >= ${filter.dueAfter}`)
          if (!filter.includeArchived) clauses.push(sql`archived_at IS NULL`)
          const where = clauses.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))
          const limit = filter.limit ?? 500
          const rows = yield* sql<AnnotationRow>`
            SELECT * FROM annotations WHERE ${where}
            ORDER BY due_at ASC NULLS LAST, id DESC LIMIT ${limit}`
          return rows.map(toTask)
        }).pipe(Effect.orDie)

      /**
       * The per-record activity feed: a union of (a) the lineage's own record version/record
       * events and (b) its annotations' note/task/attachment events (incl. purge
       * tombstones, matched via the payload's host id once the row is gone).
       * `subjectId` = the record id. Newest first.
       */
      const readActivityForSubject = (
        subjectId: string,
        opts: { readonly limit?: number } = {},
      ): Effect.Effect<ReadonlyArray<EngineEvent>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const limit = opts.limit ?? 100
          // On a versioned concept, opening a new version emits its own
          // `RecordVersionCreated`; relabel those (version_seq > 1) to a synthetic
          // `VersionCreated` so the feed reads "started a new version" instead of a
          // second "created this record". The first version (seq 1) stays the create.
          const rows = yield* sql<EventRow>`
            SELECT
              e.id, e.org_id, e.occurred_at, e.actor, e.subject_kind, e.subject_id,
              CASE
                WHEN e.subject_kind = 'recordVersion' AND e.event_type = 'RecordVersionCreated'
                     AND i.version_seq > 1 THEN 'VersionCreated'
                ELSE e.event_type
              END AS event_type,
              e.payload
            FROM events e
            LEFT JOIN record_versions i ON i.id = e.subject_id AND e.subject_kind = 'recordVersion'
            WHERE e.org_id = ${orgId}
              AND (
                (e.subject_kind IN ('recordVersion', 'record') AND e.subject_id IN (
                  SELECT id FROM record_versions WHERE org_id = ${orgId} AND record_id = ${subjectId}
                  UNION SELECT ${subjectId}
                ))
                OR (e.subject_kind IN ('note', 'task') AND (
                  e.subject_id IN (
                    SELECT id FROM annotations WHERE org_id = ${orgId} AND subject_id = ${subjectId}
                  )
                  OR e.payload->>'subjectId' = ${subjectId}
                ))
                OR (e.subject_kind = 'attachment' AND (
                  e.subject_id IN (
                    SELECT id FROM attachments WHERE org_id = ${orgId} AND record_id = ${subjectId}
                  )
                  OR e.payload->>'subjectId' = ${subjectId}
                ))
              )
            ORDER BY e.id DESC
            LIMIT ${limit}`
          return rows.map(toEvent)
        }).pipe(Effect.orDie)

      return {
        // notes
        getNote,
        createNote,
        updateNote,
        archiveNote,
        restoreNote,
        purgeNote,
        // tasks
        getTask,
        createTask,
        updateTask,
        setTaskStatus,
        assignTask,
        snoozeTask,
        setTaskBlocked,
        archiveTask,
        restoreTask,
        purgeTask,
        // reads
        listForSubject,
        listNotes,
        listTasks,
        readActivityForSubject,
      } as const
    }),
    dependencies: [
      EventStore.Default,
      AnnotationFieldService.Default,
      TaskStatusService.Default,
      TaskPriorityService.Default,
    ],
  },
) {}
