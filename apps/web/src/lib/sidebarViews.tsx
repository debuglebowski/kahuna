import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { Home, LayoutDashboard, Link as LinkIcon, Settings, Users, Workflow } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import {
  api,
  type Concept,
  type Field,
  type Instance,
  type SidebarCondition,
  type SidebarView,
  type SidebarViewBody,
} from "./api"
import { useSession } from "./auth-client"
import { instancesByConcept, KEY, useRegisterCollection } from "./collections"
import { type ConditionMatch, matchInstance } from "./conditions"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "./icons"
import { isRichTextEmpty, richTextPreview } from "./richtext"
import { showValue } from "./utils"

/**
 * Client-side resolution of a sidebar View document into rendered nav entries.
 * The server only stores the (opaque) document; everything here runs against the
 * live concept/instance collections, so smart groups/lists react to data changes
 * with no reload. `useResolvedView` mounts the instance collections a view needs
 * and hands back the resolved sections plus the loader nodes to render.
 */

// ── static (global) nav targets ────────────────────────────────────────────────

const GLOBAL_ITEMS: Record<string, { label: string; to: string; icon: ReactNode }> = {
  overview: { label: "Overview", to: "/", icon: <Home size={16} /> },
  dashboards: { label: "Dashboards", to: "/dashboards", icon: <LayoutDashboard size={16} /> },
  members: { label: "Members", to: "/members", icon: <Users size={16} /> },
  automations: { label: "Automations", to: "/automations", icon: <Workflow size={16} /> },
  settings: { label: "Settings", to: "/settings", icon: <Settings size={16} /> },
}

// ── resolved shapes ────────────────────────────────────────────────────────────

export interface ResolvedEntry {
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly to: string
  readonly active: boolean
  /** External URL — render as a plain anchor, not a router link. */
  readonly external: boolean
}

export interface ResolvedSection {
  readonly id: string
  readonly title: string | null
  readonly icon: string | null
  readonly collapsed: boolean
  readonly entries: ResolvedEntry[]
}

export interface ConceptInstanceData {
  readonly instances: readonly Instance[]
  readonly fields: readonly Field[]
}

interface ResolveCtx {
  readonly concepts: readonly Concept[]
  readonly instData: Record<string, ConceptInstanceData>
  readonly pathname: string
  /** Current user id (resolves `isMe` conditions); null when no session yet. */
  readonly me?: string | null
}

// ── matching helpers ─────────────────────────────────────────────────────────--
// Instance matching is the shared evaluator in `conditions.ts`.

/** Concepts only support the label ops (against their static/default label sets). */
const matchConcept = (
  concept: Concept,
  conds: readonly SidebarCondition[],
  match?: ConditionMatch,
): boolean => {
  const has = (c: SidebarCondition) => {
    const id = String(c.value)
    const carried = concept.staticLabelIds.includes(id) || concept.defaultLabelIds.includes(id)
    return c.op === "hasLabel" ? carried : c.op === "notHasLabel" ? !carried : false
  }
  return match === "any" && conds.length > 0 ? conds.some(has) : conds.every(has)
}

/** A display name for an instance: its first non-empty text field, else its
 *  first non-empty rich text field, else any non-synthetic string value, else
 *  a placeholder (mirrors the detail view). */
export const instanceLabel = (inst: Instance, fields: readonly Field[]): string => {
  const text = fields.find((f) => f.kind === "text" && inst.state[f.id])
  if (text) return showValue(inst.state[text.id])
  const rich = fields.find((f) => f.kind === "richtext" && !isRichTextEmpty(inst.state[f.id]))
  if (rich) return richTextPreview(inst.state[rich.id], 80)
  for (const [k, v] of Object.entries(inst.state)) {
    if (!k.startsWith("__") && typeof v === "string" && v) return v
  }
  return "(untitled)"
}

// ── pure resolution ──────────────────────────────────────────────────────────--

export const resolveView = (body: SidebarViewBody, ctx: ResolveCtx): ResolvedSection[] => {
  const conceptById = new Map(ctx.concepts.map((c) => [c.id, c] as const))
  const isActive = (to: string) => (to === "/" ? ctx.pathname === "/" : ctx.pathname.startsWith(to))

  const conceptEntry = (c: Concept): ResolvedEntry => {
    const to = `/concepts/${c.id}`
    return {
      key: `c:${c.id}`,
      label: c.pluralName || c.name,
      icon: <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={16} />,
      to,
      active: ctx.pathname === to,
      external: false,
    }
  }
  const instanceEntry = (
    inst: Instance,
    fields: readonly Field[],
    concept: Concept | undefined,
  ): ResolvedEntry => {
    const to = `/instances/${inst.id}`
    return {
      key: `i:${inst.id}`,
      label: instanceLabel(inst, fields),
      icon: <ConceptIcon value={concept?.icon || "lucide:CircleDot"} size={16} />,
      to,
      active: ctx.pathname === to,
      external: false,
    }
  }

  return body.sections.map((section) => {
    const entries: ResolvedEntry[] = []
    const seen = new Set<string>()
    const push = (e: ResolvedEntry) => {
      if (seen.has(e.to)) return
      seen.add(e.to)
      entries.push(e)
    }

    const src = section.source
    if (src.kind === "static") {
      for (const key of src.items) {
        const g = GLOBAL_ITEMS[key]
        if (g)
          push({
            key: `s:${key}`,
            label: g.label,
            icon: g.icon,
            to: g.to,
            active: isActive(g.to),
            external: false,
          })
      }
    } else if (src.kind === "links") {
      for (const l of src.items) {
        const external = /^https?:\/\//.test(l.to)
        push({
          key: `l:${l.id}`,
          label: l.label,
          icon: l.icon ? <ConceptIcon value={l.icon} size={16} /> : <LinkIcon size={16} />,
          to: l.to,
          active: !external && isActive(l.to),
          external,
        })
      }
    } else if (src.kind === "list") {
      const data = ctx.instData[src.conceptId]
      const concept = conceptById.get(src.conceptId)
      const fields = data?.fields ?? []
      let rows = (data?.instances ?? []).filter((i) =>
        matchInstance(i, src.conditions, { match: src.match, me: ctx.me }),
      )
      const orderBy = src.orderBy
      rows = [...rows].sort((a, b) =>
        orderBy
          ? showValue(a.state[orderBy]).localeCompare(showValue(b.state[orderBy]))
          : instanceLabel(a, fields).localeCompare(instanceLabel(b, fields)),
      )
      if (src.limit && src.limit > 0) rows = rows.slice(0, src.limit)
      for (const inst of rows) push(instanceEntry(inst, fields, concept))
    } else if (src.kind === "group") {
      // Manual members first, in their drag order.
      for (const m of src.members) {
        if (m.kind === "concept") {
          const c = conceptById.get(m.conceptId)
          if (c) push(conceptEntry(c))
        } else {
          const data = ctx.instData[m.conceptId]
          const inst = data?.instances.find((i) => i.id === m.instanceId)
          if (inst) push(instanceEntry(inst, data?.fields ?? [], conceptById.get(m.conceptId)))
        }
      }
      // Then rule-derived members (concepts then instances), each sorted by label.
      const conceptMatches: Concept[] = []
      const instMatches: { inst: Instance; fields: readonly Field[]; concept?: Concept }[] = []
      for (const rule of src.rules) {
        if (rule.target === "concepts") {
          for (const c of ctx.concepts)
            if (matchConcept(c, rule.conditions, rule.match)) conceptMatches.push(c)
        } else {
          const data = ctx.instData[rule.conceptId]
          const concept = conceptById.get(rule.conceptId)
          for (const inst of data?.instances ?? [])
            if (matchInstance(inst, rule.conditions, { match: rule.match, me: ctx.me }))
              instMatches.push({ inst, fields: data?.fields ?? [], concept })
        }
      }
      conceptMatches.sort((a, b) => (a.pluralName || a.name).localeCompare(b.pluralName || b.name))
      for (const c of conceptMatches) push(conceptEntry(c))
      instMatches.sort((a, b) =>
        instanceLabel(a.inst, a.fields).localeCompare(instanceLabel(b.inst, b.fields)),
      )
      for (const m of instMatches) push(instanceEntry(m.inst, m.fields, m.concept))
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

/** Concept ids whose instances a view needs loaded (item rules / lists / pins). */
export const referencedConceptIds = (body: SidebarViewBody): string[] => {
  const ids = new Set<string>()
  for (const s of body.sections) {
    const src = s.source
    if (src.kind === "list") ids.add(src.conceptId)
    else if (src.kind === "group") {
      for (const m of src.members) if (m.kind === "instance") ids.add(m.conceptId)
      for (const r of src.rules) if (r.target === "items") ids.add(r.conceptId)
    }
  }
  return [...ids]
}

// ── the built-in default view (== today's sidebar; never persisted until edited) ─

export const DEFAULT_VIEW: SidebarView = {
  id: "__default__",
  ownerId: null,
  name: "Default",
  icon: "lucide:LayoutGrid",
  position: 0,
  hidden: false,
  body: {
    sections: [
      {
        id: "globals",
        title: null,
        icon: null,
        source: {
          kind: "static",
          items: ["overview", "dashboards", "members", "automations", "settings"],
        },
      },
      {
        id: "concepts",
        title: "Concepts",
        icon: null,
        // A smart group with an unconditional concepts rule == every concept.
        source: { kind: "group", members: [], rules: [{ target: "concepts", conditions: [] }] },
      },
    ],
  },
}

// ── live data loading ────────────────────────────────────────────────────────--

function ConceptDataLoader({
  conceptId,
  onData,
}: {
  conceptId: string
  onData: (id: string, d: ConceptInstanceData) => void
}) {
  const col = instancesByConcept(conceptId)
  useRegisterCollection(KEY.instances(conceptId), col)
  const live = useLiveQuery((q) => q.from({ i: col }), [col])
  const fields = useQuery({
    queryKey: ["fields", conceptId],
    queryFn: () => api.listFields(conceptId),
    enabled: !!conceptId,
  })
  useEffect(() => {
    onData(conceptId, {
      instances: live.data ?? [],
      fields: (fields.data ?? []) as readonly Field[],
    })
  }, [conceptId, live.data, fields.data, onData])
  return null
}

/**
 * Resolve a view against live data. Returns the rendered sections plus `loaders`
 * — invisible components the caller must render, which mount the instance
 * collections the view depends on (and keep them live-synced).
 */
export function useResolvedView(
  view: SidebarView,
  concepts: readonly Concept[],
  pathname: string,
): { sections: ResolvedSection[]; loaders: ReactNode } {
  const [instData, setInstData] = useState<Record<string, ConceptInstanceData>>({})
  const onData = useCallback((id: string, d: ConceptInstanceData) => {
    setInstData((prev) =>
      prev[id]?.instances === d.instances && prev[id]?.fields === d.fields
        ? prev
        : { ...prev, [id]: d },
    )
  }, [])
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const needed = useMemo(() => referencedConceptIds(view.body), [view.body])
  const sections = useMemo(
    () => resolveView(view.body, { concepts, instData, pathname, me }),
    [view.body, concepts, instData, pathname, me],
  )
  const loaders = (
    <>
      {needed.map((cid) => (
        <ConceptDataLoader key={cid} conceptId={cid} onData={onData} />
      ))}
    </>
  )
  return { sections, loaders }
}
