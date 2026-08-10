import type { Task, TaskStatus } from "@alltinghq/contract"
import { requireSession } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation, withVersion } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Tasks are global AND record-scoped: `listTasks` takes an optional subject, so
 * `--record` is a filter rather than a different noun. THE SUBJECT IS THE
 * LINEAGE id (the `record` column of `allt record list`), not the version id —
 * an annotation belongs to the record, not to one version of it. `task status` and
 * `task priority` are the catalogues those tasks point at — sub-nouns, because
 * they belong to tasks and to nothing else.
 */
const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const findStatus = (statuses: ReadonlyArray<TaskStatus>, name: string): TaskStatus => {
  const n = name.trim().toLowerCase()
  const exact =
    statuses.find((s) => s.id === name) ?? statuses.find((s) => s.name.toLowerCase() === n)
  if (exact) return exact
  const partial = statuses.filter((s) => s.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${name}" matches ${partial.length} statuses.`
      : `No status named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    `Statuses: ${statuses.map((s) => s.name).join(", ")}`,
  )
}

const taskRow = (t: Task, statuses: ReadonlyArray<TaskStatus>): Record<string, unknown> => ({
  id: t.id,
  title: t.title,
  status: statuses.find((s) => s.id === t.statusId)?.name ?? "",
  assignee: t.assignee ?? "",
  due: t.dueAt ?? "",
  snoozed: t.snoozedUntil ?? "",
  record: t.subjectId ?? "",
})

export const taskCommands: ReadonlyArray<Command> = [
  {
    path: "task list",
    summary: "List tasks — yours, a record's, or everyone's",
    usage:
      "task list [--record <id>] [--assignee <user>] [--status <name>] [--archived] [--limit n]",
    options: {
      record: { type: "string" },
      assignee: { type: "string" },
      status: { type: "string" },
      archived: { type: "boolean" },
      limit: { type: "string" },
    },
    run: async (ctx) => {
      await withApi(async (api) => {
        const statuses = await api.call((c) => c.listTaskStatuses({}))
        const statusId = ctx.flags.status
          ? findStatus(statuses, ctx.flags.status as string).id
          : undefined
        const tasks = await api.call((c) =>
          c.listTasks({
            subjectId: ctx.flags.record as string | undefined,
            assignee: ctx.flags.assignee as string | undefined,
            statusId,
            includeArchived: Boolean(ctx.flags.archived),
            limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
          }),
        )
        printRows(
          ctx.format,
          tasks.map((t) => taskRow(t, statuses)),
          ["id", "title", "status", "assignee", "due", "snoozed", "record"],
        )
      })
    },
  },
  {
    path: "task create",
    summary: "Create a task, optionally on a record",
    usage:
      "task create <title> [--record <id>] [--status <name>] [--assignee <user>] [--due <date>]",
    options: {
      record: { type: "string" },
      status: { type: "string" },
      assignee: { type: "string" },
      due: { type: "string" },
    },
    run: async (ctx) => {
      const title = ctx.args.join(" ")
      if (!title) throw new CliError("A title is required.", EXIT.usage)
      await withApi(async (api) => {
        const statuses = await api.call((c) => c.listTaskStatuses({}))
        const statusId = ctx.flags.status
          ? findStatus(statuses, ctx.flags.status as string).id
          : undefined
        if (ctx.flags["dry-run"]) {
          note(`Would create task "${title}".`)
          return
        }
        const task = await api.call((c) =>
          c.createTask({
            // null, not undefined: a task with no subject is an ORG-LEVEL task,
            // which is a real thing here, not a missing value.
            subjectId: (ctx.flags.record as string | undefined) ?? null,
            title,
            statusId,
            assignee: (ctx.flags.assignee as string | undefined) ?? null,
            dueAt: (ctx.flags.due as string | undefined) ?? null,
          }),
        )
        note(`Created task "${task.title}" (${task.id}).`)
      })
    },
  },
  {
    path: "task update",
    summary: "Change a task's title, status, assignee, due date or snooze",
    usage:
      "task update <id> [--title <t>] [--status <name>] [--assignee <user|none>] [--due <date|none>] [--snooze <date|none>]",
    options: {
      title: { type: "string" },
      status: { type: "string" },
      assignee: { type: "string" },
      due: { type: "string" },
      snooze: { type: "string" },
    },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which task?", EXIT.usage)
      await withApi(async (api) => {
        const statuses = await api.call((c) => c.listTaskStatuses({}))
        const current = await currentTask(api, id)

        if (ctx.flags["dry-run"]) {
          note(`Would update task "${current.title}".`)
          return
        }

        // FOUR separate procedures — updateTask, setTaskStatus, assignTask,
        // snoozeTask — each taking its own expectedVersion, and each BUMPING it.
        // So they run in sequence and re-read between, which is exactly what
        // withVersion does; batching them would fail on the second call.
        const read = async () => await currentTask(api, id)

        if (ctx.flags.title !== undefined || ctx.flags.due !== undefined) {
          await withVersion(read, (t) =>
            api.call((c) =>
              c.updateTask({
                id,
                expectedVersion: t.version,
                title: ctx.flags.title as string | undefined,
                dueAt: nullable(ctx.flags.due as string | undefined),
              }),
            ),
          )
        }
        if (ctx.flags.status !== undefined) {
          const statusId = findStatus(statuses, ctx.flags.status as string).id
          await withVersion(read, (t) =>
            api.call((c) => c.setTaskStatus({ id, expectedVersion: t.version, statusId })),
          )
        }
        if (ctx.flags.assignee !== undefined) {
          const assignee = nullable(ctx.flags.assignee as string | undefined) ?? null
          await withVersion(read, (t) =>
            api.call((c) => c.assignTask({ id, expectedVersion: t.version, assignee })),
          )
        }
        if (ctx.flags.snooze !== undefined) {
          const until = nullable(ctx.flags.snooze as string | undefined) ?? null
          await withVersion(read, (t) =>
            api.call((c) => c.snoozeTask({ id, expectedVersion: t.version, until })),
          )
        }
        note(`Updated task ${id}.`)
      })
    },
  },
  {
    path: "task archive",
    summary: "Archive a task",
    usage: "task archive <id>",
    run: async (ctx) => taskLifecycle(ctx, "archive"),
  },
  {
    path: "task restore",
    summary: "Restore an archived task",
    usage: "task restore <id>",
    run: async (ctx) => taskLifecycle(ctx, "restore"),
  },
  {
    path: "task delete",
    summary: "PURGE a task",
    usage: "task delete <id> --yes",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which task?", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete task ${id}`)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would PURGE task ${id}.`)
          return
        }
        await api.call((c) => c.deleteTask({ id }))
        note(`Purged task ${id}.`)
      })
    },
  },

  // ── the catalogues tasks point at ─────────────────────────────────────────
  {
    path: "task status list",
    summary: "The status catalogue behind every task board",
    usage: "task status list [--archived]",
    options: { archived: { type: "boolean" } },
    run: async (ctx) => {
      await withApi(async (api) => {
        const statuses = await api.call((c) =>
          c.listTaskStatuses({ includeArchived: Boolean(ctx.flags.archived) }),
        )
        printRows(
          ctx.format,
          statuses.map((s) => ({
            name: s.name,
            category: s.category,
            default: s.isDefault ? "yes" : "",
            position: s.position,
            id: s.id,
          })),
          ["name", "category", "default", "position", "id"],
        )
      })
    },
  },
  {
    path: "task status create",
    summary: "Add a task status",
    usage: "task status create <name> --category open|closed [--color <hex>] [--default]",
    options: {
      category: { type: "string" },
      color: { type: "string" },
      default: { type: "boolean" },
    },
    run: async (ctx) => {
      const [name] = ctx.args
      const category = ctx.flags.category as string | undefined
      if (!name || !category) throw new CliError("Need <name> --category <category>.", EXIT.usage)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would create status "${name}".`)
          return
        }
        const status = await api.call((c) =>
          c.createTaskStatus({
            name,
            category: category as TaskStatus["category"],
            color: (ctx.flags.color as string | undefined) ?? null,
            isDefault: Boolean(ctx.flags.default),
          }),
        )
        note(`Created status "${status.name}".`)
      })
    },
  },
  {
    path: "task priority list",
    summary: "The priority levels tasks can carry",
    usage: "task priority list [--archived]",
    options: { archived: { type: "boolean" } },
    run: async (ctx) => {
      await withApi(async (api) => {
        const priorities = await api.call((c) =>
          c.listTaskPriorities({ includeArchived: Boolean(ctx.flags.archived) }),
        )
        printRows(
          ctx.format,
          priorities.map((p) => ({
            name: p.name,
            color: p.color ?? "",
            position: p.position,
            id: p.id,
          })),
          ["name", "color", "position", "id"],
        )
      })
    },
  },
]

/** `--flag none` clears; omitted leaves alone. Without an explicit clear there
 *  is no way to unset a due date from the shell at all. */
const nullable = (v: string | undefined): string | null | undefined =>
  v === undefined ? undefined : v === "none" || v === "" ? null : v

const currentTask = async (api: Api, id: string): Promise<Task> => {
  const tasks = await api.call((c) => c.listTasks({ includeArchived: true, limit: 50_000 }))
  const task = tasks.find((t) => t.id === id)
  if (!task) throw new CliError(`No task ${id}.`, EXIT.notFound)
  return task
}

const taskLifecycle = async (
  ctx: { args: ReadonlyArray<string>; flags: Record<string, unknown> },
  verb: "archive" | "restore",
): Promise<void> => {
  const [id] = ctx.args
  if (!id) throw new CliError("Which task?", EXIT.usage)
  await withApi(async (api) => {
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} task ${id}.`)
      return
    }
    await withVersion(
      () => currentTask(api, id),
      (t) =>
        verb === "archive"
          ? api.call((c) => c.archiveTask({ id, expectedVersion: t.version }))
          : api.call((c) => c.restoreTask({ id, expectedVersion: t.version })),
    )
    note(`${verb === "archive" ? "Archived" : "Restored"} task ${id}.`)
  })
}
