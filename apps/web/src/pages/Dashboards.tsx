import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Pencil, Plus, Settings, X } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import GridLayout, { type Layout, WidthProvider } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"
import { useNavigate } from "react-router-dom"
import { AttentionWidget } from "@/components/dashboard/AttentionWidget"
import { ListWidget } from "@/components/dashboard/ListWidget"
import { MetricWidget } from "@/components/dashboard/MetricWidget"
import { WidgetEditor } from "@/components/dashboard/WidgetEditor"
import { Button, IconButton, Spinner } from "@/components/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardBody, type DashboardWidget } from "@/lib/api"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { conceptIndex, useConceptData } from "@/lib/conceptData"
import {
  addWidget,
  applyLayouts,
  GRID_COLS,
  GRID_ROW_HEIGHT,
  newWidget,
  referencedConceptIds,
  removeWidget,
  updateWidget,
  widgetLayouts,
} from "@/lib/dashboards"

const Grid = WidthProvider(GridLayout)

// Lazy so recharts' bundle is only fetched when a chart widget is on screen.
const BreakdownWidget = lazy(() =>
  import("@/components/dashboard/BreakdownWidget").then((m) => ({ default: m.BreakdownWidget })),
)

/**
 * The dashboard canvas (`/`). Renders the selected dashboard as a grid of
 * resizable widgets, with a switcher across the org's + your dashboards. The body
 * is the source of truth: drag/resize and add/edit/remove mutate it locally and
 * persist via `updateDashboard` (last-write-wins). Dashboard-level management
 * (rename/scope/visibility/delete/reorder) lives in Settings → Dashboards.
 */
export function Dashboards() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const conceptsLive = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const concepts = (conceptsLive.data ?? []) as Concept[]
  const cIndex = useMemo(() => conceptIndex(concepts), [concepts])

  // Loading the list seeds the org's Home dashboard server-side (ensureDefault).
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(() => {
    const all = dashboards ?? []
    if (selectedId) return all.find((d) => d.id === selectedId) ?? all[0] ?? null
    // Default landing: the lowest-position org-shared dashboard, else the first.
    return (
      all.filter((d) => d.ownerId === null).sort((a, b) => a.position - b.position)[0] ??
      all[0] ??
      null
    )
  }, [dashboards, selectedId])

  // Local working copy of the body; (re)loaded only when the selected id changes,
  // so live refetches never clobber in-flight edits.
  const [body, setBody] = useState<DashboardBody | null>(null)
  const loadedId = useRef<string | null>(null)
  useEffect(() => {
    if (selected && loadedId.current !== selected.id) {
      loadedId.current = selected.id
      setBody(selected.body)
    }
  }, [selected])

  const ids = useMemo(() => (body ? referencedConceptIds(body) : []), [body])
  const { instData, loaders } = useConceptData(ids)

  const save = useCallback(
    (next: DashboardBody) => {
      if (selected) void api.updateDashboard({ id: selected.id, body: next })
    },
    [selected],
  )
  const mutate = useCallback(
    (next: DashboardBody) => {
      setBody(next)
      save(next)
    },
    [save],
  )
  const onStop = useCallback(
    (layout: Layout[]) => {
      setBody((cur) => {
        if (!cur) return cur
        const next = applyLayouts(cur, layout)
        save(next)
        return next
      })
    },
    [save],
  )

  const createDash = useMutation({
    mutationFn: () =>
      api.createDashboard({ name: "New dashboard", scope: "personal", body: { widgets: [] } }),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      setSelectedId(d.id)
    },
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = body?.widgets.find((w) => w.id === editingId) ?? null

  if (!body) return <Spinner />

  const addOfType = (type: DashboardWidget["type"]) => {
    const w = newWidget(body, type)
    mutate(addWidget(body, w))
    setEditingId(w.id) // open the editor immediately to pick a concept + configure
  }

  const render = (w: DashboardWidget) => {
    const data = w.conceptId ? instData[w.conceptId] : undefined
    if (w.type === "metric")
      return (
        <MetricWidget
          widget={w}
          data={data}
          concept={w.conceptId ? cIndex.get(w.conceptId) : undefined}
        />
      )
    if (w.type === "list") return <ListWidget widget={w} data={data} />
    if (w.type === "attention")
      return (
        <AttentionWidget
          widget={w}
          data={data}
          concept={w.conceptId ? cIndex.get(w.conceptId) : undefined}
        />
      )
    if (w.type === "breakdown")
      return (
        <Suspense fallback={<Spinner />}>
          <BreakdownWidget widget={w} data={data} />
        </Suspense>
      )
    return <p className="text-sm text-muted-foreground">{w.type} widget — coming soon</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {loaders}
      <header className="flex items-center justify-between gap-2">
        <Select value={selected?.id ?? ""} onValueChange={setSelectedId}>
          <SelectTrigger className="cancel-drag border-0 px-0 text-xl font-semibold shadow-none focus-visible:ring-0">
            <SelectValue placeholder="Dashboard" />
          </SelectTrigger>
          <SelectContent>
            {(dashboards ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
                {d.ownerId ? " · personal" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Select value="" onValueChange={(t) => addOfType(t as DashboardWidget["type"])}>
            <SelectTrigger className="cancel-drag" size="sm">
              <Plus size={14} />
              <SelectValue placeholder="Add widget" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="metric">Metric</SelectItem>
              <SelectItem value="list">List / Table</SelectItem>
              <SelectItem value="breakdown">Breakdown</SelectItem>
              <SelectItem value="attention">Attention</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => createDash.mutate()}
            disabled={createDash.isPending}
          >
            <Plus size={14} /> New
          </Button>
          <IconButton
            aria-label="Manage dashboards"
            onClick={() => navigate("/settings/dashboards")}
          >
            <Settings size={15} />
          </IconButton>
        </div>
      </header>

      {body.widgets.length === 0 ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center">
          <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LayoutDashboard size={20} />
          </div>
          <h2 className="mb-1 text-lg font-medium text-foreground">An empty canvas</h2>
          <p className="max-w-sm text-sm text-balance text-muted-foreground">
            Add a metric or list to start. Drag and resize tiles to lay out your dashboard.
          </p>
        </div>
      ) : (
        <Grid
          className="-mx-1"
          layout={widgetLayouts(body)}
          cols={GRID_COLS}
          rowHeight={GRID_ROW_HEIGHT}
          margin={[12, 12]}
          draggableCancel=".cancel-drag"
          onDragStop={onStop}
          onResizeStop={onStop}
          isBounded
        >
          {body.widgets.map((w) => (
            <div
              key={w.id}
              className="group flex flex-col overflow-hidden rounded-xl border bg-card p-3 shadow-sm"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {w.title || (w.conceptId ? cIndex.get(w.conceptId)?.name : "") || w.type}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Edit widget"
                    className="cancel-drag rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    onClick={() => setEditingId(w.id)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove widget"
                    className="cancel-drag rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    onClick={() => mutate(removeWidget(body, w.id))}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1">{render(w)}</div>
            </div>
          ))}
        </Grid>
      )}

      {editing && (
        <WidgetEditor
          widget={editing}
          concepts={concepts}
          onSave={(w) => mutate(updateWidget(body, w.id, w))}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}
