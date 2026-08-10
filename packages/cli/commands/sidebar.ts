import type { SidebarSection, SidebarView } from "@alltinghq/contract"
import { requireSession } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printOne, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { findConcept } from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Sidebar views — the nav layout, edited elsewhere as a UI-only surface until
 * now. The server stores a View's `body` (sections of ordered entry ids) as an
 * OPAQUE document, same reasoning as dashboards (see dashboard.ts): there is no
 * partial-update RPC, so every mutation here is read the view, clone+mutate
 * `body.sections` in JS, and `updateView({id, body})` the whole thing back.
 *
 * An entry id is one of three shapes, a client-side convention the server
 * never inspects (mirrors packages/app/src/lib/sidebarViews.tsx):
 *   - a dashboard's raw uuid
 *   - "global:<key>"    — a built-in nav item (overview, tasks, members, automations, settings)
 *   - "concept:<uuid>"  — a single-record concept's own page
 */

const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const GLOBAL_KEYS = new Set(["overview", "tasks", "members", "automations", "settings"])

const findView = async (api: Api, name: string): Promise<SidebarView> => {
  const views = await api.call((c) => c.listViews())
  const n = name.trim().toLowerCase()
  const exact = views.find((v) => v.id === name) ?? views.find((v) => v.name.toLowerCase() === n)
  if (exact) return exact
  const partial = views.filter((v) => v.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${name}" matches ${partial.length} sidebar views.`
      : `No sidebar view named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    partial.length > 1
      ? partial.map((v) => `  ${v.name}`).join("\n")
      : "Run `allt sidebar view list`.",
  )
}

const findSection = (sections: ReadonlyArray<SidebarSection>, name: string): SidebarSection => {
  const n = name.trim().toLowerCase()
  const exact =
    sections.find((s) => s.id === name) ?? sections.find((s) => (s.title ?? "").toLowerCase() === n)
  if (exact) return exact
  const partial = sections.filter((s) => (s.title ?? "").toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${name}" matches ${partial.length} sections.`
      : `No section named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    partial.length > 1
      ? partial.map((s) => `  ${s.title ?? "(untitled)"}  [${s.id}]`).join("\n")
      : undefined,
  )
}

/** `<entry>` in, a stored entry id out. A bare token resolves as a dashboard
 *  name; `global:<key>` and `concept:<name>` are recognized by prefix. */
const resolveEntryId = async (api: Api, token: string): Promise<string> => {
  if (token.startsWith("global:")) {
    const key = token.slice("global:".length)
    if (!GLOBAL_KEYS.has(key)) {
      throw new CliError(
        `Unknown global nav key "${key}".`,
        EXIT.usage,
        `Known keys: ${[...GLOBAL_KEYS].join(", ")}`,
      )
    }
    return token
  }
  if (token.startsWith("concept:")) {
    const name = token.slice("concept:".length)
    const concepts = await api.call((c) => c.listConcepts({}))
    return `concept:${findConcept(concepts, name).id}`
  }
  const dashboards = await api.call((c) => c.listAllDashboards())
  const n = token.trim().toLowerCase()
  const exact =
    dashboards.find((d) => d.id === token) ?? dashboards.find((d) => d.name.toLowerCase() === n)
  if (exact) return exact.id
  const partial = dashboards.filter((d) => d.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0].id
  throw new CliError(
    partial.length > 1
      ? `"${token}" matches ${partial.length} dashboards.`
      : `No dashboard named "${token}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    partial.length > 1
      ? partial.map((d) => `  ${d.name}`).join("\n")
      : `Or use "global:<key>" or "concept:<name>".`,
  )
}

/** The reverse of `resolveEntryId`, for `view get` — a stored entry id back to
 *  something readable. A dashboard id that no longer resolves is shown as
 *  missing rather than dropped: the section still carries it (nothing here
 *  prunes it), so the output should say so. */
const labelForEntry = (
  entryId: string,
  dashboardById: ReadonlyMap<string, string>,
  conceptById: ReadonlyMap<string, string>,
): string => {
  if (entryId.startsWith("global:")) return `global: ${entryId.slice("global:".length)}`
  if (entryId.startsWith("concept:")) {
    const id = entryId.slice("concept:".length)
    return `concept: ${conceptById.get(id) ?? `${id} (missing)`}`
  }
  const name = dashboardById.get(entryId)
  return name ? `dashboard: ${name}` : `dashboard: ${entryId} (missing)`
}

export const sidebarCommands: ReadonlyArray<Command> = [
  {
    path: "sidebar view list",
    summary: "List sidebar views",
    usage: "sidebar view list [--json]",
    run: async (ctx) => {
      await withApi(async (api) => {
        const views = await api.call((c) => c.listViews())
        printRows(
          ctx.format,
          views.map((v) => ({
            name: v.name,
            scope: v.ownerId ? "personal" : "org",
            hidden: v.hidden ? "yes" : "",
            sections: v.body.sections.length,
            id: v.id,
          })),
          ["name", "scope", "hidden", "sections", "id"],
        )
      })
    },
  },
  {
    path: "sidebar view get",
    summary: "Show one view's sections and entries",
    usage: "sidebar view get <view> [--json]",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which view?", EXIT.usage)
      await withApi(async (api) => {
        const view = await findView(api, name)
        if (ctx.format === "json") {
          printOne(ctx.format, view as unknown as Record<string, unknown>)
          return
        }
        const [dashboards, concepts] = await Promise.all([
          api.call((c) => c.listAllDashboards()),
          api.call((c) => c.listConcepts({})),
        ])
        const dashboardById = new Map(dashboards.map((d) => [d.id, d.name]))
        const conceptById = new Map(concepts.map((c) => [c.id, c.name]))
        note(`${view.name}  (${view.ownerId ? "personal" : "org"})`)
        for (const section of view.body.sections) {
          note("")
          note(`  ${section.title ?? "(untitled)"}  [${section.id}]`)
          if (section.entryIds.length === 0) {
            note("    (empty)")
            continue
          }
          for (const entryId of section.entryIds) {
            note(`    - ${labelForEntry(entryId, dashboardById, conceptById)}`)
          }
        }
        if (view.body.sections.length === 0) note("  (no sections)")
      })
    },
  },
  {
    path: "sidebar view create",
    summary: "Create an empty sidebar view",
    usage: "sidebar view create <name> --scope org|personal [--icon <i>]",
    options: { scope: { type: "string" }, icon: { type: "string" } },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A name is required.", EXIT.usage)
      const scope = (ctx.flags.scope as string | undefined) ?? "org"
      if (scope !== "org" && scope !== "personal") {
        throw new CliError("--scope takes org or personal.", EXIT.usage)
      }
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would create sidebar view "${name}" (${scope}).`)
          return
        }
        const created = await api.call((c) =>
          c.createView({
            name,
            icon: (ctx.flags.icon as string | undefined) ?? null,
            scope: scope as "org" | "personal",
            body: { sections: [] },
          }),
        )
        note(`Created sidebar view "${created.name}" (${created.id}).`)
      })
    },
  },
  {
    path: "sidebar section add",
    summary: "Add a section to a sidebar view",
    usage: "sidebar section add <view> --title <t> [--icon <i>]",
    options: { title: { type: "string" }, icon: { type: "string" } },
    run: async (ctx) => {
      const [viewName] = ctx.args
      const title = ctx.flags.title as string | undefined
      if (!viewName || !title) throw new CliError("Need <view> --title <t>.", EXIT.usage)
      await withApi(async (api) => {
        const view = await findView(api, viewName)
        const section: SidebarSection = {
          id: crypto.randomUUID(),
          title,
          icon: (ctx.flags.icon as string | undefined) ?? null,
          entryIds: [],
        }
        const body = { sections: [...view.body.sections, section] }
        if (ctx.flags["dry-run"]) {
          note(`Would add section "${title}" to "${view.name}".`)
          return
        }
        await api.call((c) => c.updateView({ id: view.id, body }))
        note(`Added section "${title}" to "${view.name}".`)
      })
    },
  },
  {
    path: "sidebar section remove",
    summary: "Remove a section from a sidebar view",
    usage: "sidebar section remove <view> <section>",
    run: async (ctx) => {
      const [viewName, sectionName] = ctx.args
      if (!viewName || !sectionName) throw new CliError("Need <view> <section>.", EXIT.usage)
      await withApi(async (api) => {
        const view = await findView(api, viewName)
        const section = findSection(view.body.sections, sectionName)
        const body = { sections: view.body.sections.filter((s) => s.id !== section.id) }
        if (ctx.flags["dry-run"]) {
          note(`Would remove section "${section.title ?? section.id}" from "${view.name}".`)
          return
        }
        await api.call((c) => c.updateView({ id: view.id, body }))
        note(`Removed section "${section.title ?? section.id}" from "${view.name}".`)
      })
    },
  },
  {
    path: "sidebar section reorder",
    summary: "Reorder sections in a sidebar view",
    usage: "sidebar section reorder <view> <section> [<section> ...]",
    run: async (ctx) => {
      const [viewName, ...names] = ctx.args
      if (!viewName || names.length === 0) {
        throw new CliError("Need <view> and at least one section.", EXIT.usage)
      }
      await withApi(async (api) => {
        const view = await findView(api, viewName)
        const named = names.map((n) => findSection(view.body.sections, n))
        // Sections left unnamed keep their relative order AFTER the named ones,
        // same reasoning as `concept field reorder`: a partial reorder must not
        // silently drop a section from the sidebar.
        const rest = view.body.sections.filter((s) => !named.some((n) => n.id === s.id))
        const ordered = [...named, ...rest]
        const body = { sections: ordered }
        if (ctx.flags["dry-run"]) {
          note(`Would order: ${ordered.map((s) => s.title ?? s.id).join(", ")}`)
          return
        }
        await api.call((c) => c.updateView({ id: view.id, body }))
        note(`Reordered ${ordered.length} sections on "${view.name}".`)
      })
    },
  },
  {
    path: "sidebar entry add",
    summary: "Add an entry to a sidebar section",
    usage: "sidebar entry add <view> <section> <entry>",
    run: async (ctx) => {
      const [viewName, sectionName, entryToken] = ctx.args
      if (!viewName || !sectionName || !entryToken) {
        throw new CliError("Need <view> <section> <entry>.", EXIT.usage)
      }
      await withApi(async (api) => {
        const view = await findView(api, viewName)
        const section = findSection(view.body.sections, sectionName)
        const entryId = await resolveEntryId(api, entryToken)
        if (section.entryIds.includes(entryId)) {
          throw new CliError(
            `"${entryToken}" is already in "${section.title ?? section.id}".`,
            EXIT.conflict,
          )
        }
        const body = {
          sections: view.body.sections.map((s) =>
            s.id === section.id ? { ...s, entryIds: [...s.entryIds, entryId] } : s,
          ),
        }
        if (ctx.flags["dry-run"]) {
          note(`Would add "${entryToken}" to "${section.title ?? section.id}".`)
          return
        }
        await api.call((c) => c.updateView({ id: view.id, body }))
        note(`Added "${entryToken}" to "${section.title ?? section.id}" on "${view.name}".`)
      })
    },
  },
  {
    path: "sidebar entry remove",
    summary: "Remove an entry from a sidebar section",
    usage: "sidebar entry remove <view> <section> <entry>",
    run: async (ctx) => {
      const [viewName, sectionName, entryToken] = ctx.args
      if (!viewName || !sectionName || !entryToken) {
        throw new CliError("Need <view> <section> <entry>.", EXIT.usage)
      }
      await withApi(async (api) => {
        const view = await findView(api, viewName)
        const section = findSection(view.body.sections, sectionName)
        const entryId = await resolveEntryId(api, entryToken)
        if (!section.entryIds.includes(entryId)) {
          throw new CliError(
            `"${entryToken}" is not in "${section.title ?? section.id}".`,
            EXIT.notFound,
          )
        }
        const body = {
          sections: view.body.sections.map((s) =>
            s.id === section.id ? { ...s, entryIds: s.entryIds.filter((e) => e !== entryId) } : s,
          ),
        }
        if (ctx.flags["dry-run"]) {
          note(`Would remove "${entryToken}" from "${section.title ?? section.id}".`)
          return
        }
        await api.call((c) => c.updateView({ id: view.id, body }))
        note(`Removed "${entryToken}" from "${section.title ?? section.id}" on "${view.name}".`)
      })
    },
  },
  {
    path: "sidebar entry reorder",
    summary: "Reorder entries within a sidebar section",
    usage: "sidebar entry reorder <view> <section> <entry> [<entry> ...]",
    run: async (ctx) => {
      const [viewName, sectionName, ...tokens] = ctx.args
      if (!viewName || !sectionName || tokens.length === 0) {
        throw new CliError("Need <view> <section> and at least one entry.", EXIT.usage)
      }
      await withApi(async (api) => {
        const view = await findView(api, viewName)
        const section = findSection(view.body.sections, sectionName)
        const namedIds = await Promise.all(tokens.map((t) => resolveEntryId(api, t)))
        const rest = section.entryIds.filter((e) => !namedIds.includes(e))
        const ordered = [...namedIds, ...rest]
        const body = {
          sections: view.body.sections.map((s) =>
            s.id === section.id ? { ...s, entryIds: ordered } : s,
          ),
        }
        if (ctx.flags["dry-run"]) {
          note(`Would order ${ordered.length} entries in "${section.title ?? section.id}".`)
          return
        }
        await api.call((c) => c.updateView({ id: view.id, body }))
        note(
          `Reordered ${ordered.length} entries in "${section.title ?? section.id}" on "${view.name}".`,
        )
      })
    },
  },
]
