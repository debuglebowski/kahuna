import { lazy, Suspense } from "react"
import type { Layout } from "react-grid-layout"
import { MeasuredGrid } from "@/components/MeasuredGrid"
import { Spinner } from "@/components/ui"
import type { Concept, DashboardBody, DashboardWidget } from "@/lib/api"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { widgetLayouts } from "@/lib/dashboards"
import { cn } from "@/lib/utils"
import { ActivityWidget } from "./ActivityWidget"
import { AttentionWidget } from "./AttentionWidget"
import { CalendarWidget } from "./CalendarWidget"
import { FilesWidget } from "./FilesWidget"
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
 * — this only renders and reports interactions. `readOnly` (the live dashboard)
 * renders interactive widget content and freezes the grid. In edit mode the
 * content is inert (pointer-events off) and a tile click selects it for the
 * config panel — you arrange and configure widgets, never operate them.
 */
export function WidgetCanvas({
  body,
  instData,
  cIndex,
  conceptsLoaded = true,
  readOnly = false,
  minHeight,
  selectedId,
  onStop,
  onSelect,
}: {
  body: DashboardBody
  instData: Record<string, ConceptInstanceData>
  cIndex: Map<string, Concept>
  /** False while the concept collection is still loading — suppresses the
   *  "concept unavailable" tile so it never flashes on first paint. */
  conceptsLoaded?: boolean
  readOnly?: boolean
  /** Fills the grid to at least this height (px) — see {@link MeasuredGrid}. */
  minHeight?: number | null
  /** Edit mode only: the tile to highlight as selected for configuration. */
  selectedId?: string | null
  onStop?: (layout: Layout[]) => void
  /** Edit mode only: clicking a tile selects it for the config panel. */
  onSelect?: (id: string) => void
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
    if (w.type === "files") return <FilesWidget widget={w} />
    // A tile from a newer body (unknown type) falls through here.
    return (
      <p className="text-sm text-muted-foreground">
        Unsupported widget ({(w as DashboardWidget).type}).
      </p>
    )
  }

  // A note can be title-less by design — don't fall back to the type name. A
  // metric is the same: its body already names the concept (the sub line), so a
  // concept-name header just duplicates it — title-only, no fallback. Tasks'
  // conceptId is a filter, not the tile's subject — its header stays the type
  // name.
  const headerLabel = (w: DashboardWidget): string =>
    w.title ||
    ("conceptId" in w && w.conceptId && w.type !== "tasks" && w.type !== "metric"
      ? (cIndex.get(w.conceptId)?.name ?? "")
      : "") ||
    (w.type === "note" || w.type === "metric" ? "" : w.type)

  return (
    <MeasuredGrid
      layout={widgetLayouts(body)}
      isDraggable={!readOnly}
      isResizable={!readOnly}
      minHeight={minHeight}
      onStop={onStop}
      onDragStart={readOnly ? undefined : onSelect}
    >
      {body.widgets.map((w) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: interactive in edit mode (role/tabIndex/keydown set together); readOnly tiles are inert. The conditional role defeats static analysis.
        <div
          key={w.id}
          role={readOnly ? undefined : "button"}
          tabIndex={readOnly ? undefined : 0}
          // Mouse selection rides RGL's onDragStart (fires on press) — see
          // MeasuredGrid; here we only add keyboard parity for focused tiles.
          onKeyDown={
            readOnly
              ? undefined
              : (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onSelect?.(w.id)
                  }
                }
          }
          className={cn(
            "flex flex-col overflow-hidden rounded-xl border bg-card p-3 shadow-sm",
            !readOnly &&
              "cursor-pointer transition-shadow hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !readOnly && selectedId === w.id && "ring-2 ring-primary",
          )}
        >
          {headerLabel(w) !== "" && (
            <div className="mb-1 flex items-center gap-2">
              <span className="truncate text-xs font-medium text-muted-foreground">
                {headerLabel(w)}
              </span>
            </div>
          )}
          {/* Edit mode: content is inert so the tile reads as a single
              click-to-select surface — you configure widgets, never use them. */}
          <div className={cn("min-h-0 flex-1", !readOnly && "pointer-events-none")}>
            {render(w)}
          </div>
        </div>
      ))}
    </MeasuredGrid>
  )
}
