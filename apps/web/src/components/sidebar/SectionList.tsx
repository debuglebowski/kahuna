import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import type { Concept, SidebarSection } from "../../lib/api"
import { ConceptIcon } from "../../lib/icons"
import { IconButton } from "../ui"
import { newSection, SectionEditor } from "./SectionEditor"

/** Drag-sortable list of a view's sections, with per-section edit/delete + add. */
export function SectionList({
  sections,
  concepts,
  onChange,
}: {
  sections: readonly SidebarSection[]
  concepts: readonly Concept[]
  onChange: (next: SidebarSection[]) => void
}) {
  const [editing, setEditing] = useState<SidebarSection | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = sections.findIndex((s) => s.id === active.id)
    const to = sections.findIndex((s) => s.id === over.id)
    if (from >= 0 && to >= 0) onChange(arrayMove([...sections], from, to))
  }

  const upsert = (s: SidebarSection) =>
    onChange(
      sections.some((x) => x.id === s.id)
        ? sections.map((x) => (x.id === s.id ? s : x))
        : [...sections, s],
    )

  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {sections.map((s) => (
              <Row
                key={s.id}
                section={s}
                concepts={concepts}
                onEdit={() => setEditing(s)}
                onDelete={() => onChange(sections.filter((x) => x.id !== s.id))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={() => setEditing(newSection())}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-input py-2 text-xs font-medium text-muted-foreground hover:border-ring hover:text-foreground"
      >
        <Plus size={14} /> Add section
      </button>

      {editing && (
        <SectionEditor
          section={editing}
          concepts={concepts}
          onSave={upsert}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

const describe = (s: SidebarSection, concepts: readonly Concept[]): string => {
  const src = s.source
  switch (src.kind) {
    case "static":
      return `${src.items.length} global item${src.items.length === 1 ? "" : "s"}`
    case "group": {
      const pinned = src.members.length
      return `${pinned} pinned · ${src.rules.length} rule${src.rules.length === 1 ? "" : "s"}`
    }
    case "list": {
      const c = concepts.find((x) => x.id === src.conceptId)
      return `list · ${c ? c.pluralName || c.name : "no concept"}`
    }
    case "links":
      return `${src.items.length} link${src.items.length === 1 ? "" : "s"}`
  }
}

function Row({
  section,
  concepts,
  onEdit,
  onDelete,
}: {
  section: SidebarSection
  concepts: readonly Concept[]
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 ${
        isDragging ? "opacity-60 shadow" : ""
      }`}
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      {section.icon && <ConceptIcon value={section.icon} size={15} />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {section.title || "(untitled section)"}
        </div>
        <div className="truncate text-xs text-muted-foreground">{describe(section, concepts)}</div>
      </div>
      <IconButton aria-label="Edit section" onClick={onEdit}>
        <Pencil size={14} />
      </IconButton>
      <IconButton aria-label="Delete section" variant="danger" onClick={onDelete}>
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}
