import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { Button, Spinner } from "@/components/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardWidget } from "@/lib/api"
import { conceptIndex, useConceptData } from "@/lib/conceptData"
import {
  addWidget,
  newWidget,
  referencedConceptIds,
  removeWidget,
  updateWidget,
} from "@/lib/dashboards"
import { useDashboardBody } from "@/lib/useDashboardBody"
import { WidgetCanvas } from "./WidgetCanvas"
import { WidgetEditor } from "./WidgetEditor"

/**
 * A per-concept summary dashboard, rendered as a tab on a ConceptView. Reuses the
 * whole widget engine with the concept as IMPLICIT context: widgets omit their
 * own `conceptId` and resolve to this concept (so a summary body is concept-
 * agnostic + reusable). Stored as a normal dashboard whose `body.scopeConceptId`
 * marks it; kept out of the standalone dashboard switcher.
 */
export function ConceptSummary({
  conceptId,
  concepts,
  conceptsLoaded,
}: {
  conceptId: string
  concepts: readonly Concept[]
  conceptsLoaded: boolean
}) {
  const qc = useQueryClient()
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
  })
  const summary = (dashboards ?? []).find((d) => d.body.scopeConceptId === conceptId) ?? null
  const create = useMutation({
    mutationFn: () =>
      api.createDashboard({
        name: "Summary",
        scope: "org",
        body: { widgets: [], scopeConceptId: conceptId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards"] }),
  })

  const { body, mutate, onStop, conflict, dismissConflict } = useDashboardBody(summary)
  const cIndex = useMemo(() => conceptIndex(concepts), [concepts])
  const ids = useMemo(() => (body ? referencedConceptIds(body, conceptId) : []), [body, conceptId])
  const { instData, loaders } = useConceptData(ids)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = body?.widgets.find((w) => w.id === editingId) ?? null

  if (!dashboards) return <Spinner />

  if (!summary)
    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <LayoutDashboard size={20} />
        </div>
        <h3 className="mb-1 text-base font-medium text-foreground">No summary yet</h3>
        <p className="mb-4 max-w-sm text-sm text-balance text-muted-foreground">
          Build a dashboard of widgets scoped to this concept — counts, breakdowns, attention, and
          activity.
        </p>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          <Plus size={15} /> {create.isPending ? "Creating…" : "Set up summary"}
        </Button>
      </div>
    )

  if (!body) return <Spinner />

  const addOfType = (type: DashboardWidget["type"]) => {
    const w = newWidget(body, type)
    mutate(addWidget(body, w))
    setEditingId(w.id)
  }

  return (
    <div className="flex flex-col gap-3">
      {loaders}
      <div className="flex items-center justify-end">
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
      </div>

      {conflict && (
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <span>This summary was changed elsewhere — reloaded; your last edit wasn't saved.</span>
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
        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          Add a widget to start. It's scoped to this concept automatically.
        </div>
      ) : (
        <WidgetCanvas
          body={body}
          instData={instData}
          cIndex={cIndex}
          conceptsLoaded={conceptsLoaded}
          implicitConceptId={conceptId}
          onStop={onStop}
          onEdit={setEditingId}
          onRemove={(id) => mutate(removeWidget(body, id))}
        />
      )}

      {editing && (
        <WidgetEditor
          widget={editing}
          concepts={concepts}
          implicitConceptId={conceptId}
          onSave={(w) => mutate(updateWidget(body, w.id, w))}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}
