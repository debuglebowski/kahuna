import {
  type CollisionDetection,
  closestCorners,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import { useRef, useState } from "react"
import type { SidebarSection } from "../../lib/api"

/**
 * Multi-container dnd for sidebar sections, driving the SectionsEditor in the
 * Settings → Sidebar ViewEditor (the sidebar itself is read-only). Sections
 * sort vertically; entries (dashboards and globals alike) sort within and
 * across sections.
 *
 * Entry sortable ids carry their container (`ent:<sectionId>:<entryId>`)
 * because the same entry may legally sit in two sections. When a drag moves
 * an entry across sections, the row keeps rendering under its ORIGINAL id (see
 * `uidFor`) so dnd-kit's active id stays alive for the whole gesture.
 */

export type ParsedId =
  | { type: "section"; sectionId: string }
  | { type: "entry"; sectionId: string; entryId: string }

export const secUid = (sectionId: string) => `sec:${sectionId}`
export const entUid = (sectionId: string, entryId: string) => `ent:${sectionId}:${entryId}`
export const dropUid = (sectionId: string) => `drop:${sectionId}`

export const parseUid = (raw: string): ParsedId | null => {
  if (raw.startsWith("sec:")) return { type: "section", sectionId: raw.slice(4) }
  if (raw.startsWith("drop:")) return { type: "section", sectionId: raw.slice(5) }
  if (raw.startsWith("ent:")) {
    const rest = raw.slice(4)
    // Cut at the FIRST colon: section ids never contain one, but a global
    // entry id does ("global:overview").
    const cut = rest.indexOf(":")
    if (cut > 0) {
      return { type: "entry", sectionId: rest.slice(0, cut), entryId: rest.slice(cut + 1) }
    }
  }
  return null
}

/** Collision detection for the whole gesture. A dragged SECTION must only
 *  collide with sibling sections — against the full droppable set the smaller,
 *  more numerous entry rows win `closestCorners`, the sortable strategy never
 *  sees a same-list `over`, and the push animation dies. Entry drags keep the
 *  full set (they target entries, empty-drops, and section headers alike). */
export const sectionsCollision: CollisionDetection = (args) => {
  if (String(args.active.id).startsWith("sec:")) {
    return closestCorners({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith("sec:")),
    })
  }
  return closestCorners(args)
}

export interface EntryDrag {
  type: "entry"
  /** The sortable id the gesture started with — stable for its whole life. */
  activeId: string
  entryId: string
  /** Where the entry currently sits (updated as it crosses sections). */
  sectionId: string
}
export interface SectionDrag {
  type: "section"
  sectionId: string
}
export type SectionsDrag = EntryDrag | SectionDrag

export const patchSections = (
  sections: readonly SidebarSection[],
  sectionId: string,
  patch: (s: SidebarSection) => SidebarSection,
): SidebarSection[] => sections.map((s) => (s.id === sectionId ? patch(s) : s))

const removeEntry = (
  sections: readonly SidebarSection[],
  sectionId: string,
  entryId: string,
): SidebarSection[] =>
  patchSections(sections, sectionId, (s) => ({
    ...s,
    entryIds: s.entryIds.filter((id) => id !== entryId),
  }))

/** Move an entry across sections; null = nothing to do (already in the target,
 *  or the target vanished). Inserts before `beforeId` or appends. */
const moveAcross = (
  sections: readonly SidebarSection[],
  fromId: string,
  toId: string,
  entryId: string,
  beforeId: string | null,
): SidebarSection[] | null => {
  const target = sections.find((s) => s.id === toId)
  if (!target || target.entryIds.includes(entryId)) return null
  const without = removeEntry(sections, fromId, entryId)
  return patchSections(without, toId, (s) => {
    const ids = [...s.entryIds]
    const at = beforeId ? ids.indexOf(beforeId) : -1
    ids.splice(at >= 0 ? at : ids.length, 0, entryId)
    return { ...s, entryIds: ids }
  })
}

/**
 * Wire up the gesture. `apply(next, commit)` receives every change:
 * `commit: false` for live previews mid-drag (and reverts on cancel/missed
 * drops — `next` is then the drag-start snapshot), `commit: true` exactly once
 * when a drop lands. Callers re-render with the applied sections, so the hook
 * always reads the latest list through the `sections` argument.
 */
export function useSectionsDnd(
  sections: readonly SidebarSection[],
  apply: (next: readonly SidebarSection[], commit: boolean) => void,
) {
  const [drag, setDrag] = useState<SectionsDrag | null>(null)
  const startRef = useRef<readonly SidebarSection[] | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  /** The id a rendered entry sorts under — the dragged entry keeps its original. */
  const uidFor = (sectionId: string, entryId: string) =>
    drag?.type === "entry" && drag.entryId === entryId && drag.sectionId === sectionId
      ? drag.activeId
      : entUid(sectionId, entryId)

  const onDragStart = (e: DragStartEvent) => {
    const parsed = parseUid(String(e.active.id))
    if (!parsed) return
    startRef.current = sections
    setDrag(
      parsed.type === "entry"
        ? {
            type: "entry",
            activeId: String(e.active.id),
            entryId: parsed.entryId,
            sectionId: parsed.sectionId,
          }
        : { type: "section", sectionId: parsed.sectionId },
    )
  }

  const onDragOver = (e: DragOverEvent) => {
    if (drag?.type !== "entry" || !e.over) return
    const overId = String(e.over.id)
    // Hovering the dragged row itself reports its ORIGINAL uid, whose embedded
    // section id goes stale after a cross-section move — treating it as a
    // target would ping-pong the entry between sections forever.
    if (overId === drag.activeId) return
    const over = parseUid(overId)
    if (!over || over.sectionId === drag.sectionId) return
    const next = moveAcross(
      sections,
      drag.sectionId,
      over.sectionId,
      drag.entryId,
      over.type === "entry" ? over.entryId : null,
    )
    if (!next) return
    apply(next, false)
    setDrag({ ...drag, sectionId: over.sectionId })
  }

  const onDragEnd = (e: DragEndEvent) => {
    const current = drag
    const start = startRef.current
    setDrag(null)
    startRef.current = null
    if (!current) return
    const over = e.over ? parseUid(String(e.over.id)) : null
    if (!over) {
      if (start) apply(start, false) // dropped nowhere — revert any preview
      return
    }
    if (current.type === "section") {
      const from = sections.findIndex((s) => s.id === current.sectionId)
      const to = sections.findIndex((s) => s.id === over.sectionId)
      if (from >= 0 && to >= 0 && from !== to) {
        apply(arrayMove([...sections], from, to), true)
      }
      return
    }
    // Entry: cross-section moves are already applied as previews; settle the
    // final within-section order, then commit whatever the gesture produced.
    let next: readonly SidebarSection[] = sections
    if (
      over.type === "entry" &&
      over.sectionId === current.sectionId &&
      over.entryId !== current.entryId
    ) {
      next = patchSections(sections, current.sectionId, (s) => {
        const from = s.entryIds.indexOf(current.entryId)
        const to = s.entryIds.indexOf(over.entryId)
        if (from < 0 || to < 0) return s
        return { ...s, entryIds: arrayMove([...s.entryIds], from, to) }
      })
    }
    apply(next, true)
  }

  const onDragCancel = () => {
    const start = startRef.current
    setDrag(null)
    startRef.current = null
    if (start) apply(start, false)
  }

  return { drag, sensors, uidFor, onDragStart, onDragOver, onDragEnd, onDragCancel }
}
