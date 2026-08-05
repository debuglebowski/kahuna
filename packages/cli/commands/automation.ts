import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printOne, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Automations: when / if / then over the event log.
 *
 * Read and test only. Authoring a trigger + condition tree from flags would be a
 * worse editor than the one that exists, and `automation test` is the command
 * that actually pays here — a dry run reports what WOULD happen and writes
 * nothing, which is exactly what you want before letting a rule loose.
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

const findAutomation = async (api: Api, name: string) => {
  const automations = await api.call((c) => c.listAutomations({ includeArchived: true }))
  const n = name.trim().toLowerCase()
  const exact =
    automations.find((a) => a.id === name) ?? automations.find((a) => a.name.toLowerCase() === n)
  if (exact) return exact
  const partial = automations.filter((a) => a.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${name}" matches ${partial.length} automations.`
      : `No automation named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
  )
}

export const automationCommands: ReadonlyArray<Command> = [
  {
    path: "automation list",
    summary: "Every automation and whether it is on",
    usage: "automation list [--archived] [--json]",
    options: { archived: { type: "boolean" } },
    run: async (ctx) => {
      await withApi(ctx.profile, async (api) => {
        const automations = await api.call((c) =>
          c.listAutomations({ includeArchived: Boolean(ctx.flags.archived) }),
        )
        printRows(
          ctx.format,
          automations.map((a) => ({
            name: a.name,
            enabled: a.enabled ? "yes" : "no",
            trigger: a.trigger.kind,
            actions: a.actions.length,
            archived: a.archivedAt ? "yes" : "",
            id: a.id,
          })),
          ["name", "enabled", "trigger", "actions", "archived", "id"],
        )
      })
    },
  },
  {
    path: "automation get",
    summary: "One automation's trigger, conditions and actions",
    usage: "automation get <automation> [--json]",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which automation?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const found = await findAutomation(api, name)
        const full = await api.call((c) => c.getAutomation({ id: found.id }))
        printOne(ctx.format, full as unknown as Record<string, unknown>)
      })
    },
  },
  {
    path: "automation runs",
    summary: "Recent runs and failures — the debugging view",
    usage: "automation runs <automation> [--limit n]",
    options: { limit: { type: "string" } },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which automation?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const found = await findAutomation(api, name)
        const runs = await api.call((c) =>
          c.listAutomationRuns({
            automationId: found.id,
            limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
          }),
        )
        printRows(
          ctx.format,
          runs.map((r) => ({ ...(r as unknown as Record<string, unknown>) })),
        )
      })
    },
  },
  {
    path: "automation test",
    summary: "Dry-run an automation — reports what WOULD happen, writes nothing",
    usage: "automation test <automation> [--limit n]",
    options: { limit: { type: "string" } },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which automation?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const found = await findAutomation(api, name)
        const result = await api.call((c) =>
          c.testAutomation({
            id: found.id,
            limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
          }),
        )
        if (ctx.format === "json") {
          printOne(ctx.format, result as unknown as Record<string, unknown>)
          return
        }
        note(`Dry run of "${found.name}" — nothing was written.`)
        printOne("table", result as unknown as Record<string, unknown>)
      })
    },
  },
]
