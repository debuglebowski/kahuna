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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
import { api, type Dashboard } from "../../lib/api"
import { ConceptIcon } from "../../lib/icons"

/** Manage the org's and your personal dashboards (name, icon, scope, visibility,
 *  order, delete). Widget layout is edited on the dashboard canvas itself. */
export function Dashboards() {
  const qc = useQueryClient()
  const refetch = () => qc.invalidateQueries({ queryKey: ["dashboards"] })
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
  })
  const [editing, setEditing] = useState<Dashboard | null>(null)
  const [filter, setFilter] = useState("")
  const sorted = [...(dashboards ?? [])].sort((a, b) => a.position - b.position)
  const q = filter.trim().toLowerCase()
  const filtered = q ? sorted.filter((d) => d.name.toLowerCase().includes(q)) : sorted
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const createMut = useMutation({
    mutationFn: () =>
      api.createDashboard({ name: "New dashboard", scope: "personal", body: { widgets: [] } }),
    onSuccess: async (d) => {
      await refetch()
      setEditing(d)
    },
  })
  const reorderMut = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderDashboards(orders),
    onSuccess: refetch,
  })

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = sorted.findIndex((d) => d.id === active.id)
    const to = sorted.findIndex((d) => d.id === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(sorted, from, to)
    reorderMut.mutate(next.map((d, i) => ({ id: d.id, position: i })))
  }

  if (!dashboards) return <Spinner />

  return (
    <div className="space-y-4">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter dashboards…">
        <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
          <Plus size={15} /> New dashboard
        </Button>
      </Toolbar>

      {filtered.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {q
            ? `No dashboards match "${filter.trim()}".`
            : "No dashboards yet. Dashboards are grid canvases of widgets; org dashboards are shared with everyone, personal ones are only yours."}
        </Card>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={filtered.map((d) => d.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {filtered.map((d) => (
                <DashboardRow key={d.id} dash={d} sortable={!q} onEdit={() => setEditing(d)} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {editing && (
        <DashboardEditor
          dash={editing}
          // The last shared dashboard can't be deleted — keep the home non-empty.
          canDelete={!(editing.ownerId === null && sorted.filter((d) => !d.ownerId).length <= 1)}
          onClose={() => setEditing(null)}
          onChanged={refetch}
        />
      )}
    </div>
  )
}

function DashboardRow({
  dash,
  sortable,
  onEdit,
}: {
  dash: Dashboard
  sortable: boolean
  onEdit: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dash.id,
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
      <ConceptIcon value={dash.icon || "lucide:LayoutDashboard"} size={16} />
      <span className="flex-1 truncate text-sm font-medium text-foreground">
        {dash.name || <span className="text-muted-foreground">(untitled dashboard)</span>}
      </span>
      <Badge tone={dash.ownerId ? "gray" : "blue"}>{dash.ownerId ? "Personal" : "Org"}</Badge>
      {dash.hidden && <Badge tone="amber">Hidden</Badge>}
      <IconButton aria-label="Edit dashboard" onClick={onEdit}>
        <Pencil size={15} />
      </IconButton>
    </div>
  )
}

function DashboardEditor({
  dash,
  canDelete,
  onClose,
  onChanged,
}: {
  dash: Dashboard
  canDelete: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState(dash.name)
  const [icon, setIcon] = useState<string | null>(dash.icon)
  const [scope, setScope] = useState<"personal" | "org">(dash.ownerId ? "personal" : "org")
  const [hidden, setHidden] = useState(dash.hidden)

  const save = useMutation({
    mutationFn: () => api.updateDashboard({ id: dash.id, name: name.trim(), icon, scope, hidden }),
    onSuccess: async () => {
      onChanged()
      onClose()
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteDashboard(dash.id),
    onSuccess: async () => {
      onChanged()
      onClose()
    },
  })

  return (
    <Drawer
      title="Edit dashboard"
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
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dashboard name…"
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
                <SelectItem value="shown">Shown in switcher</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          Add and arrange widgets on the dashboard canvas.
        </p>

        <div className="border-t border-border pt-3">
          <Button
            variant="destructive"
            onClick={() => del.mutate()}
            disabled={del.isPending || !canDelete}
            title={canDelete ? undefined : "The last shared dashboard can't be deleted."}
          >
            <Trash2 size={15} /> {del.isPending ? "Deleting…" : "Delete dashboard"}
          </Button>
          {!canDelete && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              This is the last shared dashboard — it can't be deleted.
            </p>
          )}
        </div>
      </div>
    </Drawer>
  )
}
