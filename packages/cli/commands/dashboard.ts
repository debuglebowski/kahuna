import type {
  Dashboard,
  DashboardBody,
  DashboardGroup,
  DashboardNode,
  DashboardWidget,
} from "@kahunalabs/contract"
import { requireSession } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation } from "../mutate.ts"
import { note, printOne, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { findConcept, parseKeyValuePairs } from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Dashboards — the only surface records are seen on since `/concepts` was
 * removed. `body` is a tree (`DashboardBody.children`, widgets as leaves,
 * groups as row/col/tab containers) resolved CLIENT-SIDE against live
 * collections; the server only persists/serves the document. `updateDashboard`
 * takes the full body, so every mutation here is read the dashboard, clone
 * +mutate the tree in JS, write the whole thing back with an
 * `expectedUpdatedAt` guard.
 *
 * Deliberately no client-side widget catalogue: `DashboardWidget` is an
 * append-only union of ~30 kinds, each with its own fields, and the SERVER
 * already validates `body` against that union on write. `widget add`/`set`
 * therefore accept arbitrary `--set key=value` pairs and let a bad key fail
 * loud from the server rather than duplicating its schema here.
 */

/** The kinds `dashboard widget add --type` accepts, mirrored from the
 *  contract's `DashboardWidget` union — same reasoning as `concept.ts`'s
 *  `KINDS`: an unknown type fails here with the list, not as a schema decode
 *  error from the server. Descriptions are for `dashboard widget types`'
 *  benefit only, summarized from each widget's own doc comment in
 *  contract.ts. This is the only thing mirrored from the widget catalogue —
 *  the discriminant + a one-line summary, never per-kind fields (see the
 *  module doc comment above) — so it can go stale without breaking anything,
 *  unlike a client-side field schema would. */
const WIDGET_CATALOG: ReadonlyArray<{
  readonly type: DashboardWidget["type"]
  readonly description: string
}> = [
  {
    type: "metric",
    description:
      "A single hero number — count, sum, or average over a concept's records. Can show a delta versus N days ago.",
  },
  {
    type: "list",
    description:
      "A filterable, sortable table of a concept's records. Supports a flat, grouped-by-field, or status-row layout.",
  },
  {
    type: "breakdown",
    description:
      "A chart breaking a concept's records down by a grouping field. Renders as bars, pie, donut, stacked, or a table.",
  },
  {
    type: "attention",
    description:
      "Surfaces records that need attention, banded by how long they've gone quiet (cooling/cold/heating/steady).",
  },
  {
    type: "trend",
    description:
      "A time-series chart of event volume for a concept, bucketed by day or week, with an optional delta header.",
  },
  {
    type: "activity",
    description:
      "A recent-activity feed of events on a concept's records, with optional inline diffs of what changed.",
  },
  {
    type: "analytics",
    description:
      "An aggregated time-series pulled from PostHog — active users, event counts, or a custom HogQL query.",
  },
  {
    type: "tasks",
    description:
      "A task list with assignee, status, and due-date filters, and an optional inline composer.",
  },
  {
    type: "members",
    description:
      "The organization's member roster, with configurable columns (role/email/joined) and sorting.",
  },
  {
    type: "welcome",
    description: "A greeting tile showing an org activity pulse and a set of curated quick links.",
  },
  {
    type: "goal",
    description:
      "A metric tracked against a manual target — progress toward a quota, or staying under a budget.",
  },
  {
    type: "shortcuts",
    description:
      "Hand-picked links to records, dashboards, or URLs. Fully manual — no filters or live data.",
  },
  {
    type: "note",
    description: "Free-form rich text pinned to the canvas, like a sticky note.",
  },
  {
    type: "kanban",
    description: "A drag-and-drop board of records in columns keyed by an enum field.",
  },
  {
    type: "calendar",
    description:
      "Records from one or more concepts plotted on a calendar by a date field, in month, week, or agenda view.",
  },
  {
    type: "gantt",
    description:
      "A Gantt timeline — records as bars between a start and end date field, with optional progress bars and swimlanes.",
  },
  {
    type: "files",
    description:
      "A file browser scoped to a record, a concept, the whole org, or the widget's own private bucket.",
  },
  {
    type: "document",
    description:
      "An inline rich-text editor bound to one record's richtext field, autosaving as you type.",
  },
  {
    type: "record-details",
    description: "The current record's field values. Only meaningful on a record dashboard.",
  },
  {
    type: "record-connections",
    description:
      "The current record's relations to other records. Only meaningful on a record dashboard.",
  },
  {
    type: "record-graph",
    description:
      "A graph visualization of the current record's connections. Only meaningful on a record dashboard.",
  },
  {
    type: "record-labels",
    description: "The current record's labels. Only meaningful on a record dashboard.",
  },
  {
    type: "record-versions",
    description: "The current record's version history. Only meaningful on a record dashboard.",
  },
  {
    type: "record-notes",
    description: "Notes attached to the current record. Only meaningful on a record dashboard.",
  },
  {
    type: "record-tasks",
    description: "Tasks attached to the current record. Only meaningful on a record dashboard.",
  },
  {
    type: "record-activity",
    description: "The current record's activity feed. Only meaningful on a record dashboard.",
  },
  {
    type: "record-mentions",
    description:
      "Places elsewhere that @-mention the current record. Only meaningful on a record dashboard.",
  },
]
const WIDGET_KINDS: ReadonlyArray<DashboardWidget["type"]> = WIDGET_CATALOG.map((w) => w.type)

type TreeBody = DashboardBody & { readonly children: ReadonlyArray<DashboardNode> }

interface FlatNode {
  readonly id: string
  readonly type: string
  readonly label: string | null
  readonly path: ReadonlyArray<number>
  readonly depth: number
}

const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const resolveDashboard = (all: ReadonlyArray<Dashboard>, name: string): Dashboard => {
  const n = name.trim().toLowerCase()
  const exact = all.find((d) => d.id === name) ?? all.find((d) => d.name.toLowerCase() === n)
  if (exact) return exact
  const partial = all.filter((d) => d.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${name}" matches ${partial.length} dashboards.`
      : `No dashboard named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    partial.length > 1 ? partial.map((d) => `  ${d.name}`).join("\n") : undefined,
  )
}

const findDashboard = async (api: Api, name: string): Promise<Dashboard> =>
  resolveDashboard(await api.call((c) => c.listAllDashboards()), name)

/** Refuses a body still in the legacy flat `body.widgets` shape (pre-auto-
 *  layout, never opened in the app since). Nothing here migrates it — that's
 *  the client's job on load — so failing loud beats silently no-op-ing. */
const requireTreeBody = (dashboard: Dashboard): TreeBody => {
  if (!dashboard.body.children) {
    throw new CliError(
      `"${dashboard.name}" hasn't been opened in the app since before widget editing existed.`,
      EXIT.usage,
      "Open it once in Kahuna to migrate its layout, then retry.",
    )
  }
  return dashboard.body as TreeBody
}

const nodeLabel = (n: DashboardNode): string | null =>
  n.type === "group" ? (n.label ?? null) : ((n as { title: string | null }).title ?? null)

const flattenNodes = (body: TreeBody): ReadonlyArray<FlatNode> => {
  const out: FlatNode[] = []
  const walk = (
    nodes: ReadonlyArray<DashboardNode>,
    path: ReadonlyArray<number>,
    depth: number,
  ) => {
    nodes.forEach((n, i) => {
      const here = [...path, i]
      out.push({ id: n.id, type: n.type, label: nodeLabel(n), path: here, depth })
      if (n.type === "group") walk(n.children, here, depth + 1)
    })
  }
  walk(body.children, [], 0)
  return out
}

/** `<ref>` in, the flat entry out — exact id, then exact label, then a label
 *  prefix, ambiguous/not-found otherwise. Same resolution shape as
 *  `sidebar.ts`'s `findSection`, reused for both widgets and groups since
 *  both carry `id` + a nullable display name. */
const findNode = (flat: ReadonlyArray<FlatNode>, ref: string): FlatNode => {
  const n = ref.trim().toLowerCase()
  const exact =
    flat.find((f) => f.id === ref) ?? flat.find((f) => (f.label ?? "").toLowerCase() === n)
  if (exact) return exact
  const partial = flat.filter((f) => (f.label ?? "").toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1
      ? `"${ref}" matches ${partial.length} widgets/groups.`
      : `No widget or group matching "${ref}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    partial.length > 1
      ? partial.map((f) => `  ${f.label ?? "(untitled)"}  [${f.type}]  ${f.id}`).join("\n")
      : "Run `kahuna dashboard widget list <dashboard>`.",
  )
}

const getAt = (
  children: ReadonlyArray<DashboardNode>,
  path: ReadonlyArray<number>,
): DashboardNode => {
  const [i, ...rest] = path
  const n = i === undefined ? undefined : children[i]
  if (!n)
    throw new CliError("Stale path — the tree changed underneath this command.", EXIT.conflict)
  if (rest.length === 0) return n
  if (n.type !== "group") throw new CliError("Path continues past a leaf widget.", EXIT.usage)
  return getAt(n.children, rest)
}

const removeAt = (
  children: ReadonlyArray<DashboardNode>,
  path: ReadonlyArray<number>,
): ReadonlyArray<DashboardNode> => {
  const [i, ...rest] = path
  if (rest.length === 0) return children.filter((_, idx) => idx !== i)
  return children.map((n, idx) => {
    if (idx !== i) return n
    if (n.type !== "group") throw new CliError("Path continues past a leaf widget.", EXIT.usage)
    return { ...n, children: removeAt(n.children, rest) }
  })
}

const replaceAt = (
  children: ReadonlyArray<DashboardNode>,
  path: ReadonlyArray<number>,
  updater: (node: DashboardNode) => DashboardNode,
): ReadonlyArray<DashboardNode> => {
  const [i, ...rest] = path
  return children.map((n, idx) => {
    if (idx !== i) return n
    if (rest.length === 0) return updater(n)
    if (n.type !== "group") throw new CliError("Path continues past a leaf widget.", EXIT.usage)
    return { ...n, children: replaceAt(n.children, rest, updater) }
  })
}

/** `parentToken` in, a group id (or null for root) out. Purely local — no
 *  network call, resolves against whichever body is passed in. */
const resolveParentId = (body: TreeBody, parentToken: string | undefined): string | null => {
  if (!parentToken || parentToken === "root") return null
  const target = findNode(flattenNodes(body), parentToken)
  if (target.type !== "group")
    throw new CliError(`"${parentToken}" is a widget, not a group.`, EXIT.usage)
  return target.id
}

/** Inserts `node` into `parentId`'s children (root when null). ALWAYS
 *  re-resolves the parent's current path by id rather than accepting one from
 *  the caller — `move` removes a node first, which shifts every path after
 *  it, so reusing a pre-removal path here would insert in the wrong place (or
 *  silently vanish if the "parent" was inside the removed subtree, which now
 *  correctly surfaces as "no such group" instead). */
const insertInto = (
  body: TreeBody,
  parentId: string | null,
  index: number | undefined,
  node: DashboardNode,
): TreeBody => {
  const root = body.children
  if (parentId === null) {
    const at = index ?? root.length
    return { ...body, children: [...root.slice(0, at), node, ...root.slice(at)] }
  }
  const parent = flattenNodes(body).find((f) => f.id === parentId)
  if (!parent)
    throw new CliError(
      `No group with id "${parentId}" (it may have just been removed).`,
      EXIT.notFound,
    )
  return {
    ...body,
    children: replaceAt(root, parent.path, (n) => {
      if (n.type !== "group")
        throw new CliError(`"${parentId}" is a widget, not a group.`, EXIT.usage)
      const at = index ?? n.children.length
      return { ...n, children: [...n.children.slice(0, at), node, ...n.children.slice(at)] }
    }),
  } as TreeBody
}

/** `--set key=value` value coercion: try JSON, fall back to the raw string.
 *  Gives correct types for free (`true`, `120`, `["a","b"]`) while
 *  `assignee=me` still lands as the string "me". */
const coerceJsonOrString = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const asArray = (v: unknown): ReadonlyArray<string> =>
  v === undefined ? [] : Array.isArray(v) ? (v as string[]) : [String(v)]

const STRUCTURAL_KEYS = new Set(["id", "type"])
const guardStructuralKey = (key: string): void => {
  if (STRUCTURAL_KEYS.has(key)) {
    throw new CliError(
      `"${key}" is structural and can't be changed with --set/--unset.`,
      EXIT.usage,
      key === "type" ? "To change a widget's type, remove it and add a new one." : undefined,
    )
  }
}

const SET_OPTIONS = {
  set: { type: "string" as const, multiple: true },
  unset: { type: "string" as const, multiple: true },
}

/** Shared body of `widget set` and `group set` — only the "does this ref
 *  actually match the expected node type" check differs between them. */
const runNodeSet = async (
  args: ReadonlyArray<string>,
  flags: Record<string, string | boolean | Array<string | boolean> | undefined>,
  dryRun: boolean,
  expect: "widget" | "group",
): Promise<void> => {
  const [dashName, ref] = args
  if (!dashName || !ref) throw new CliError(`Need <dashboard> <${expect}>.`, EXIT.usage)
  const pairs = parseKeyValuePairs(flags.set, "key=value")
  const unsets = asArray(flags.unset)
  if (pairs.length === 0 && unsets.length === 0) {
    throw new CliError("Nothing to set — pass --set key=value or --unset key.", EXIT.usage)
  }
  for (const [k] of pairs) guardStructuralKey(k)
  for (const k of unsets) guardStructuralKey(k)
  await withApi(async (api) => {
    const dashboard = await findDashboard(api, dashName)
    const body = requireTreeBody(dashboard)
    const target = findNode(flattenNodes(body), ref)
    const isGroup = target.type === "group"
    if (isGroup !== (expect === "group")) {
      throw new CliError(
        `"${ref}" is a ${isGroup ? "group" : "widget"}, not a ${expect}.`,
        EXIT.usage,
        `Use \`kahuna dashboard ${isGroup ? "group" : "widget"} set\` instead.`,
      )
    }
    const nextBody: TreeBody = {
      ...body,
      children: replaceAt(body.children, target.path, (n) => {
        const obj: Record<string, unknown> = { ...(n as unknown as Record<string, unknown>) }
        for (const [k, v] of pairs) obj[k] = coerceJsonOrString(v)
        for (const k of unsets) delete obj[k]
        return obj as unknown as DashboardNode
      }),
    }
    if (dryRun) {
      note(`Would update "${target.label ?? target.id}".`)
      return
    }
    await api.call((c) =>
      c.updateDashboard({
        id: dashboard.id,
        body: nextBody,
        expectedUpdatedAt: dashboard.updatedAt,
      }),
    )
    note(`Updated "${target.label ?? target.id}" on "${dashboard.name}".`)
  })
}

export const dashboardCommands: ReadonlyArray<Command> = [
  {
    path: "dashboard list",
    summary: "Every dashboard, including record-view templates",
    usage: "dashboard list [--json]",
    run: async (ctx) => {
      await withApi(async (api) => {
        const dashboards = await api.call((c) => c.listAllDashboards())
        printRows(
          ctx.format,
          dashboards.map((d) => ({
            name: d.name,
            icon: d.icon ?? "",
            kind: d.kind,
            scope: d.ownerId ? "personal" : "org",
            hidden: d.hidden ? "yes" : "",
            concept: d.conceptId ?? "",
            id: d.id,
          })),
          ["name", "icon", "kind", "scope", "hidden", "concept", "id"],
        )
      })
    },
  },
  {
    path: "dashboard create",
    summary: "Create a dashboard, empty or copied from another",
    usage:
      "dashboard create <name> [--from <dashboard>] [--icon <i>] [--scope org|personal] [--kind page|record] [--concept <c>]",
    options: {
      from: { type: "string" },
      icon: { type: "string" },
      scope: { type: "string" },
      kind: { type: "string" },
      concept: { type: "string" },
    },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A name is required.", EXIT.usage)
      const kindFlag = ctx.flags.kind as string | undefined
      if (kindFlag !== undefined && kindFlag !== "page" && kindFlag !== "record") {
        throw new CliError("--kind takes page or record.", EXIT.usage)
      }
      const conceptName = ctx.flags.concept as string | undefined
      if (kindFlag === "record" && !conceptName) {
        throw new CliError("--kind record needs --concept <c>.", EXIT.usage)
      }
      const scopeFlag = ctx.flags.scope as string | undefined
      if (scopeFlag !== undefined && scopeFlag !== "org" && scopeFlag !== "personal") {
        throw new CliError("--scope takes org or personal.", EXIT.usage)
      }
      const fromName = ctx.flags.from as string | undefined
      await withApi(async (api) => {
        let body: DashboardBody = { children: [] }
        let kind = kindFlag
        let conceptId: string | null | undefined
        let scope = scopeFlag ?? "org"
        if (fromName) {
          const source = await findDashboard(api, fromName)
          body = source.body
          kind = kindFlag ?? source.kind
          conceptId = source.conceptId
          scope = scopeFlag ?? (source.ownerId ? "personal" : "org")
        }
        if (kind === "record" && conceptName) {
          const concepts = await api.call((c) => c.listConcepts({}))
          conceptId = findConcept(concepts, conceptName).id
        }
        if (ctx.flags["dry-run"]) {
          note(
            `Would create dashboard "${name}"${fromName ? ` (from "${fromName}")` : ""} (${scope}).`,
          )
          return
        }
        const created = await api.call((c) =>
          c.createDashboard({
            name,
            icon: (ctx.flags.icon as string | undefined) ?? null,
            scope: scope as "org" | "personal",
            body,
            kind: kind as "page" | "record" | undefined,
            conceptId: conceptId ?? null,
          }),
        )
        note(`Created dashboard "${created.name}" (${created.id}).`)
      })
    },
  },
  {
    path: "dashboard update",
    summary: "Rename, re-icon, hide/show, or rescope a dashboard",
    usage:
      "dashboard update <dashboard> [--name <n>] [--icon <i>] [--hide | --show] [--scope org|personal]",
    options: {
      name: { type: "string" },
      icon: { type: "string" },
      hide: { type: "boolean" },
      show: { type: "boolean" },
      scope: { type: "string" },
    },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which dashboard?", EXIT.usage)
      if (ctx.flags.hide && ctx.flags.show)
        throw new CliError("Pass --hide or --show, not both.", EXIT.usage)
      const scope = ctx.flags.scope as string | undefined
      if (scope !== undefined && scope !== "org" && scope !== "personal") {
        throw new CliError("--scope takes org or personal.", EXIT.usage)
      }
      const patch: {
        name?: string
        icon?: string | null
        hidden?: boolean
        scope?: "org" | "personal"
      } = {}
      if (ctx.flags.name !== undefined) patch.name = ctx.flags.name as string
      if (ctx.flags.icon !== undefined) patch.icon = ctx.flags.icon as string
      if (ctx.flags.hide) patch.hidden = true
      if (ctx.flags.show) patch.hidden = false
      if (scope !== undefined) patch.scope = scope as "org" | "personal"
      if (Object.keys(patch).length === 0) {
        throw new CliError(
          "Nothing to update.",
          EXIT.usage,
          "Pass --name, --icon, --hide/--show, or --scope.",
        )
      }
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, name)
        if (ctx.flags["dry-run"]) {
          note(`Would update "${dashboard.name}".`)
          return
        }
        const updated = await api.call((c) =>
          c.updateDashboard({ id: dashboard.id, ...patch, expectedUpdatedAt: dashboard.updatedAt }),
        )
        note(`Updated "${updated.name}".`)
      })
    },
  },
  {
    path: "dashboard reorder",
    summary: "Reorder dashboards",
    usage: "dashboard reorder <dashboard> [<dashboard> ...]",
    run: async (ctx) => {
      const names = ctx.args
      if (names.length === 0) throw new CliError("Need at least one dashboard.", EXIT.usage)
      await withApi(async (api) => {
        const all = await api.call((c) => c.listAllDashboards())
        const named = names.map((n) => resolveDashboard(all, n))
        const scopeOf = (d: Dashboard): "org" | "personal" => (d.ownerId ? "personal" : "org")
        const scopes = new Set(named.map(scopeOf))
        if (scopes.size > 1) {
          throw new CliError(
            "Cannot reorder org and personal dashboards together.",
            EXIT.usage,
            "Org and personal dashboards are separate lists — reorder each in its own call.",
          )
        }
        const scope = [...scopes][0]
        const rest = all.filter((d) => scopeOf(d) === scope && !named.some((n) => n.id === d.id))
        const ordered = [...named, ...rest]
        if (ctx.flags["dry-run"]) {
          note(`Would order: ${ordered.map((d) => d.name).join(", ")}`)
          return
        }
        await api.call((c) =>
          c.reorderDashboards({ orders: ordered.map((d, i) => ({ id: d.id, position: i })) }),
        )
        note(`Reordered ${ordered.length} dashboards.`)
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
      await withApi(async (api) => {
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
  {
    path: "dashboard widget list",
    summary: "List every widget and group on a dashboard",
    usage: "dashboard widget list <dashboard>",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which dashboard?", EXIT.usage)
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, name)
        const body = requireTreeBody(dashboard)
        const flat = flattenNodes(body)
        if (flat.length === 0) {
          note("(empty)")
          return
        }
        printRows(
          ctx.format,
          flat.map((f) => ({
            path: "  ".repeat(f.depth) + (f.label ?? "(untitled)"),
            type: f.type,
            id: f.id,
          })),
          ["path", "type", "id"],
        )
      })
    },
  },
  {
    path: "dashboard widget get",
    summary: "Show one widget or group's full configuration",
    usage: "dashboard widget get <dashboard> <widget> [--json]",
    run: async (ctx) => {
      const [name, ref] = ctx.args
      if (!name || !ref) throw new CliError("Need <dashboard> <widget>.", EXIT.usage)
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, name)
        const body = requireTreeBody(dashboard)
        const target = findNode(flattenNodes(body), ref)
        const node = getAt(body.children, target.path)
        printOne(ctx.format, node as unknown as Record<string, unknown>)
      })
    },
  },
  {
    path: "dashboard widget types",
    summary: "List the widget kinds --type accepts",
    usage: "dashboard widget types",
    run: async (ctx) => {
      printRows(ctx.format, WIDGET_CATALOG, ["type", "description"])
    },
  },
  {
    path: "dashboard widget add",
    summary: "Add a widget to a dashboard",
    usage:
      "dashboard widget add <dashboard> --type <kind> [--parent <group>] [--title <t>] [--set key=value ...]",
    options: {
      type: { type: "string" },
      parent: { type: "string" },
      title: { type: "string" },
      set: { type: "string", multiple: true },
    },
    run: async (ctx) => {
      const [dashName] = ctx.args
      const kind = ctx.flags.type as string | undefined
      if (!dashName || !kind) throw new CliError("Need <dashboard> --type <kind>.", EXIT.usage)
      if (!WIDGET_KINDS.includes(kind as DashboardWidget["type"])) {
        throw new CliError(
          `Unknown widget type "${kind}".`,
          EXIT.usage,
          `Types: ${WIDGET_KINDS.join(", ")}`,
        )
      }
      const pairs = parseKeyValuePairs(ctx.flags.set, "key=value")
      for (const [k] of pairs) guardStructuralKey(k)
      const title = ctx.flags.title as string | undefined
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, dashName)
        const body = requireTreeBody(dashboard)
        const parentId = resolveParentId(body, ctx.flags.parent as string | undefined)
        const node: Record<string, unknown> = {
          id: crypto.randomUUID(),
          type: kind,
          title: title ?? null,
        }
        for (const [k, v] of pairs) node[k] = coerceJsonOrString(v)
        const nextBody = insertInto(body, parentId, undefined, node as unknown as DashboardNode)
        if (ctx.flags["dry-run"]) {
          note(`Would add a "${kind}" widget to "${dashboard.name}".`)
          return
        }
        await api.call((c) =>
          c.updateDashboard({
            id: dashboard.id,
            body: nextBody,
            expectedUpdatedAt: dashboard.updatedAt,
          }),
        )
        note(`Added a "${kind}" widget (${node.id}) to "${dashboard.name}".`)
      })
    },
  },
  {
    path: "dashboard widget set",
    summary: "Edit a widget's configuration",
    usage: "dashboard widget set <dashboard> <widget> [--set key=value ...] [--unset key ...]",
    options: SET_OPTIONS,
    run: async (ctx) => runNodeSet(ctx.args, ctx.flags, Boolean(ctx.flags["dry-run"]), "widget"),
  },
  {
    path: "dashboard widget remove",
    summary: "Remove a widget or group (and its contents) from a dashboard",
    usage: "dashboard widget remove <dashboard> <widget>",
    run: async (ctx) => {
      const [dashName, ref] = ctx.args
      if (!dashName || !ref) throw new CliError("Need <dashboard> <widget>.", EXIT.usage)
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, dashName)
        const body = requireTreeBody(dashboard)
        const target = findNode(flattenNodes(body), ref)
        const nextBody: TreeBody = { ...body, children: removeAt(body.children, target.path) }
        if (ctx.flags["dry-run"]) {
          note(`Would remove "${target.label ?? target.id}".`)
          return
        }
        await api.call((c) =>
          c.updateDashboard({
            id: dashboard.id,
            body: nextBody,
            expectedUpdatedAt: dashboard.updatedAt,
          }),
        )
        note(`Removed "${target.label ?? target.id}" from "${dashboard.name}".`)
      })
    },
  },
  {
    path: "dashboard widget move",
    summary: "Move a widget or group to a different parent",
    usage: "dashboard widget move <dashboard> <widget> --parent <group|root> [--index <n>]",
    options: { parent: { type: "string" }, index: { type: "string" } },
    run: async (ctx) => {
      const [dashName, ref] = ctx.args
      const parentToken = ctx.flags.parent as string | undefined
      if (!dashName || !ref || !parentToken) {
        throw new CliError("Need <dashboard> <widget> --parent <group|root>.", EXIT.usage)
      }
      const indexFlag = ctx.flags.index as string | undefined
      const index = indexFlag === undefined ? undefined : Number(indexFlag)
      if (index !== undefined && !Number.isInteger(index)) {
        throw new CliError("--index must be a whole number.", EXIT.usage)
      }
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, dashName)
        const body = requireTreeBody(dashboard)
        const target = findNode(flattenNodes(body), ref)
        const node = getAt(body.children, target.path)
        const afterRemoval: TreeBody = { ...body, children: removeAt(body.children, target.path) }
        const parentId = resolveParentId(afterRemoval, parentToken)
        const nextBody = insertInto(afterRemoval, parentId, index, node)
        if (ctx.flags["dry-run"]) {
          note(`Would move "${target.label ?? target.id}" under ${parentToken}.`)
          return
        }
        await api.call((c) =>
          c.updateDashboard({
            id: dashboard.id,
            body: nextBody,
            expectedUpdatedAt: dashboard.updatedAt,
          }),
        )
        note(`Moved "${target.label ?? target.id}" on "${dashboard.name}".`)
      })
    },
  },
  {
    path: "dashboard group add",
    summary: "Add a row/col container to a dashboard",
    usage:
      "dashboard group add <dashboard> --direction row|col [--parent <group>] [--label <l>] [--tabs]",
    options: {
      direction: { type: "string" },
      parent: { type: "string" },
      label: { type: "string" },
      tabs: { type: "boolean" },
    },
    run: async (ctx) => {
      const [dashName] = ctx.args
      const direction = ctx.flags.direction as string | undefined
      if (!dashName || !direction)
        throw new CliError("Need <dashboard> --direction row|col.", EXIT.usage)
      if (direction !== "row" && direction !== "col")
        throw new CliError("--direction takes row or col.", EXIT.usage)
      await withApi(async (api) => {
        const dashboard = await findDashboard(api, dashName)
        const body = requireTreeBody(dashboard)
        const parentId = resolveParentId(body, ctx.flags.parent as string | undefined)
        const node: DashboardGroup = {
          id: crypto.randomUUID(),
          type: "group",
          direction,
          label: (ctx.flags.label as string | undefined) ?? null,
          children: [],
          ...(ctx.flags.tabs ? { display: "tabs" as const } : {}),
        }
        const nextBody = insertInto(body, parentId, undefined, node)
        if (ctx.flags["dry-run"]) {
          note(`Would add a ${direction} group to "${dashboard.name}".`)
          return
        }
        await api.call((c) =>
          c.updateDashboard({
            id: dashboard.id,
            body: nextBody,
            expectedUpdatedAt: dashboard.updatedAt,
          }),
        )
        note(`Added a ${direction} group (${node.id}) to "${dashboard.name}".`)
      })
    },
  },
  {
    path: "dashboard group set",
    summary: "Edit a group's configuration",
    usage: "dashboard group set <dashboard> <group> [--set key=value ...] [--unset key ...]",
    options: SET_OPTIONS,
    run: async (ctx) => runNodeSet(ctx.args, ctx.flags, Boolean(ctx.flags["dry-run"]), "group"),
  },
]
