import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Plus, Settings } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { WidgetCanvas } from "@/components/dashboard/WidgetCanvas"
import { WidgetEditor } from "@/components/dashboard/WidgetEditor"
import { Button, IconButton, Spinner } from "@/components/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardWidget } from "@/lib/api"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { conceptIndex, useConceptData } from "@/lib/conceptData"
import {
  addWidget,
  newWidget,
  referencedConceptIds,
  removeWidget,
  updateWidget,
} from "@/lib/dashboards"
import { useDashboardBody } from "@/lib/useDashboardBody"

/**
 * The dashboard canvas (`/dashboards`). Renders the selected dashboard as a grid of
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
  const conceptsLoaded = !!conceptsLive.data
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

  const { body, mutate, onStop, conflict, dismissConflict } = useDashboardBody(selected)

  const ids = useMemo(() => (body ? referencedConceptIds(body) : []), [body])
  const { instData, loaders } = useConceptData(ids)

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
              <SelectItem value="trend">Trend</SelectItem>
              <SelectItem value="activity">Activity</SelectItem>
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

      {conflict && (
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <span>
            This dashboard was changed elsewhere — reloaded to the latest; your last edit wasn't
            saved.
          </span>
          <button
            type="button"
            className="cancel-drag shrink-0 underline hover:text-foreground"
            onClick={dismissConflict}
          >
            Dismiss
          </button>
        </div>
      )}

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
        <WidgetCanvas
          body={body}
          instData={instData}
          cIndex={cIndex}
          conceptsLoaded={conceptsLoaded}
          onStop={onStop}
          onEdit={setEditingId}
          onRemove={(id) => mutate(removeWidget(body, id))}
        />
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
