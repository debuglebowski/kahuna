import { readFileSync, writeFileSync } from "node:fs"
import type { DashboardBody } from "@kingsmaker/contract"
import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Dashboards — the only surface records are seen on since `/concepts` was
 * removed. Export and import are CLIENT-SIDE: there is no export RPC, so this
 * is `listDashboards` out and `createDashboard` in, with the body carried
 * verbatim as JSON.
 *
 * The body is NOT interpreted here. It is a widget tree the client resolves
 * against live collections, and a CLI that tried to validate it would encode a
 * second, always-stale copy of the widget catalogue.
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

const findDashboard = async (api: Api, name: string) => {
  const dashboards = await api.call((c) => c.listAllDashboards())
  const n = name.trim().toLowerCase()
  const exact =
    dashboards.find((d) => d.id === name) ?? dashboards.find((d) => d.name.toLowerCase() === n)
  if (exact) return exact
  const partial = dashboards.filter((d) => d.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${name}" matches ${partial.length} dashboards.`
      : `No dashboard named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    partial.length > 1 ? partial.map((d) => `  ${d.name}`).join("\n") : undefined,
  )
}

export const dashboardCommands: ReadonlyArray<Command> = [
  {
    path: "dashboard list",
    summary: "Every dashboard, including record-view templates",
    usage: "dashboard list [--json]",
    run: async (ctx) => {
      await withApi(ctx.profile, async (api) => {
        const dashboards = await api.call((c) => c.listAllDashboards())
        printRows(
          ctx.format,
          dashboards.map((d) => ({
            name: d.name,
            kind: d.kind,
            scope: d.ownerId ? "personal" : "org",
            hidden: d.hidden ? "yes" : "",
            concept: d.conceptId ?? "",
            id: d.id,
          })),
          ["name", "kind", "scope", "hidden", "concept", "id"],
        )
      })
    },
  },
  {
    path: "dashboard export",
    summary: "Write a dashboard's definition to a file",
    usage: "dashboard export <dashboard> [--out <file>]",
    options: { out: { type: "string" } },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which dashboard?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const dashboard = await findDashboard(api, name)
        // Deliberately WITHOUT the id: an exported dashboard is a template to
        // import elsewhere, and carrying the source id invites an import that
        // silently targets the original.
        const payload = {
          name: dashboard.name,
          icon: dashboard.icon,
          kind: dashboard.kind,
          conceptId: dashboard.conceptId,
          body: dashboard.body,
        }
        const text = JSON.stringify(payload, null, 2)
        const out = ctx.flags.out as string | undefined
        if (out) {
          writeFileSync(out, `${text}\n`)
          note(`Wrote "${dashboard.name}" to ${out}.`)
        } else {
          process.stdout.write(`${text}\n`)
        }
      })
    },
  },
  {
    path: "dashboard create",
    summary: "Create a dashboard from a JSON definition",
    usage: "dashboard create <file> [--name <n>] [--scope org|personal]",
    options: { name: { type: "string" }, scope: { type: "string" } },
    run: async (ctx) => {
      const [file] = ctx.args
      if (!file) throw new CliError("Which file?", EXIT.usage)
      let parsed: {
        name?: string
        icon?: string | null
        kind?: "page" | "record"
        conceptId?: string | null
        body?: DashboardBody
      }
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"))
      } catch (e) {
        throw new CliError(
          `Cannot read ${file} as JSON (${e instanceof Error ? e.message : String(e)}).`,
          EXIT.usage,
        )
      }
      const name = (ctx.flags.name as string | undefined) ?? parsed.name
      if (!name) throw new CliError("The file has no name, and none was given.", EXIT.usage)
      if (!parsed.body) {
        throw new CliError(
          "The file has no `body`.",
          EXIT.usage,
          "Export one first: `km dashboard export <name> --out template.json`.",
        )
      }
      const scope = (ctx.flags.scope as string | undefined) ?? "org"
      if (scope !== "org" && scope !== "personal") {
        throw new CliError("--scope takes org or personal.", EXIT.usage)
      }
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would create dashboard "${name}" (${scope}).`)
          return
        }
        const created = await api.call((c) =>
          c.createDashboard({
            name,
            icon: parsed.icon ?? null,
            scope,
            body: parsed.body as DashboardBody,
            kind: parsed.kind,
            conceptId: parsed.conceptId ?? null,
          }),
        )
        note(`Created dashboard "${created.name}" (${created.id}).`)
      })
    },
  },
  {
    path: "dashboard delete",
    summary: "Delete a dashboard",
    usage: "dashboard delete <dashboard> --yes",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which dashboard?", EXIT.usage)
      requireConfirmation(ctx.flags, `delete dashboard "${name}"`)
      await withApi(ctx.profile, async (api) => {
        const dashboard = await findDashboard(api, name)
        if (ctx.flags["dry-run"]) {
          note(`Would delete "${dashboard.name}".`)
          return
        }
        await api.call((c) => c.deleteDashboard({ id: dashboard.id }))
        note(`Deleted "${dashboard.name}".`)
      })
    },
  },
]
