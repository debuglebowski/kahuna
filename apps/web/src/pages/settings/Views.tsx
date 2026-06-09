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
import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { IconPicker } from "../../components/IconPicker"
import { SectionList } from "../../components/sidebar/SectionList"
import {
  Badge,
  Button,
  Card,
  Drawer,
  Field,
  IconButton,
  Input,
  Spinner,
  Toolbar,
} from "../../components/ui"
import { api, type SidebarSection, type SidebarView } from "../../lib/api"
import { conceptsCollection, sidebarViewsCollection } from "../../lib/collections"
import { ConceptIcon } from "../../lib/icons"

const refetchViews = () => sidebarViewsCollection.utils.refetch()

/** Manage the org's and your personal sidebar Views (the same editor the
 *  in-sidebar edit mode uses, plus scope/visibility/order controls). */
export function Views() {
  const { data: views } = useLiveQuery((q) => q.from({ v: sidebarViewsCollection }))
  const { data: concepts } = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  const [editing, setEditing] = useState<SidebarView | null>(null)
  const [filter, setFilter] = useState("")
  const sorted = [...(views ?? [])].sort((a, b) => a.position - b.position)
  // Filtering shows a subset of the position-ordered list, so drag-reorder is
  // disabled while a filter is active (positions wouldn't be meaningful).
  const q = filter.trim().toLowerCase()
  const filtered = q ? sorted.filter((v) => v.name.toLowerCase().includes(q)) : sorted
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const createMut = useMutation({
    mutationFn: () =>
      api.createView({ name: "New view", scope: "personal", body: { sections: [] } }),
    onSuccess: async (v) => {
      await refetchViews()
      setEditing(v)
    },
  })
  const reorderMut = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderViews(orders),
    onSuccess: refetchViews,
  })

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = sorted.findIndex((v) => v.id === active.id)
    const to = sorted.findIndex((v) => v.id === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(sorted, from, to)
    reorderMut.mutate(next.map((v, i) => ({ id: v.id, position: i })))
  }

  if (!views) return <Spinner />

  return (
    <div className="space-y-4">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter views…">
        <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
          <Plus size={15} /> New view
        </Button>
      </Toolbar>

      {filtered.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {q
            ? `No views match "${filter.trim()}".`
            : "No views yet — the default layout is shown. Views are configurable sidebar layouts you switch between via the pager; org views are shared with everyone, personal views are only yours."}
        </Card>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={filtered.map((v) => v.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {filtered.map((v) => (
                <ViewRow key={v.id} view={v} sortable={!q} onEdit={() => setEditing(v)} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {editing && (
        <ViewEditor
          view={editing}
          concepts={concepts ?? []}
          // The last shared (Default) view can't be deleted — keep the list non-empty.
          canDelete={!(editing.ownerId === null && sorted.filter((v) => !v.ownerId).length <= 1)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function ViewRow({
  view,
  sortable,
  onEdit,
}: {
  view: SidebarView
  sortable: boolean
  onEdit: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.id,
    disabled: !sortable,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 ${
        isDragging ? "opacity-60 shadow" : ""
      }`}
    >
      <button
        type="button"
        className={
          sortable
            ? "cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            : "cursor-default text-muted-foreground/40"
        }
        aria-label="Drag to reorder"
        disabled={!sortable}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <ConceptIcon value={view.icon || "lucide:LayoutGrid"} size={16} />
      <span className="flex-1 truncate text-sm font-medium text-foreground">
        {view.name || <span className="text-muted-foreground">(untitled view)</span>}
      </span>
      <Badge tone={view.ownerId ? "gray" : "blue"}>{view.ownerId ? "Personal" : "Org"}</Badge>
      {view.hidden && <Badge tone="amber">Hidden</Badge>}
      <IconButton aria-label="Edit view" onClick={onEdit}>
        <Pencil size={15} />
      </IconButton>
    </div>
  )
}

function ViewEditor({
  view,
  concepts,
  canDelete,
  onClose,
}: {
  view: SidebarView
  concepts: readonly import("../../lib/api").Concept[]
  canDelete: boolean
  onClose: () => void
}) {
  const [name, setName] = useState(view.name)
  const [icon, setIcon] = useState<string | null>(view.icon)
  const [scope, setScope] = useState<"personal" | "org">(view.ownerId ? "personal" : "org")
  const [hidden, setHidden] = useState(view.hidden)
  const [sections, setSections] = useState<SidebarSection[]>([...view.body.sections])

  const save = useMutation({
    mutationFn: () =>
      api.updateView({ id: view.id, name: name.trim(), icon, scope, hidden, body: { sections } }),
    onSuccess: async () => {
      await refetchViews()
      onClose()
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteView(view.id),
    onSuccess: async () => {
      await refetchViews()
      onClose()
    },
  })

  return (
    <Drawer
      title="Edit view"
      onClose={onClose}
      headerAction={
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <IconPicker value={icon} onChange={setIcon} />
          <div className="flex-1">
            <Field label="Name (optional)">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="View name…"
              />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Scope">
            <Select value={scope} onValueChange={(v) => setScope(v as "personal" | "org")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Personal (only me)</SelectItem>
                <SelectItem value="org">Org (everyone)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Visibility">
            <Select
              value={hidden ? "hidden" : "shown"}
              onValueChange={(v) => setHidden(v === "hidden")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shown">Shown in pager</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="Sections">
          <SectionList sections={sections} concepts={concepts} onChange={setSections} />
        </Field>

        <div className="border-t border-border pt-3">
          <Button
            variant="destructive"
            onClick={() => del.mutate()}
            disabled={del.isPending || !canDelete}
            title={canDelete ? undefined : "The last shared view can't be deleted."}
          >
            <Trash2 size={15} /> {del.isPending ? "Deleting…" : "Delete view"}
          </Button>
          {!canDelete && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              This is the last shared view — it can't be deleted.
            </p>
          )}
        </div>
      </div>
    </Drawer>
  )
}
