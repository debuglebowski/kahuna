import { Pencil, X } from "lucide-react"
import { lazy, Suspense } from "react"
import GridLayout, { type Layout, WidthProvider } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"
import { Spinner } from "@/components/ui"
import type { Concept, DashboardBody, DashboardWidget } from "@/lib/api"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { GRID_COLS, GRID_ROW_HEIGHT, widgetLayouts } from "@/lib/dashboards"
import { ActivityWidget } from "./ActivityWidget"
import { AttentionWidget } from "./AttentionWidget"
import { ListWidget } from "./ListWidget"
import { MetricWidget } from "./MetricWidget"

const Grid = WidthProvider(GridLayout)

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
  implicitConceptId,
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
  /** Per-concept summary mode: widgets that omit `conceptId` resolve to this. */
  implicitConceptId?: string
  onStop?: (layout: Layout[]) => void
  onEdit?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  const conceptOf = (w: DashboardWidget): string | undefined => w.conceptId ?? implicitConceptId
  const render = (w0: DashboardWidget) => {
    const cid = conceptOf(w0)
    // In per-concept mode, fill the implicit concept in so each widget's own
    // `conceptId` checks (and trend/activity scoping) resolve to it.
    const w = (cid && !w0.conceptId ? { ...w0, conceptId: cid } : w0) as DashboardWidget
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
    if (w.type === "list") return <ListWidget widget={w} data={data} />
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
    // All known types handled; a tile from a newer body falls through here.
    return (
      <p className="text-sm text-muted-foreground">
        Unsupported widget ({(w as DashboardWidget).type}).
      </p>
    )
  }

  return (
    <Grid
      className="-mx-1"
      layout={widgetLayouts(body)}
      cols={GRID_COLS}
      rowHeight={GRID_ROW_HEIGHT}
      margin={[12, 12]}
      draggableCancel=".cancel-drag"
      isDraggable={!readOnly}
      isResizable={!readOnly}
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
          <div className="min-h-0 flex-1">{render(w)}</div>
        </div>
      ))}
    </Grid>
  )
}
