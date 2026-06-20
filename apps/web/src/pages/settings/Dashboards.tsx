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
import { ChevronDown, GripVertical, Plus } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { DashboardEditor } from "@/components/dashboard/DashboardEditor"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { conceptIndex } from "@/lib/conceptData"
import { buildUsageForest, type DashboardGrouping, type UsageNode } from "@/lib/dashboardGrouping"
import { migrate, referencedDashboardIds } from "@/lib/dashboards"
import { Badge, Button, Card, Spinner, Toolbar } from "../../components/ui"
import { api, type Concept, type Dashboard } from "../../lib/api"
import { ConceptIcon } from "../../lib/icons"

const GROUP_KEY = "km:dash:groupBy"
const readGrouping = (): DashboardGrouping => {
  const v = localStorage.getItem(GROUP_KEY)
  return v === "none" || v === "type" || v === "usage" ? v : "usage"
}

/** The settings editor URL for a dashboard — record dashboards carry their concept
 *  so the editor opens in record mode. */
const editorHref = (d: Dashboard): string =>
  d.kind === "record" && d.conceptId
    ? `/settings/dashboards/${d.id}?concept=${d.conceptId}`
    : `/settings/dashboards/${d.id}`

/** THE management surface for dashboards: create, reorder (`position` drives the
 *  switcher order and the default landing), and edit — clicking a row opens the
 *  full-page {@link DashboardEditor} (name/icon/scope/visibility/delete + the
 *  widget layout) at /settings/dashboards/:id. The dashboard pages themselves
 *  are read-only. */
export function Dashboards() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  // A `?concept=` param routes the editor to a record dashboard of that concept
  // (record dashboards live per-concept, not in the page-dashboard switcher).
  const recordConceptId = searchParams.get("concept")
  // One query for every dashboard (page + record) — the list groups across both.
  // Keyed under ["dashboards", …] so a page-dashboard mutation's ["dashboards"]
  // invalidation refreshes it too.
  const { data: allDash } = useQuery({
    queryKey: ["dashboards", "all"],
    queryFn: () => api.listAllDashboards(),
  })
  // The editor's Layout tab renders the real widget canvas — it needs the
  // concept collection just like the dashboard pages do.
  const conceptsLive = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const concepts = (conceptsLive.data ?? []) as Concept[]
  const conceptsLoaded = !!conceptsLive.data
  const cIndex = useMemo(() => conceptIndex(concepts), [concepts])
  const recordDashboards = useMemo(
    () => (allDash ?? []).filter((d) => d.kind === "record"),
    [allDash],
  )
  // Each concept's DEFAULT record view (its first by position) — what a list/kanban
  // set to "Default record view" opens rows with, for the usage grouping.
  const defaultViewByConcept = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of [...recordDashboards].sort((a, b) => a.position - b.position)) {
      if (d.conceptId && !m.has(d.conceptId)) m.set(d.conceptId, d.id)
    }
    return m
  }, [recordDashboards])

  const [filter, setFilter] = useState("")
  const [groupBy, setGroupBy] = useState<DashboardGrouping>(readGrouping)
  const setGroup = (g: DashboardGrouping) => {
    setGroupBy(g)
    localStorage.setItem(GROUP_KEY, g)
  }
  // Page dashboards keep their switcher position order; record dashboards sort by
  // concept then position.
  const pageDashboards = useMemo(
    () =>
      (allDash ?? []).filter((d) => d.kind !== "record").sort((a, b) => a.position - b.position),
    [allDash],
  )
  const sortedRecords = useMemo(
    () =>
      [...recordDashboards].sort((a, b) => {
        const an = cIndex.get(a.conceptId ?? "")?.name ?? ""
        const bn = cIndex.get(b.conceptId ?? "")?.name ?? ""
        // Group by concept, then the concept's own view order (position).
        return an.localeCompare(bn) || a.position - b.position
      }),
    [recordDashboards, cIndex],
  )
  const allDashboards = useMemo(
    () => [...pageDashboards, ...sortedRecords],
    [pageDashboards, sortedRecords],
  )
  const byId = useMemo(() => new Map(allDashboards.map((d) => [d.id, d])), [allDashboards])
  const q = filter.trim().toLowerCase()
  const matches = (d: Dashboard) => d.name.toLowerCase().includes(q)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const createMut = useMutation({
    mutationFn: () =>
      api.createDashboard({ name: "New dashboard", scope: "personal", body: { widgets: [] } }),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      navigate(`/settings/dashboards/${d.id}`) // name it first — opens on General
    },
  })
  // Record views are bound to a concept (chosen at creation, immutable after). The
  // first view a concept gets is its default. Managed concepts can't have them.
  const recordableConcepts = useMemo(
    () =>
      concepts
        .filter((c) => !c.managedBy && !c.archivedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [concepts],
  )
  const createRecordMut = useMutation({
    mutationFn: (conceptId: string) =>
      api.createDashboard({
        name: `${cIndex.get(conceptId)?.name ?? "Record"} view`,
        scope: "org",
        body: { widgets: [] },
        kind: "record",
        conceptId,
      }),
    onSuccess: async (d) => {
      // Refresh the list (["dashboards","all"]) AND the per-concept caches the
      // concept editor / record page read.
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      await qc.invalidateQueries({ queryKey: ["recordDashboards", d.conceptId] })
      navigate(`/settings/dashboards/${d.id}?concept=${d.conceptId}`)
    },
  })
  const reorderMut = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderDashboards(orders),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards"] }),
  })

  // Reorder applies to PAGE dashboards only (they drive the switcher order); record
  // dashboards aren't draggable.
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = pageDashboards.findIndex((d) => d.id === active.id)
    const to = pageDashboards.findIndex((d) => d.id === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(pageDashboards, from, to)
    reorderMut.mutate(next.map((d, i) => ({ id: d.id, position: i })))
  }

  if (!allDash) return <Spinner />

  // Record-dashboard editor (/settings/dashboards/:id?concept=<id>) — a per-concept
  // template, edited with the same chrome as any dashboard (back → the list).
  if (id && recordConceptId) {
    const dash = allDash.find((d) => d.id === id)
    if (!dash) return <Navigate to={`/settings/concepts/${recordConceptId}?tab=layout`} replace />
    return (
      // Key on the concept too: repointing the view (?concept=) remounts the editor
      // with a fresh draft from the now-reset body.
      <DashboardEditor
        key={`${dash.id}:${recordConceptId}`}
        dash={dash}
        canDelete
        concepts={concepts}
        cIndex={cIndex}
        conceptsLoaded={conceptsLoaded}
        recordMode
        recordConceptId={recordConceptId}
      />
    )
  }

  // Detail route (/settings/dashboards/:id) — the full-page editor takes over.
  if (id) {
    const dash = allDash.find((d) => d.id === id)
    if (!dash) return <Navigate to="/settings/dashboards" replace />
    return (
      <DashboardEditor
        key={dash.id}
        dash={dash}
        // The last shared dashboard can't be deleted — keep the home non-empty.
        canDelete={!(dash.ownerId === null && pageDashboards.filter((d) => !d.ownerId).length <= 1)}
        concepts={concepts}
        cIndex={cIndex}
        conceptsLoaded={conceptsLoaded}
      />
    )
  }

  // A record dashboard's row — concept name + default badge, opens in record mode.
  const recordRow = (d: Dashboard, depth = 0) => (
    <DashboardRow
      key={d.id}
      dash={d}
      sortable={false}
      depth={depth}
      conceptName={cIndex.get(d.conceptId ?? "")?.name ?? null}
      onOpen={() => navigate(editorHref(d))}
    />
  )
  // Page dashboards in a drag-to-reorder context (the switcher order).
  const pageSection = (rows: Dashboard[]) => (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1.5">
          {rows.map((d) => (
            <DashboardRow key={d.id} dash={d} sortable onOpen={() => navigate(editorHref(d))} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )

  let body: ReactNode
  if (q) {
    // Filtering flattens everything (grouping + reorder off while searching).
    const hits = allDashboards.filter(matches)
    body =
      hits.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          No dashboards match "{filter.trim()}".
        </Card>
      ) : (
        <div className="space-y-1.5">{hits.map((d) => recordRow(d))}</div>
      )
  } else if (allDashboards.length === 0) {
    body = (
      <Card className="p-6 text-sm text-muted-foreground">
        No dashboards yet. Dashboards are grid canvases of widgets; org dashboards are shared with
        everyone, personal ones are only yours.
      </Card>
    )
  } else if (groupBy === "usage") {
    const forest = buildUsageForest(
      allDashboards.map((d) => ({
        id: d.id,
        refs: referencedDashboardIds(migrate(d.body), defaultViewByConcept),
      })),
    )
    const rows = flattenForest(forest, byId)
    body = (
      <div className="space-y-1.5">
        {rows.map(({ dash, depth, key }) => (
          <DashboardRow
            key={key}
            dash={dash}
            sortable={false}
            depth={depth}
            conceptName={dash.conceptId ? (cIndex.get(dash.conceptId)?.name ?? null) : null}
            onOpen={() => navigate(editorHref(dash))}
          />
        ))}
      </div>
    )
  } else if (groupBy === "type") {
    body = (
      <div className="space-y-6">
        <Section title="General" count={pageDashboards.length}>
          {pageDashboards.length > 0 ? (
            pageSection(pageDashboards)
          ) : (
            <p className="px-1 text-sm text-muted-foreground">No general dashboards.</p>
          )}
        </Section>
        <Section title="Concept" count={sortedRecords.length}>
          {sortedRecords.length > 0 ? (
            <div className="space-y-1.5">{sortedRecords.map((d) => recordRow(d))}</div>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">
              No record views yet — create them from a concept's Layout tab.
            </p>
          )}
        </Section>
      </div>
    )
  } else {
    // none — one flat list: page dashboards (reorderable) then record dashboards.
    body = (
      <div className="space-y-1.5">
        {pageSection(pageDashboards)}
        {sortedRecords.map((d) => recordRow(d))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter dashboards…">
        <Select value={groupBy} onValueChange={(v) => setGroup(v as DashboardGrouping)}>
          <SelectTrigger className="h-8 w-[150px]" aria-label="Group dashboards by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="usage">Group: Usage</SelectItem>
            <SelectItem value="type">Group: Type</SelectItem>
            <SelectItem value="none">Group: None</SelectItem>
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={createMut.isPending || createRecordMut.isPending}>
              <Plus size={15} /> New <ChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[60vh] overflow-y-auto">
            <DropdownMenuItem onSelect={() => createMut.mutate()}>Page dashboard</DropdownMenuItem>
            {recordableConcepts.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Record view for…</DropdownMenuLabel>
                {recordableConcepts.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => createRecordMut.mutate(c.id)}>
                    <ConceptIcon value={c.icon || "lucide:Box"} size={14} />
                    {c.name}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Toolbar>
      {body}
    </div>
  )
}

/** A flat, indent-bearing render order for the usage forest. Keys are path-based
 *  so a dashboard nested under several parents (duplicated) stays unique. */
function flattenForest(
  forest: ReadonlyArray<UsageNode>,
  byId: Map<string, Dashboard>,
): { dash: Dashboard; depth: number; key: string }[] {
  const out: { dash: Dashboard; depth: number; key: string }[] = []
  const walk = (n: UsageNode, depth: number, prefix: string) => {
    const dash = byId.get(n.id)
    if (!dash) return
    const key = `${prefix}/${n.id}`
    out.push({ dash, depth, key })
    for (const c of n.children) walk(c, depth + 1, key)
  }
  for (const n of forest) walk(n, 0, "")
  return out
}

/** A titled group section with a count. */
function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-normal">{count}</span>
      </h3>
      {children}
    </section>
  )
}

function DashboardRow({
  dash,
  sortable,
  onOpen,
  depth = 0,
  conceptName = null,
}: {
  dash: Dashboard
  sortable: boolean
  onOpen: () => void
  /** Nesting indent for the usage tree. */
  depth?: number
  /** The owning concept's name (record dashboards) — shown as a badge. */
  conceptName?: string | null
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dash.id,
    disabled: !sortable,
  })
  const isRecord = dash.kind === "record"
  // The grip and the rest of the row are sibling buttons: the grip drags, the
  // content button opens the editor. Clicking the grip can never navigate, and
  // dragging is bound only to the grip — so the "whole row except the handle"
  // is the click target.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, marginLeft: depth * 20 }}
      className={`flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 hover:bg-accent ${
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
      <button
        type="button"
        onClick={onOpen}
        className="-my-2 flex flex-1 items-center gap-2 py-2 text-left"
      >
        <ConceptIcon value={dash.icon || "lucide:LayoutDashboard"} size={16} />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {dash.name || <span className="text-muted-foreground">(untitled dashboard)</span>}
        </span>
        {/* Concept + hidden first; the scope (Personal/Org) pill is always rightmost. */}
        {isRecord && conceptName && <Badge tone="green">{conceptName}</Badge>}
        {dash.hidden && <Badge tone="amber">Hidden</Badge>}
        <Badge tone={dash.ownerId ? "gray" : "blue"}>{dash.ownerId ? "Personal" : "Org"}</Badge>
      </button>
    </div>
  )
}
