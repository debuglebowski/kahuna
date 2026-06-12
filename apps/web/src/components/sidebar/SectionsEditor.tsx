import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Plus, Trash2, X } from "lucide-react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Dashboard, SidebarSection } from "../../lib/api"
import { ConceptIcon } from "../../lib/icons"
import { globalNavFor, isGlobalEntryId } from "../../lib/sidebarViews"
import { cn } from "../../lib/utils"
import { IconPicker } from "../IconPicker"
import { Badge, IconButton, Input } from "../ui"
import { AddEntryPopover } from "./AddEntryPopover"
import { dropUid, patchSections, sectionsCollision, secUid, useSectionsDnd } from "./sectionsDnd"

/**
 * Flat, fully-visible editor for a view's sections (Settings → Sidebar modal):
 * every section card shows its entries inline — global nav items and dashboards
 * alike. Drag rows within/between cards, drag cards to reorder, edit title/icon
 * in place, "+" to add, × to remove. Controlled: `onChange(next, commit)`
 * mirrors the sectionsDnd contract (commit=false for mid-drag previews/reverts).
 */
export function SectionsEditor({
  sections,
  dashboards,
  onChange,
}: {
  sections: readonly SidebarSection[]
  dashboards: readonly Dashboard[]
  onChange: (next: readonly SidebarSection[], commit: boolean) => void
}) {
  const byId = new Map(dashboards.map((d) => [d.id, d] as const))
  const dnd = useSectionsDnd(sections, onChange)
  const commit = (next: readonly SidebarSection[]) => onChange(next, true)

  const overlayEntry = dnd.drag?.type === "entry" ? dnd.drag.entryId : null
  const overlaySection =
    dnd.drag?.type === "section"
      ? (sections.find((s) => s.id === dnd.drag?.sectionId) ?? null)
      : null

  const chipFor = (entryId: string) => {
    const g = globalNavFor(entryId)
    if (g) return { name: g.label, icon: g.icon, hidden: false, missing: false }
    const d = byId.get(entryId)
    return {
      name: d?.name,
      icon: <ConceptIcon value={d?.icon || "lucide:LayoutDashboard"} size={15} />,
      hidden: !!d?.hidden,
      missing: !d && !isGlobalEntryId(entryId),
    }
  }

  return (
    <div className="space-y-2">
      <DndContext
        sensors={dnd.sensors}
        collisionDetection={sectionsCollision}
        onDragStart={dnd.onDragStart}
        onDragOver={dnd.onDragOver}
        onDragEnd={dnd.onDragEnd}
        onDragCancel={dnd.onDragCancel}
      >
        <SortableContext
          items={sections.map((s) => secUid(s.id))}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {sections.map((section) => (
              <SectionCard
                key={section.id}
                section={section}
                chipFor={chipFor}
                dashboards={dashboards}
                uidFor={dnd.uidFor}
                onPatch={(patch) =>
                  commit(patchSections(sections, section.id, (s) => ({ ...s, ...patch })))
                }
                onDelete={() => commit(sections.filter((s) => s.id !== section.id))}
              />
            ))}
          </div>
        </SortableContext>

        {/* Portaled to <body>: the dialog's centering transform makes it the
            containing block for position:fixed, which would offset the ghost
            from the pointer. */}
        {createPortal(
          <DragOverlay>
            {overlayEntry ? (
              <EntryChip {...chipFor(overlayEntry)} dragging />
            ) : overlaySection ? (
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium shadow-md">
                {overlaySection.icon && <ConceptIcon value={overlaySection.icon} size={14} />}
                <span className="truncate">{overlaySection.title || "(untitled section)"}</span>
                <span className="text-xs text-muted-foreground">
                  {overlaySection.entryIds.length}
                </span>
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      <button
        type="button"
        onClick={() =>
          commit([...sections, { id: crypto.randomUUID(), title: null, icon: null, entryIds: [] }])
        }
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-input py-2 text-xs font-medium text-muted-foreground hover:border-ring hover:text-foreground"
      >
        <Plus size={14} /> Add section
      </button>
    </div>
  )
}

function SectionCard({
  section,
  chipFor,
  dashboards,
  uidFor,
  onPatch,
  onDelete,
}: {
  section: SidebarSection
  chipFor: (entryId: string) => {
    name: string | undefined
    icon: ReactNode
    hidden: boolean
    missing: boolean
  }
  dashboards: readonly Dashboard[]
  uidFor: (sectionId: string, entryId: string) => string
  onPatch: (patch: Partial<SidebarSection>) => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: secUid(section.id),
    data: { type: "section" },
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("rounded-md border border-border bg-background", isDragging && "opacity-40")}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label="Drag to reorder section"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} />
        </button>
        <IconPicker value={section.icon} onChange={(icon) => onPatch({ icon })} />
        <Input
          value={section.title ?? ""}
          placeholder="Section title (optional)…"
          onChange={(e) => onPatch({ title: e.target.value || null })}
          className="h-7 flex-1 text-sm"
        />
        <AddEntryPopover
          dashboards={dashboards}
          excludeIds={section.entryIds}
          onPick={(id) => onPatch({ entryIds: [...section.entryIds, id] })}
        >
          <IconButton aria-label="Add item">
            <Plus size={14} />
          </IconButton>
        </AddEntryPopover>
        <IconButton aria-label="Delete section" variant="danger" onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      </div>

      <div className="space-y-1 p-1.5">
        <SortableContext
          items={section.entryIds.map((id) => uidFor(section.id, id))}
          strategy={verticalListSortingStrategy}
        >
          {section.entryIds.map((id) => (
            <EntryCard
              key={id}
              uid={uidFor(section.id, id)}
              chip={chipFor(id)}
              onRemove={() => onPatch({ entryIds: section.entryIds.filter((x) => x !== id) })}
            />
          ))}
          {section.entryIds.length === 0 && <EmptyDrop sectionId={section.id} />}
        </SortableContext>
      </div>
    </div>
  )
}

function EntryCard({
  uid,
  chip,
  onRemove,
}: {
  uid: string
  chip: { name: string | undefined; icon: ReactNode; hidden: boolean; missing: boolean }
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: uid,
    data: { type: "entry" },
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
    >
      <EntryChip
        {...chip}
        grip={
          <button
            type="button"
            className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            aria-label="Drag to move"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>
        }
        onRemove={onRemove}
      />
    </div>
  )
}

/** One entry row — also the drag-overlay ghost (then without affordances). */
function EntryChip({
  name,
  icon,
  hidden,
  missing,
  grip,
  onRemove,
  dragging,
}: {
  name: string | undefined
  icon: ReactNode
  hidden?: boolean
  missing?: boolean
  grip?: ReactNode
  onRemove?: () => void
  dragging?: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5",
        dragging && "shadow-md",
      )}
    >
      {grip}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {missing || !name ? (
          <span className="text-muted-foreground italic">(deleted dashboard)</span>
        ) : (
          name
        )}
      </span>
      {hidden && <Badge tone="amber">Hidden</Badge>}
      {onRemove && (
        <IconButton aria-label="Remove from section" onClick={onRemove}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

/** Drop target for an empty section (otherwise it has no droppable area). */
function EmptyDrop({ sectionId }: { sectionId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: dropUid(sectionId) })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md border border-dashed border-input px-3 py-2 text-center text-xs text-muted-foreground",
        isOver && "border-ring text-foreground",
      )}
    >
      Drop items here, or add with “+”
    </div>
  )
}
