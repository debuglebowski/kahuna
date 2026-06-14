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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, GripVertical, Pencil, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { Navigate, useNavigate, useParams } from "react-router-dom"
import { DashboardEditor } from "@/components/dashboard/DashboardEditor"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { conceptIndex } from "@/lib/conceptData"
import { Badge, Button, Card, IconButton, Spinner, Toolbar } from "../../components/ui"
import { api, type Concept, type Dashboard } from "../../lib/api"
import { ConceptIcon } from "../../lib/icons"

/** THE management surface for dashboards: create, reorder (`position` drives the
 *  switcher order and the default landing), and edit — a row's pencil opens the
 *  full-page {@link DashboardEditor} (name/icon/scope/visibility/delete + the
 *  widget layout) at /settings/dashboards/:id. The dashboard pages themselves
 *  are read-only. */
export function Dashboards() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { id } = useParams()
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
  })
  // The editor's Layout tab renders the real widget canvas — it needs the
  // concept collection just like the dashboard pages do.
  const conceptsLive = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const concepts = (conceptsLive.data ?? []) as Concept[]
  const conceptsLoaded = !!conceptsLive.data
  const cIndex = useMemo(() => conceptIndex(concepts), [concepts])

  const [filter, setFilter] = useState("")
  const sorted = [...(dashboards ?? [])].sort((a, b) => a.position - b.position)
  const q = filter.trim().toLowerCase()
  const filtered = q ? sorted.filter((d) => d.name.toLowerCase().includes(q)) : sorted
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const createMut = useMutation({
    mutationFn: () =>
      api.createDashboard({ name: "New dashboard", scope: "personal", body: { widgets: [] } }),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      navigate(`/settings/dashboards/${d.id}`) // name it first — opens on General
    },
  })
  const reorderMut = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderDashboards(orders),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards"] }),
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

  // Detail route (/settings/dashboards/:id) — the full-page editor takes over.
  if (id) {
    const dash = dashboards.find((d) => d.id === id)
    if (!dash) return <Navigate to="/settings/dashboards" replace />
    return (
      <DashboardEditor
        key={dash.id}
        dash={dash}
        // The last shared dashboard can't be deleted — keep the home non-empty.
        canDelete={!(dash.ownerId === null && sorted.filter((d) => !d.ownerId).length <= 1)}
        concepts={concepts}
        cIndex={cIndex}
        conceptsLoaded={conceptsLoaded}
      />
    )
  }

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
                <DashboardRow
                  key={d.id}
                  dash={d}
                  sortable={!q}
                  onOpen={() => navigate(`/dashboards/${d.id}`)}
                  onEdit={() => navigate(`/settings/dashboards/${d.id}`)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

function DashboardRow({
  dash,
  sortable,
  onOpen,
  onEdit,
}: {
  dash: Dashboard
  sortable: boolean
  onOpen: () => void
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
      <IconButton aria-label="Open dashboard" onClick={onOpen}>
        <ArrowUpRight size={15} />
      </IconButton>
      <IconButton aria-label="Edit dashboard" onClick={onEdit}>
        <Pencil size={15} />
      </IconButton>
    </div>
  )
}
