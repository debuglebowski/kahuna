import { useQuery } from "@tanstack/react-query"
import { Home, ListTodo, Settings, Users, Workflow } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import {
  api,
  type Concept,
  type Dashboard,
  type SidebarSection,
  type SidebarView,
  type SidebarViewBody,
} from "./api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "./icons"

/**
 * Client-side resolution of a sidebar View document into rendered nav entries.
 * The server only stores the (opaque) document; a section is an ordered list of
 * entry ids — dashboard uuids, `global:<key>` for the global nav items, and
 * `concept:<uuid>` for a single-record concept's page. All three are ordinary
 * section entries (globals are seeded into an untitled first section; any of them
 * is re-added via the "+" picker after removal).
 *
 * Entry ids are opaque `Schema.String` on the wire, so adding a kind needs no
 * contract change — but every consumer that interprets one (this file's
 * `resolveEntry`, SectionsEditor's `chipFor`, AddEntryPopover's option list) has
 * to learn it at the same time, or a placed entry renders as "missing".
 */

// ── global (static) nav targets ────────────────────────────────────────────────

export const GLOBAL_NAV: ReadonlyArray<{
  key: string
  label: string
  to: string
  icon: ReactNode
}> = [
  { key: "overview", label: "Overview", to: "/", icon: <Home size={16} /> },
  { key: "tasks", label: "Tasks", to: "/tasks", icon: <ListTodo size={16} /> },
  { key: "members", label: "Members", to: "/members", icon: <Users size={16} /> },
  { key: "automations", label: "Automations", to: "/automations", icon: <Workflow size={16} /> },
  { key: "settings", label: "Settings", to: "/settings", icon: <Settings size={16} /> },
]

/** A global nav item's entry id (`global:<key>`); everything else in
 *  `entryIds` is a dashboard uuid. */
const GLOBAL_PREFIX = "global:"
export const globalEntryId = (key: string) => `${GLOBAL_PREFIX}${key}`
export const isGlobalEntryId = (id: string) => id.startsWith(GLOBAL_PREFIX)
const globalByKey = new Map(GLOBAL_NAV.map((g) => [g.key, g] as const))
export const globalNavFor = (entryId: string) =>
  isGlobalEntryId(entryId) ? globalByKey.get(entryId.slice(GLOBAL_PREFIX.length)) : undefined

/** A single-record concept's entry id (`concept:<uuid>`). Keyed by id, not slug:
 *  a concept is fully renameable and its slug is only stable-by-convention, while
 *  the id never changes — see the id-as-key rule for concepts. */
const CONCEPT_PREFIX = "concept:"
export const conceptEntryId = (id: string) => `${CONCEPT_PREFIX}${id}`
export const isConceptEntryId = (id: string) => id.startsWith(CONCEPT_PREFIX)
export const conceptIdOfEntry = (entryId: string) =>
  isConceptEntryId(entryId) ? entryId.slice(CONCEPT_PREFIX.length) : undefined

/** The untitled section every fresh view starts with: all globals, on top. */
export const globalsSection = (id: string = crypto.randomUUID()): SidebarSection => ({
  id,
  title: null,
  icon: null,
  entryIds: GLOBAL_NAV.map((g) => globalEntryId(g.key)),
})

// ── resolved shapes ────────────────────────────────────────────────────────────

export interface ResolvedEntry {
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly to: string
  readonly active: boolean
}

export interface ResolvedSection {
  readonly id: string
  readonly title: string | null
  readonly icon: string | null
  readonly collapsed: boolean
  readonly entries: ResolvedEntry[]
}

// ── pure resolution ────────────────────────────────────────────────────────────

const isActive = (pathname: string, to: string) =>
  to === "/" ? pathname === "/" : pathname.startsWith(to)

const globalEntry = (g: (typeof GLOBAL_NAV)[number], pathname: string): ResolvedEntry => ({
  key: `g:${g.key}`,
  label: g.label,
  icon: g.icon,
  to: g.to,
  active: isActive(pathname, g.to),
})

const dashboardEntry = (d: Dashboard, pathname: string): ResolvedEntry => {
  const to = `/dashboards/${d.id}`
  return {
    key: `d:${d.id}`,
    label: d.name,
    icon: <ConceptIcon value={d.icon || "lucide:LayoutDashboard"} size={16} />,
    to,
    active: pathname === to,
  }
}

/** A single-record concept's page. Addressed by SLUG (`/c/<slug>`) even though the
 *  entry is keyed by id — the id survives renames, the slug is the readable URL. */
const conceptEntry = (c: Concept, pathname: string): ResolvedEntry => {
  const to = `/c/${c.slug}`
  return {
    key: `c:${c.id}`,
    label: c.name,
    icon: <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={16} />,
    to,
    active: pathname === to,
  }
}

/** One entry id → a rendered entry; null for deleted/hidden dashboards, unknown
 *  global keys, and concepts that no longer have a page (archived, or single record
 *  switched off — the entry id stays in the body, so switching the mode back on
 *  restores the entry rather than losing its placement). */
const resolveEntry = (
  id: string,
  ctx: {
    dashboards: ReadonlyMap<string, Dashboard> | readonly Dashboard[]
    concepts: ReadonlyMap<string, Concept> | readonly Concept[]
    pathname: string
  },
): ResolvedEntry | null => {
  const g = globalNavFor(id)
  if (g) return globalEntry(g, ctx.pathname)
  if (isGlobalEntryId(id)) return null
  const conceptId = conceptIdOfEntry(id)
  if (conceptId !== undefined) {
    const cById =
      ctx.concepts instanceof Map
        ? ctx.concepts
        : new Map((ctx.concepts as readonly Concept[]).map((c) => [c.id, c] as const))
    const c = cById.get(conceptId)
    return c && !c.archivedAt && c.singleRecord ? conceptEntry(c, ctx.pathname) : null
  }
  const byId =
    ctx.dashboards instanceof Map
      ? ctx.dashboards
      : new Map((ctx.dashboards as readonly Dashboard[]).map((d) => [d.id, d] as const))
  const d = byId.get(id)
  return d && !d.hidden ? dashboardEntry(d, ctx.pathname) : null
}

/** Resolve a view body's sections. Deleted/hidden dashboards, unknown global
 *  keys, unavailable concepts, and duplicate ids are skipped; the ids stay in the
 *  body. */
export const resolveView = (
  body: SidebarViewBody,
  ctx: {
    dashboards: readonly Dashboard[]
    concepts: readonly Concept[]
    pathname: string
  },
): ResolvedSection[] => {
  const byId = new Map(ctx.dashboards.map((d) => [d.id, d] as const))
  const cById = new Map(ctx.concepts.map((c) => [c.id, c] as const))
  return body.sections.map((section) => {
    const entries: ResolvedEntry[] = []
    const seen = new Set<string>()
    for (const id of section.entryIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const entry = resolveEntry(id, {
        dashboards: byId,
        concepts: cById,
        pathname: ctx.pathname,
      })
      if (entry) entries.push(entry)
    }
    return {
      id: section.id,
      title: section.title,
      icon: section.icon,
      collapsed: !!section.collapsed,
      entries,
    }
  })
}

// ── the built-in default view (fallback before the server seeds one) ──────────

export const DEFAULT_VIEW: SidebarView = {
  id: "__default__",
  ownerId: null,
  name: "Default",
  icon: "lucide:LayoutGrid",
  position: 0,
  hidden: false,
  body: { sections: [globalsSection("globals")] },
}

// ── live data loading ──────────────────────────────────────────────────────────

/** The live dashboards list every sidebar consumer resolves against. */
export function useDashboards(): readonly Dashboard[] {
  const q = useQuery({ queryKey: ["dashboards"], queryFn: () => api.listDashboards() })
  return q.data ?? []
}

/** The live concepts list — only the single-record ones are placeable, but the
 *  whole list is resolved against so an entry disappears the moment its concept
 *  is archived or leaves single-record mode. */
export function useConcepts(): readonly Concept[] {
  const q = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  return q.data ?? []
}

/** Resolve a view against the live dashboards + concepts lists. */
export function useResolvedView(view: SidebarView, pathname: string): ResolvedSection[] {
  const dashboards = useDashboards()
  const concepts = useConcepts()
  return useMemo(
    () => resolveView(view.body, { dashboards, concepts, pathname }),
    [view.body, dashboards, concepts, pathname],
  )
}
