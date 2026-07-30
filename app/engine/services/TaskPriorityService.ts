import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { TaskPriority } from "../domain/types"
import { TaskPriorityInUse, TaskPriorityNameConflict, TaskPriorityNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type TaskPriorityRow, toTaskPriority } from "./rows"

export interface TaskPrioritySpec {
  readonly name: string
  readonly color?: string | null
}

/**
 * Per-org configurable task priorities. The `TaskStatusService` shape minus
 * category/default semantics: keyed by `id` (renameable `name`), ordered by
 * `position` (lower = more urgent), soft-deleted. A new task has NO priority
 * (`annotations.priority_id` null), so there is no default machinery. Definition
 * edits are admin-gated at the RPC boundary. `ensureDefaults` is the seed entry.
 */
export class TaskPriorityService extends Effect.Service<TaskPriorityService>()(
  "engine/TaskPriorityService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore

      const list = (
        opts: { readonly includeArchived?: boolean } = {},
      ): Effect.Effect<ReadonlyArray<TaskPriority>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
          const rows = yield* sql<TaskPriorityRow>`
            SELECT * FROM task_priorities WHERE org_id = ${orgId}${liveOnly}
            ORDER BY position ASC, name ASC`
          return rows.map(toTaskPriority)
        }).pipe(Effect.orDie)

      const getById = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<TaskPriorityRow>`
            SELECT * FROM task_priorities WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new TaskPriorityNotFound({ priorityId: id }))
          return toTaskPriority(row)
        })

      /** Reject a priority id that isn't live in this org (write-time validation). */
      const assertLive = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM task_priorities
            WHERE org_id = ${orgId} AND id = ${id} AND archived_at IS NULL LIMIT 1`
          if (!rows[0]) return yield* Effect.fail(new TaskPriorityNotFound({ priorityId: id }))
        })

      const create = (input: TaskPrioritySpec) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const name = input.name.trim()
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM task_priorities
              WHERE org_id = ${orgId} AND name = ${name} AND archived_at IS NULL LIMIT 1`
            if (existing[0]) return yield* Effect.fail(new TaskPriorityNameConflict({ name }))
            const max = yield* sql<{ readonly max: number | string | null }>`
              SELECT MAX(position) AS max FROM task_priorities WHERE org_id = ${orgId}`
            const position = Number(max[0]?.max ?? -1) + 1
            const rows = yield* sql<TaskPriorityRow>`
              INSERT INTO task_priorities (org_id, name, color, position)
              VALUES (${orgId}, ${name}, ${input.color ?? null}, ${position})
              RETURNING *`
            const priority = toTaskPriority(rows[0]!)
            yield* events.append({
              subjectKind: "taskPriority",
              subjectId: priority.id,
              eventType: "TaskPriorityCreated",
              payload: { _tag: "TaskPriorityCreated", name: priority.name },
            })
            return priority
          }),
        )

      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly color?: string | null
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const current = yield* getById(input.id)
            const name = input.name?.trim() || current.name
            const color = input.color === undefined ? current.color : input.color
            if (name !== current.name) {
              const clash = yield* sql<{ readonly id: string }>`
                SELECT id FROM task_priorities
                WHERE org_id = ${orgId} AND name = ${name} AND archived_at IS NULL AND id <> ${input.id}
                LIMIT 1`
              if (clash[0]) return yield* Effect.fail(new TaskPriorityNameConflict({ name }))
            }
            const rows = yield* sql<TaskPriorityRow>`
              UPDATE task_priorities SET name = ${name}, color = ${color}
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const priority = toTaskPriority(rows[0]!)
            yield* events.append({
              subjectKind: "taskPriority",
              subjectId: priority.id,
              eventType: "TaskPriorityUpdated",
              payload: { _tag: "TaskPriorityUpdated", name: priority.name },
            })
            return priority
          }),
        )

      /** Archive a priority (soft). Blocked while live tasks reference it. */
      const archive = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* getById(id)
            const counts = yield* sql<{ readonly count: number | string }>`
              SELECT COUNT(*)::int AS count FROM annotations
              WHERE org_id = ${orgId} AND type = 'task' AND priority_id = ${id} AND archived_at IS NULL`
            const taskCount = Number(counts[0]?.count ?? 0)
            if (taskCount > 0) {
              return yield* Effect.fail(new TaskPriorityInUse({ priorityId: id, taskCount }))
            }
            const rows = yield* sql<TaskPriorityRow>`
              UPDATE task_priorities SET archived_at = COALESCE(archived_at, now())
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "taskPriority",
              subjectId: id,
              eventType: "TaskPriorityArchived",
              payload: { _tag: "TaskPriorityArchived" },
            })
            return toTaskPriority(rows[0]!)
          }),
        )

      const restore = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const priority = yield* getById(id)
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM task_priorities
              WHERE org_id = ${orgId} AND name = ${priority.name} AND archived_at IS NULL AND id <> ${id}
              LIMIT 1`
            if (clash[0])
              return yield* Effect.fail(new TaskPriorityNameConflict({ name: priority.name }))
            const rows = yield* sql<TaskPriorityRow>`
              UPDATE task_priorities SET archived_at = NULL
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "taskPriority",
              subjectId: id,
              eventType: "TaskPriorityRestored",
              payload: { _tag: "TaskPriorityRestored" },
            })
            return toTaskPriority(rows[0]!)
          }),
        )

      const reorder = (orders: ReadonlyArray<{ readonly id: string; readonly position: number }>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* Effect.forEach(
              orders,
              (o) =>
                sql`UPDATE task_priorities SET position = ${o.position}
                  WHERE org_id = ${orgId} AND id = ${o.id}`,
            )
            yield* events.append({
              subjectKind: "taskPriority",
              subjectId: orders[0]?.id ?? "reorder",
              eventType: "TaskPriorityReordered",
              payload: { _tag: "TaskPriorityReordered" },
            })
            return yield* list({ includeArchived: true })
          }),
        )

      /** Idempotently seed a default priority set for the org (seed entry point) —
       *  a no-op if any priority already exists. */
      const ensureDefaults = (specs: ReadonlyArray<TaskPrioritySpec>) =>
        Effect.gen(function* () {
          const existing = yield* list({ includeArchived: true })
          if (existing.length > 0) return existing
          for (const spec of specs) yield* create(spec)
          return yield* list()
        })

      return {
        list,
        getById,
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
