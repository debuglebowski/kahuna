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
import { GripVertical, PanelLeft, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { IconPicker } from "../../components/IconPicker"
import { SectionsEditor } from "../../components/sidebar/SectionsEditor"
import { ViewNav } from "../../components/sidebar/ViewNav"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Spinner,
  TabRail,
  TabRailItem,
  Toolbar,
} from "../../components/ui"
import { api, type SidebarSection, type SidebarView } from "../../lib/api"
import { sidebarViewsCollection } from "../../lib/collections"
import { ConceptIcon } from "../../lib/icons"
import { globalsSection, resolveView, useDashboards } from "../../lib/sidebarViews"

const refetchViews = () => sidebarViewsCollection.utils.refetch()

/** Manage the org's and your personal sidebar Views (the same editor the
 *  in-sidebar edit mode uses, plus scope/visibility/order controls). */
export function Views() {
  const { data: views } = useLiveQuery((q) => q.from({ v: sidebarViewsCollection }))
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
      // Fresh views start with the untitled globals section on top.
      api.createView({
        name: "New view",
        scope: "personal",
        body: { sections: [globalsSection()] },
      }),
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
  canDelete,
  onClose,
}: {
  view: SidebarView
  canDelete: boolean
  onClose: () => void
}) {
  const [name, setName] = useState(view.name)
  const [icon, setIcon] = useState<string | null>(view.icon)
  const [scope, setScope] = useState<"personal" | "org">(view.ownerId ? "personal" : "org")
  const [hidden, setHidden] = useState(view.hidden)
  const [sections, setSections] = useState<SidebarSection[]>([...view.body.sections])
  const [dirty, setDirty] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Every edit goes through one of these so the discard confirm only fires
  // when the draft actually diverged.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v)
      setDirty(true)
    }

  // Sections edit in place (dnd previews don't dirty the draft; commits do).
  const dashboards = useDashboards()
  const applySections = (next: readonly SidebarSection[], commit: boolean) => {
    setSections([...next])
    if (commit) setDirty(true)
  }
  // Live preview of the draft, rendered exactly like the sidebar. The neutral
  // pathname keeps every entry inactive.
  const previewSections = useMemo(
    () => resolveView({ sections }, { dashboards, pathname: "" }),
    [sections, dashboards],
  )

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

  const requestClose = () => (dirty ? setConfirmingClose(true) : onClose())

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[85vh] w-[min(1080px,96vw)] flex-col gap-0 p-0 sm:max-w-none"
      >
        <Tabs defaultValue="general" orientation="vertical" className="min-h-0 flex-1 gap-0">
          <TabRail
            title={
              <DialogTitle className="block truncate text-sm font-semibold">
                {name.trim() || "Edit view"}
              </DialogTitle>
            }
          >
            <TabRailItem value="general" icon={<SlidersHorizontal size={16} />}>
              General
            </TabRailItem>
            <TabRailItem value="sections" icon={<PanelLeft size={16} />}>
              Sections
            </TabRailItem>
          </TabRail>

          <TabsContent value="general" className="min-h-0 flex-1 overflow-y-auto p-6 pb-24">
            <div className="space-y-4">
              <div className="flex items-end gap-2">
                <IconPicker value={icon} onChange={edit(setIcon)} />
                <div className="flex-1">
                  <Field label="Name (optional)">
                    <Input
                      value={name}
                      onChange={(e) => edit(setName)(e.target.value)}
                      placeholder="View name…"
                    />
                  </Field>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Scope">
                  <Select
                    value={scope}
                    onValueChange={(v) => edit(setScope)(v as "personal" | "org")}
                  >
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
                    onValueChange={(v) => edit(setHidden)(v === "hidden")}
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

              <Card className="border-destructive/40">
                <CardHeader title={<span className="text-destructive">Danger zone</span>} />
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Delete this view</p>
                    <p className="text-xs text-muted-foreground">
                      {canDelete
                        ? "Removes the layout and its sections permanently. Dashboards are unaffected."
                        : "This is the last shared view — it can't be deleted."}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={del.isPending || !canDelete}
                  >
                    <Trash2 size={14} /> Delete
                  </Button>
                </div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="sections" className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-y-auto p-6 pb-24">
              <div className="mb-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Sections
              </div>
              <SectionsEditor
                sections={sections}
                dashboards={dashboards}
                onChange={applySections}
              />
            </div>
            {/* Live preview — the draft rendered exactly like the real sidebar,
                as a floating card beside the editor. */}
            <aside className="hidden w-72 shrink-0 overflow-y-auto p-6 pb-24 pl-0 sm:block">
              <div className="mb-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Preview
              </div>
              <div className="rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm">
                <div className="pointer-events-none px-2 py-3">
                  <ViewNav sections={previewSections} collapsed={false} />
                </div>
              </div>
            </aside>
          </TabsContent>
        </Tabs>

        <div className="pointer-events-none absolute right-6 bottom-6 z-10 flex flex-col items-end gap-2">
          {save.error && (
            <p className="pointer-events-auto max-w-md rounded-md border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive shadow-lg">
              {(save.error as Error).message}
            </p>
          )}
          <div className="pointer-events-auto flex gap-2">
            <Button variant="outline" className="shadow-lg" onClick={requestClose}>
              Cancel
            </Button>
            <Button className="shadow-lg" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>

      {confirmingClose && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your edits to this view haven't been saved."
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={onClose}
          onCancel={() => setConfirmingClose(false)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete view?"
          message={`"${name.trim() || "Untitled view"}" and its sections will be permanently deleted.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? (del.error as Error).message : undefined}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </Dialog>
  )
}
