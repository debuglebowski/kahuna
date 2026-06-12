import { Pencil, X } from "lucide-react"
import { lazy, Suspense } from "react"
import type { Layout } from "react-grid-layout"
import { MeasuredGrid } from "@/components/MeasuredGrid"
import { Spinner } from "@/components/ui"
import type { Concept, DashboardBody, DashboardWidget } from "@/lib/api"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { widgetLayouts } from "@/lib/dashboards"
import { ActivityWidget } from "./ActivityWidget"
import { AttentionWidget } from "./AttentionWidget"
import { CalendarWidget } from "./CalendarWidget"
import { GanttWidget } from "./GanttWidget"
import { GoalWidget } from "./GoalWidget"
import { KanbanWidget } from "./KanbanWidget"
import { ListWidget } from "./ListWidget"
import { MembersWidget } from "./MembersWidget"
import { MetricWidget } from "./MetricWidget"
import { NoteWidget } from "./NoteWidget"
import { ShortcutsWidget } from "./ShortcutsWidget"
import { TasksWidget } from "./TasksWidget"
import { WelcomeWidget } from "./WelcomeWidget"

// Lazy so recharts' bundle is only fetched when a chart widget is on screen.
const BreakdownWidget = lazy(() =>
  import("./BreakdownWidget").then((m) => ({ default: m.BreakdownWidget })),
)
const TrendWidget = lazy(() => import("./TrendWidget").then((m) => ({ default: m.TrendWidget })))

/**
 * The widget grid shared by every canvas surface (dashboards, member pages):
 * tiles + per-widget chrome + the widget renderers. The PARENT owns the body
 * (and its persistence), the live data (`useConceptData`), and any editor modal
 * — this only renders and reports interactions. `readOnly` freezes the grid and
 * hides the tile actions (a member page viewed by a non-owner).
 */
export function WidgetCanvas({
  body,
  instData,
  cIndex,
  conceptsLoaded = true,
  readOnly = false,
  onStop,
  onEdit,
  onRemove,
}: {
  body: DashboardBody
  instData: Record<string, ConceptInstanceData>
  cIndex: Map<string, Concept>
  /** False while the concept collection is still loading — suppresses the
   *  "concept unavailable" tile so it never flashes on first paint. */
  conceptsLoaded?: boolean
  readOnly?: boolean
  onStop?: (layout: Layout[]) => void
  onEdit?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  const render = (w: DashboardWidget) => {
    // Tasks' conceptId is a task FILTER (resolved via subject refs), not an
    // instance-data scope — it must not gate on the instance collections.
    const cid = "conceptId" in w && w.type !== "tasks" ? (w.conceptId ?? undefined) : undefined
    const data = cid ? instData[cid] : undefined
    const concept = cid ? cIndex.get(cid) : undefined
    // Dangling ref: a concept was set but no longer exists (archived/deleted).
    // Show an honest tile rather than the "pick a concept" unconfigured state.
    if (cid && conceptsLoaded && !concept)
      return (
        <p className="text-sm text-muted-foreground">
          Concept unavailable — it may have been deleted.
        </p>
      )
    if (w.type === "metric") return <MetricWidget widget={w} data={data} concept={concept} />
    if (w.type === "list") return <ListWidget widget={w} data={data} concept={concept} />
    if (w.type === "attention") return <AttentionWidget widget={w} data={data} concept={concept} />
    if (w.type === "breakdown")
      return (
        <Suspense fallback={<Spinner />}>
          <BreakdownWidget widget={w} data={data} />
        </Suspense>
      )
    if (w.type === "trend")
      return (
        <Suspense fallback={<Spinner />}>
          <TrendWidget widget={w} />
        </Suspense>
      )
    if (w.type === "activity") return <ActivityWidget widget={w} />
    if (w.type === "tasks") return <TasksWidget widget={w} />
    if (w.type === "members") return <MembersWidget widget={w} />
    if (w.type === "welcome") return <WelcomeWidget widget={w} />
    if (w.type === "goal") return <GoalWidget widget={w} data={data} concept={concept} />
    if (w.type === "shortcuts") return <ShortcutsWidget widget={w} />
    if (w.type === "note") return <NoteWidget widget={w} />
    if (w.type === "kanban") return <KanbanWidget widget={w} data={data} />
    // Calendar is multi-source — it resolves its concepts from `instData`
    // itself instead of the single-concept `data` scope.
    if (w.type === "calendar") return <CalendarWidget widget={w} instData={instData} />
    if (w.type === "gantt") return <GanttWidget widget={w} data={data} />
    // files is in the contract but its renderer lands in a later phase; a
    // tile from a newer body also falls through here.
    return (
      <p className="text-sm text-muted-foreground">
        Unsupported widget ({(w as DashboardWidget).type}).
      </p>
    )
  }

  // A note can be title-less by design — don't fall back to the type name, and
  // in read-only view drop the header row entirely (edit mode keeps it for the
  // hover actions). Tasks' conceptId is a filter, not the tile's subject —
  // its header stays the type name.
  const headerLabel = (w: DashboardWidget): string =>
    w.title ||
    ("conceptId" in w && w.conceptId && w.type !== "tasks"
      ? (cIndex.get(w.conceptId)?.name ?? "")
      : "") ||
    (w.type === "note" ? "" : w.type)

  return (
    <MeasuredGrid
      layout={widgetLayouts(body)}
      isDraggable={!readOnly}
      isResizable={!readOnly}
      onStop={onStop}
    >
      {body.widgets.map((w) => (
        <div
          key={w.id}
          className="group flex flex-col overflow-hidden rounded-xl border bg-card p-3 shadow-sm"
        >
          {(!readOnly || headerLabel(w) !== "") && (
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-muted-foreground">
                {headerLabel(w)}
              </span>
              {!readOnly && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Edit widget"
                    className="cancel-drag rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    onClick={() => onEdit?.(w.id)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove widget"
                    className="cancel-drag rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    onClick={() => onRemove?.(w.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">{render(w)}</div>
        </div>
      ))}
    </MeasuredGrid>
  )
}
