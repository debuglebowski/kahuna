import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * The organization's label catalogue.
 *
 * Putting a label ON a record is NOT here: labels ride inside the field patch
 * (`LABELS_KEY`), so that is `record update <id> --labels a,b`. This noun owns
 * only the catalogue itself.
 */
const withApi = async <T>(
  profileFlag: string | undefined,
  f: (api: Api) => Promise<T>,
): Promise<T> => {
  const { profile } = resolveProfile(loadConfig(), profileFlag)
  const api = makeRuntime(profile)
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const findLabel = async (api: Api, name: string) => {
  const labels = await api.call((c) => c.listLabels({ includeArchived: true }))
  const n = name.trim().toLowerCase()
  const exact = labels.find((l) => l.id === name) ?? labels.find((l) => l.name.toLowerCase() === n)
  if (exact) return exact
  const partial = labels.filter((l) => l.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  if (partial.length > 1) {
    throw new CliError(
      `"${name}" matches ${partial.length} labels.`,
      EXIT.usage,
      partial.map((l) => `  ${l.name}`).join("\n"),
    )
  }
  throw new CliError(`No label named "${name}".`, EXIT.notFound)
}

export const labelCommands: ReadonlyArray<Command> = [
  {
    path: "label list",
    summary: "List the organization's labels",
    usage: "label list [--archived] [--json]",
    options: { archived: { type: "boolean" } },
    run: async (ctx) => {
      await withApi(ctx.profile, async (api) => {
        const labels = await api.call((c) =>
          c.listLabels({ includeArchived: Boolean(ctx.flags.archived) }),
        )
        printRows(
          ctx.format,
          labels.map((l) => ({
            name: l.name,
            color: l.color ?? "",
            primary: l.primary ? "yes" : "",
            archived: l.archivedAt ? "yes" : "",
            id: l.id,
          })),
          ["name", "color", "primary", "archived", "id"],
        )
      })
    },
  },
  {
    path: "label create",
    summary: "Create a label",
    usage: "label create <name> [--color <hex>] [--primary]",
    options: { color: { type: "string" }, primary: { type: "boolean" } },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A name is required.", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would create label "${name}".`)
          return
        }
        const label = await api.call((c) =>
          c.createLabel({
            name,
            color: (ctx.flags.color as string | undefined) ?? null,
            primary: Boolean(ctx.flags.primary),
          }),
        )
        note(`Created label "${label.name}".`)
      })
    },
  },
  {
    path: "label update",
    summary: "Rename a label or change its colour",
    usage: "label update <label> [--name <n>] [--color <hex>] [--primary]",
    options: { name: { type: "string" }, color: { type: "string" }, primary: { type: "boolean" } },
    run: async (ctx) => {
      const [target] = ctx.args
      if (!target) throw new CliError("Which label?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const label = await findLabel(api, target)
        if (ctx.flags["dry-run"]) {
          note(`Would update label "${label.name}".`)
          return
        }
        const updated = await api.call((c) =>
          c.renameLabel({
            id: label.id,
            name: ctx.flags.name as string | undefined,
            color: ctx.flags.color as string | undefined,
            primary: ctx.flags.primary === undefined ? undefined : Boolean(ctx.flags.primary),
          }),
        )
        note(`Updated label "${updated.name}".`)
      })
    },
  },
  {
    path: "label archive",
    summary: "Archive a label",
    usage: "label archive <label>",
    run: async (ctx) => labelLifecycle(ctx, "archive"),
  },
  {
    path: "label restore",
    summary: "Restore an archived label",
    usage: "label restore <label>",
    run: async (ctx) => labelLifecycle(ctx, "restore"),
  },
  {
    path: "label delete",
    summary: "PURGE a label",
    usage: "label delete <label> --yes",
    run: async (ctx) => {
      const [target] = ctx.args
      if (!target) throw new CliError("Which label?", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete label "${target}"`)
      await labelLifecycle(ctx, "delete")
    },
  },
]

const labelLifecycle = async (
  ctx: { args: ReadonlyArray<string>; profile?: string; flags: Record<string, unknown> },
  verb: "archive" | "restore" | "delete",
): Promise<void> => {
  const [target] = ctx.args
  if (!target) throw new CliError("Which label?", EXIT.usage)
  await withApi(ctx.profile, async (api) => {
    const label = await findLabel(api, target)
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} label "${label.name}".`)
      return
    }
    await api.call((c) =>
      verb === "archive"
        ? c.archiveLabel({ id: label.id })
        : verb === "restore"
          ? c.restoreLabel({ id: label.id })
          : c.deleteLabel({ id: label.id }),
    )
    note(
      `${verb === "delete" ? "Purged" : verb === "archive" ? "Archived" : "Restored"} "${label.name}".`,
    )
  })
}
