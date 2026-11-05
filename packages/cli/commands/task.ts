import { readFileSync } from "node:fs"
import type { Label, RichTextEnvelope, Task, TaskPriority, TaskStatus } from "@kahunalabs/contract"
import { requireSession, type Session } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation, withVersion } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import { matchMember } from "../people.ts"
import type { Command } from "../registry.ts"
import { orgMembers, sessionUserId } from "../rest.ts"
import { markdownToRichText } from "../richtext.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Tasks are global AND record-scoped: `listTasks` takes an optional subject, so
 * `--record` is a filter rather than a different noun. THE SUBJECT IS THE
 * LINEAGE id (the `record` column of `kahuna record list`), not the version id —
 * an annotation belongs to the record, not to one version of it. `task status` and
 * `task priority` are the catalogues those tasks point at — sub-nouns, because
 * they belong to tasks and to nothing else.
 */
const withApi = async <T>(f: (api: Api, session: Session) => Promise<T>): Promise<T> => {
  const session = requireSession()
  const api = makeRuntime(session)
  try {
    return await f(api, session)
  } finally {
    await api.dispose()
  }
}

/**
 * A catalogue entry by id, name (case-insensitive), or a unique name prefix.
 * Statuses, priorities and labels are all picked this way, so "high" finds
 * "High" everywhere and an ambiguous prefix is refused with the choices listed.
 */
export const pickByName = <T extends { readonly id: string; readonly name: string }>(
  items: ReadonlyArray<T>,
  input: string,
  noun: string,
  plural: string,
): T => {
  const n = input.trim().toLowerCase()
  const exact = items.find((i) => i.id === input) ?? items.find((i) => i.name.toLowerCase() === n)
  if (exact) return exact
  const partial = items.filter((i) => i.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  const names = items.map((i) => i.name).join(", ")
  throw new CliError(
    partial.length > 1
      ? `"${input}" matches ${partial.length} ${plural}.`
      : `No ${noun} named "${input}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    names
      ? `${plural[0]?.toUpperCase()}${plural.slice(1)}: ${names}`
      : `There are no ${plural} yet.`,
  )
}

const findStatus = (statuses: ReadonlyArray<TaskStatus>, name: string): TaskStatus =>
  pickByName(statuses, name, "status", "statuses")

/** `--flag none` (or empty) clears. */
const isClear = (v: string): boolean => v === "none" || v === ""

/**
 * `--description` is markdown, or `@path` to read it from a file (`@@` = a
 * literal leading @) — the same rule as `--field name=@file`. `none` clears.
 * Trailing newlines are dropped, like `$(cat file)`.
 */
export const readDescription = (
  raw: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): RichTextEnvelope | null => {
  if (isClear(raw)) return null
  let text = raw
  if (raw.startsWith("@@")) text = raw.slice(1)
  else if (raw.startsWith("@")) {
    const path = raw.slice(1)
    try {
      text = readFile(path)
    } catch {
      throw new CliError(
        `Cannot read ${path} (--description).`,
        EXIT.notFound,
        'A value starting with @ is read from that file. For a literal leading @, double it: "@@".',
      )
    }
  }
  text = text.replace(/(?:\r?\n)+$/, "")
  if (text.trim() === "") return null
  return markdownToRichText(text) as RichTextEnvelope
}

/**
 * `--assignee` takes a user id, an email, a name, or `me`. Assignees are stored
 * as user ids, so anything else filtered verbatim silently matches nobody (the
 * server filter is an exact match — pinned in engine/test/tasks.test.ts). When
 * filtering, an unknown value is passed through (a former member can still hold
 * tasks) WITH a warning, so an empty result says why; assigning refuses it.
 */
const resolveAssignee = async (
  session: Session,
  input: string,
  mode: "assign" | "filter",
): Promise<string> => {
  if (input.trim().toLowerCase() === "me") return await sessionUserId(session)
  const member = matchMember(await orgMembers(session), input)
  if (member) return member.userId
  if (mode === "filter") {
    note(`No member matches "${input}" — filtering by it as a raw user id.`)
    return input
  }
  throw new CliError(
    `No member matches "${input}".`,
    EXIT.notFound,
    "Pass a user id, email, name, or `me`. `kahuna organization member list` shows user ids.",
  )
}

/** Live (non-archived) labels by name; a repeated `--label` gives several. */
const resolveLabels = (labels: ReadonlyArray<Label>, inputs: ReadonlyArray<string>): string[] => [
  ...new Set(inputs.map((l) => pickByName(labels, l, "label", "labels").id)),
]

const listFlag = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : []

const taskRow = (
  t: Task,
  statuses: ReadonlyArray<TaskStatus>,
  priorities: ReadonlyArray<TaskPriority>,
  labels: ReadonlyArray<Label>,
): Record<string, unknown> => ({
  id: t.id,
  title: t.title,
  status: statuses.find((s) => s.id === t.statusId)?.name ?? "",
  priority: priorities.find((p) => p.id === t.priorityId)?.name ?? "",
  labels: t.labelIds
    .map((id) => labels.find((l) => l.id === id)?.name)
    .filter(Boolean)
    .join(", "),
  assignee: t.assignee ?? "",
  due: t.dueAt ?? "",
  snoozed: t.snoozedUntil ?? "",
  record: t.subjectId ?? "",
  description: t.description?.text ?? "",
})

const TASK_COLUMNS = [
  "id",
  "title",
  "status",
  "priority",
  "labels",
  "assignee",
  "due",
  "snoozed",
  "record",
]

export const taskCommands: ReadonlyArray<Command> = [
  {
    path: "task list",
    summary: "List tasks — yours, a record's, or everyone's",
    usage:
      "task list [--record <id>] [--assignee <user|email|name|me>] [--status <name>] [--archived] [--limit n]",
    options: {
      record: { type: "string" },
      assignee: { type: "string" },
      status: { type: "string" },
      archived: { type: "boolean" },
      limit: { type: "string" },
    },
    run: async (ctx) => {
      await withApi(async (api, session) => {
        const statuses = await api.call((c) => c.listTaskStatuses({ includeArchived: true }))
        const statusId = ctx.flags.status
          ? findStatus(statuses, ctx.flags.status as string).id
          : undefined
        const assignee =
          ctx.flags.assignee !== undefined
            ? await resolveAssignee(session, ctx.flags.assignee as string, "filter")
            : undefined
        const tasks = await api.call((c) =>
          c.listTasks({
            subjectId: ctx.flags.record as string | undefined,
            assignee,
            statusId,
            includeArchived: Boolean(ctx.flags.archived),
            limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
          }),
        )
        // Archived catalogue entries included: a task can still point at one,
        // and a blank cell would read as "no priority".
        const priorities = await api.call((c) => c.listTaskPriorities({ includeArchived: true }))
        const labels = tasks.some((t) => t.labelIds.length > 0)
          ? await api.call((c) => c.listLabels({ includeArchived: true }))
          : []
        printRows(
          ctx.format,
          tasks.map((t) => taskRow(t, statuses, priorities, labels)),
          // The description is a paragraph — it would wreck a table's widths.
          // JSON and CSV carry it.
          ctx.format === "table" ? TASK_COLUMNS : [...TASK_COLUMNS, "description"],
        )
      })
    },
  },
  {
    path: "task create",
    summary: "Create a task, optionally on a record",
    usage:
      "task create <title> [--record <id>] [--status <name>] [--priority <name>] [--label <name>]... [--assignee <user|email|name|me>] [--due <date>] [--description <markdown|@file>]",
    options: {
      record: { type: "string" },
      status: { type: "string" },
      priority: { type: "string" },
      label: { type: "string", multiple: true },
      assignee: { type: "string" },
      due: { type: "string" },
      description: { type: "string" },
    },
    run: async (ctx) => {
      const title = ctx.args.join(" ")
      if (!title) throw new CliError("A title is required.", EXIT.usage)
      await withApi(async (api, session) => {
        // Everything is resolved BEFORE --dry-run returns, so a dry run catches
        // a misspelt priority or an unknown assignee.
        const statuses = await api.call((c) => c.listTaskStatuses({}))
        const statusId = ctx.flags.status
          ? findStatus(statuses, ctx.flags.status as string).id
          : undefined
        const priorityFlag = ctx.flags.priority as string | undefined
        const priorityId =
          priorityFlag === undefined || isClear(priorityFlag)
            ? null
            : pickByName(
                await api.call((c) => c.listTaskPriorities({})),
                priorityFlag,
                "priority",
                "priorities",
              ).id
        const labelInputs = listFlag(ctx.flags.label)
        const labelIds =
          labelInputs.length > 0
            ? resolveLabels(await api.call((c) => c.listLabels({})), labelInputs)
            : []
        const assigneeFlag = ctx.flags.assignee as string | undefined
        const assignee =
          assigneeFlag === undefined || isClear(assigneeFlag)
            ? null
            : await resolveAssignee(session, assigneeFlag, "assign")
        const descriptionFlag = ctx.flags.description as string | undefined
        const description = descriptionFlag === undefined ? null : readDescription(descriptionFlag)

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
            description,
            statusId,
            priorityId,
            labelIds,
            assignee,
            dueAt: (ctx.flags.due as string | undefined) ?? null,
          }),
        )
        note(`Created task "${task.title}" (${task.id}).`)
      })
    },
  },
  {
    path: "task update",
    summary:
      "Change a task's title, description, status, priority, labels, assignee, due or snooze",
    usage:
      "task update <id> [--title <t>] [--description <markdown|@file|none>] [--status <name>] [--priority <name|none>] [--label <name|none>]... [--add-label <name>]... [--remove-label <name>]... [--assignee <user|email|name|me|none>] [--due <date|none>] [--snooze <date|none>]",
    help: "--label REPLACES the task's labels (`--label none` clears them); --add-label / --remove-label edit the set.",
    options: {
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string" },
      priority: { type: "string" },
      label: { type: "string", multiple: true },
      "add-label": { type: "string", multiple: true },
      "remove-label": { type: "string", multiple: true },
      assignee: { type: "string" },
      due: { type: "string" },
      snooze: { type: "string" },
    },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which task?", EXIT.usage)
      await withApi(async (api, session) => {
        const current = await currentTask(api, id)

        // Resolve every name up front — a typo must fail before the first write,
        // not after the title has already changed.
        const statusId =
          ctx.flags.status !== undefined
            ? findStatus(await api.call((c) => c.listTaskStatuses({})), ctx.flags.status as string)
                .id
            : undefined
        const priorityFlag = ctx.flags.priority as string | undefined
        const priorityId =
          priorityFlag === undefined
            ? undefined
            : isClear(priorityFlag)
              ? null
              : pickByName(
                  await api.call((c) => c.listTaskPriorities({})),
                  priorityFlag,
                  "priority",
                  "priorities",
                ).id
        const setLabels = listFlag(ctx.flags.label)
        const addLabels = listFlag(ctx.flags["add-label"])
        const removeLabels = listFlag(ctx.flags["remove-label"])
        if (setLabels.length > 0 && addLabels.length + removeLabels.length > 0) {
          throw new CliError(
            "--label replaces the labels; it cannot be combined with --add-label/--remove-label.",
            EXIT.usage,
          )
        }
        const clearLabels = setLabels.length === 1 && isClear(setLabels[0] ?? "")
        const labelsTouched = setLabels.length + addLabels.length + removeLabels.length > 0
        const catalogue =
          labelsTouched && !clearLabels ? await api.call((c) => c.listLabels({})) : []
        const setIds = clearLabels ? [] : resolveLabels(catalogue, setLabels)
        const addIds = resolveLabels(catalogue, addLabels)
        // Removing tolerates an archived label — it may still be on the task.
        const removeIds =
          removeLabels.length > 0
            ? resolveLabels(
                await api.call((c) => c.listLabels({ includeArchived: true })),
                removeLabels,
              )
            : []
        const nextLabels = (t: Task): ReadonlyArray<string> | undefined => {
          if (!labelsTouched) return undefined
          if (setLabels.length > 0) return setIds
          const drop = new Set(removeIds)
          return [...new Set([...t.labelIds, ...addIds])].filter((l) => !drop.has(l))
        }
        const descriptionFlag = ctx.flags.description as string | undefined
        const description =
          descriptionFlag === undefined ? undefined : readDescription(descriptionFlag)
        const assigneeFlag = ctx.flags.assignee as string | undefined
        const assignee =
          assigneeFlag === undefined
            ? undefined
            : isClear(assigneeFlag)
              ? null
              : await resolveAssignee(session, assigneeFlag, "assign")

        if (ctx.flags["dry-run"]) {
          note(`Would update task "${current.title}".`)
          return
        }

        // FOUR separate procedures — updateTask, setTaskStatus, assignTask,
        // snoozeTask — each taking its own expectedVersion, and each BUMPING it.
        // So they run in sequence and re-read between, which is exactly what
        // withVersion does; batching them would fail on the second call.
        const read = async () => await currentTask(api, id)

        if (
          ctx.flags.title !== undefined ||
          ctx.flags.due !== undefined ||
          description !== undefined ||
          priorityId !== undefined ||
          labelsTouched
        ) {
          await withVersion(read, (t) =>
            api.call((c) =>
              c.updateTask({
                id,
                expectedVersion: t.version,
                title: ctx.flags.title as string | undefined,
                dueAt: nullable(ctx.flags.due as string | undefined),
                description,
                priorityId,
                labelIds: nextLabels(t),
              }),
            ),
          )
        }
        if (statusId !== undefined) {
          await withVersion(read, (t) =>
            api.call((c) => c.setTaskStatus({ id, expectedVersion: t.version, statusId })),
          )
        }
        if (assignee !== undefined) {
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
