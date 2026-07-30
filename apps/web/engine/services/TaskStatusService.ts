import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { TaskStatus, TaskStatusCategory } from "../domain/types"
import { TaskStatusInUse, TaskStatusNameConflict, TaskStatusNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type TaskStatusRow, toTaskStatus } from "./rows"

export interface TaskStatusSpec {
  readonly name: string
  readonly category: TaskStatusCategory
  readonly color?: string | null
  readonly isDefault?: boolean
}

/**
 * Per-org configurable task statuses. Keyed by `id` (renameable `name`);
 * `category` carries completion/grouping semantics so nothing keys off the name.
 * Exactly one live status is `isDefault` (applied to new tasks). Definition edits
 * are admin-gated at the RPC boundary. `ensureDefaults` is the seed entry point.
 */
export class TaskStatusService extends Effect.Service<TaskStatusService>()(
  "engine/TaskStatusService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore

      const list = (
        opts: { readonly includeArchived?: boolean } = {},
      ): Effect.Effect<ReadonlyArray<TaskStatus>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
          const rows = yield* sql<TaskStatusRow>`
            SELECT * FROM task_statuses WHERE org_id = ${orgId}${liveOnly}
            ORDER BY position ASC, name ASC`
          return rows.map(toTaskStatus)
        }).pipe(Effect.orDie)

      const getById = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<TaskStatusRow>`
            SELECT * FROM task_statuses WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new TaskStatusNotFound({ statusId: id }))
          return toTaskStatus(row)
        })

      /** The id of the org's live default status (falls back to lowest-position). */
      const defaultStatusId = (): Effect.Effect<string | null, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM task_statuses
            WHERE org_id = ${orgId} AND archived_at IS NULL
            ORDER BY is_default DESC, position ASC, name ASC LIMIT 1`
          return rows[0]?.id ?? null
        }).pipe(Effect.orDie)

      /** Reject a status id that isn't live in this org (write-time validation). */
      const assertLive = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM task_statuses
            WHERE org_id = ${orgId} AND id = ${id} AND archived_at IS NULL LIMIT 1`
          if (!rows[0]) return yield* Effect.fail(new TaskStatusNotFound({ statusId: id }))
        })

      const clearDefault = () =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* sql`UPDATE task_statuses SET is_default = false
            WHERE org_id = ${orgId} AND is_default = true`
        })

      const create = (input: TaskStatusSpec) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const name = input.name.trim()
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM task_statuses
              WHERE org_id = ${orgId} AND name = ${name} AND archived_at IS NULL LIMIT 1`
            if (existing[0]) return yield* Effect.fail(new TaskStatusNameConflict({ name }))
            if (input.isDefault) yield* clearDefault()
            const max = yield* sql<{ readonly max: number | string | null }>`
              SELECT MAX(position) AS max FROM task_statuses WHERE org_id = ${orgId}`
            const position = Number(max[0]?.max ?? -1) + 1
            const rows = yield* sql<TaskStatusRow>`
              INSERT INTO task_statuses (org_id, name, color, category, is_default, position)
              VALUES (${orgId}, ${name}, ${input.color ?? null}, ${input.category}, ${input.isDefault ?? false}, ${position})
              RETURNING *`
            const status = toTaskStatus(rows[0]!)
            yield* events.append({
              subjectKind: "taskStatus",
              subjectId: status.id,
              eventType: "TaskStatusCreated",
              payload: { _tag: "TaskStatusCreated", name: status.name, category: status.category },
            })
            return status
          }),
        )

      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly color?: string | null
        readonly category?: TaskStatusCategory
        readonly isDefault?: boolean
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const current = yield* getById(input.id)
            const name = input.name?.trim() || current.name
            const color = input.color === undefined ? current.color : input.color
            const category = input.category ?? current.category
            const isDefault = input.isDefault ?? current.isDefault
            if (name !== current.name) {
              const clash = yield* sql<{ readonly id: string }>`
                SELECT id FROM task_statuses
                WHERE org_id = ${orgId} AND name = ${name} AND archived_at IS NULL AND id <> ${input.id}
                LIMIT 1`
              if (clash[0]) return yield* Effect.fail(new TaskStatusNameConflict({ name }))
            }
            // Promoting to default demotes the previous default; we never allow
            // un-setting the only default by edit (a new default must be chosen).
            if (isDefault && !current.isDefault) yield* clearDefault()
            const rows = yield* sql<TaskStatusRow>`
              UPDATE task_statuses
              SET name = ${name}, color = ${color}, category = ${category},
                  is_default = ${isDefault || (current.isDefault && input.isDefault === undefined)}
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const status = toTaskStatus(rows[0]!)
            yield* events.append({
              subjectKind: "taskStatus",
              subjectId: status.id,
              eventType: "TaskStatusUpdated",
              payload: { _tag: "TaskStatusUpdated", name: status.name, category: status.category },
            })
            return status
          }),
        )

      /** Archive a status (soft). Blocked while live tasks reference it, or if it
       *  is the default, or the last live status in its category — so a task can
       *  always resolve a status and a new task always has a default. */
      const archive = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const status = yield* getById(id)
            if (status.isDefault) {
              return yield* Effect.fail(
                new TaskStatusInUse({ statusId: id, taskCount: 0, reason: "default" }),
              )
            }
            const counts = yield* sql<{ readonly count: number | string }>`
              SELECT COUNT(*)::int AS count FROM annotations
              WHERE org_id = ${orgId} AND type = 'task' AND status_id = ${id} AND archived_at IS NULL`
            const taskCount = Number(counts[0]?.count ?? 0)
            if (taskCount > 0) {
              return yield* Effect.fail(
                new TaskStatusInUse({ statusId: id, taskCount, reason: "tasks" }),
              )
            }
            const sameCat = yield* sql<{ readonly count: number | string }>`
              SELECT COUNT(*)::int AS count FROM task_statuses
              WHERE org_id = ${orgId} AND category = ${status.category}
                AND archived_at IS NULL AND id <> ${id}`
            if (Number(sameCat[0]?.count ?? 0) === 0) {
              return yield* Effect.fail(
                new TaskStatusInUse({ statusId: id, taskCount: 0, reason: "last-in-category" }),
              )
            }
            const rows = yield* sql<TaskStatusRow>`
              UPDATE task_statuses SET archived_at = COALESCE(archived_at, now())
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "taskStatus",
              subjectId: id,
              eventType: "TaskStatusArchived",
              payload: { _tag: "TaskStatusArchived" },
            })
            return toTaskStatus(rows[0]!)
          }),
        )

      const restore = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const status = yield* getById(id)
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM task_statuses
              WHERE org_id = ${orgId} AND name = ${status.name} AND archived_at IS NULL AND id <> ${id}
              LIMIT 1`
            if (clash[0])
              return yield* Effect.fail(new TaskStatusNameConflict({ name: status.name }))
            const rows = yield* sql<TaskStatusRow>`
              UPDATE task_statuses SET archived_at = NULL
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "taskStatus",
              subjectId: id,
              eventType: "TaskStatusRestored",
              payload: { _tag: "TaskStatusRestored" },
            })
            return toTaskStatus(rows[0]!)
          }),
        )

      const reorder = (orders: ReadonlyArray<{ readonly id: string; readonly position: number }>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* Effect.forEach(
              orders,
              (o) =>
                sql`UPDATE task_statuses SET position = ${o.position}
                  WHERE org_id = ${orgId} AND id = ${o.id}`,
            )
            yield* events.append({
              subjectKind: "taskStatus",
              subjectId: orders[0]?.id ?? "reorder",
              eventType: "TaskStatusReordered",
              payload: { _tag: "TaskStatusReordered" },
            })
            return yield* list({ includeArchived: true })
          }),
        )

      /** Idempotently seed a default status set for the org (seed entry point) —
       *  a no-op if any status already exists. */
      const ensureDefaults = (specs: ReadonlyArray<TaskStatusSpec>) =>
        Effect.gen(function* () {
          const existing = yield* list({ includeArchived: true })
          if (existing.length > 0) return existing
          for (const spec of specs) yield* create(spec)
          return yield* list()
        })

      return {
        list,
        getById,
        defaultStatusId,
        assertLive,
        create,
        update,
        archive,
        restore,
        reorder,
        ensureDefaults,
      } as const
    }),
    dependencies: [EventStore.Default],
  },
) {}
