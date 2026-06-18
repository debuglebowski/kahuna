import { type DragEvent, lazy, Suspense, useMemo, useState } from "react"
import { Spinner } from "@/components/ui"
import type { Concept } from "@/lib/api"
import type { ConceptInstanceData } from "@/lib/conceptData"
import {
  findNode,
  isGroup,
  type NormBody,
  type NormGroup,
  type NormNode,
  type NormWidget,
  nodeStyle,
  subtreeIds,
  type TilePx,
  tabTitle,
  tilePx,
} from "@/lib/dashboards"
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
import { useElementSize, WidgetBoxProvider } from "./widgetBox"

// Lazy so recharts' bundle is only fetched when a chart widget is on screen.
const BreakdownWidget = lazy(() =>
  import("./BreakdownWidget").then((m) => ({ default: m.BreakdownWidget })),
)
const TrendWidget = lazy(() => import("./TrendWidget").then((m) => ({ default: m.TrendWidget })))

/** Flex gap = the gutter between sibling tiles/groups (px). */
const GAP = 16

type Zone = "before" | "after" | "into"

interface RenderCtx {
  instData: Record<string, ConceptInstanceData>
  cIndex: Map<string, Concept>
  conceptsLoaded: boolean
  readOnly: boolean
  selectedId: string | null
  onSelect?: (id: string) => void
  tile: TilePx
  // Drag-and-drop: the dragged node + the current drop hint ({id,"zone"}; id
  // "__root" = the window's empty area). `drop` commits a move (before-sibling
  // null = append); `dropInvalid` blocks targets inside the dragged subtree.
  dragId: string | null
  hint: { id: string; zone: Zone } | null
  startDrag: (id: string) => void
  endDrag: () => void
  setHint: (h: { id: string; zone: Zone } | null) => void
  drop: (parentId: string | null, beforeId: string | null) => void
  dropInvalid: (parentId: string | null) => boolean
}

/** DnD props for a draggable node (widget or group) — wired only in edit mode. */
const dragProps = (ctx: RenderCtx, id: string) =>
  ctx.readOnly
    ? {}
    : {
        draggable: true,
        onDragStart: (e: DragEvent) => {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = "move"
          e.dataTransfer.setData("text/plain", id)
          ctx.startDrag(id)
        },
        onDragEnd: ctx.endDrag,
      }

/** Which region of a node the cursor is over, along the parent's flow axis.
 *  Groups expose a middle "into" zone; widgets split before/after. */
const zoneFromEvent = (e: DragEvent, parentDir: "row" | "col", group: boolean): Zone => {
  const r = e.currentTarget.getBoundingClientRect()
  const f =
    parentDir === "row"
      ? (e.clientX - r.left) / Math.max(1, r.width)
      : (e.clientY - r.top) / Math.max(1, r.height)
  if (group) return f < 0.25 ? "before" : f > 0.75 ? "after" : "into"
  return f < 0.5 ? "before" : "after"
}

/** Drop handlers + the active hint zone for a node, resolving the spatial zone
 *  to a (parent, before-sibling) move. `before`/`after` reorder within the
 *  parent; `into` nests in a group. */
const nodeDrop = (
  ctx: RenderCtx,
  node: NormNode,
  parentId: string | null,
  parentDir: "row" | "col",
  nextId: string | null,
) => {
  if (ctx.readOnly || ctx.dragId === null || ctx.dragId === node.id)
    return { zone: null as Zone | null, props: {} }
  const group = isGroup(node)
  const targetOf = (z: Zone): { parent: string | null; before: string | null } =>
    z === "into"
      ? { parent: node.id, before: null }
      : z === "before"
        ? { parent: parentId, before: node.id }
        : { parent: parentId, before: nextId }
  const ok = (z: Zone) => !ctx.dropInvalid(targetOf(z).parent)
  return {
    zone: ctx.hint?.id === node.id ? ctx.hint.zone : null,
    props: {
      onDragOver: (e: DragEvent) => {
        const z = zoneFromEvent(e, parentDir, group)
        if (!ok(z)) return
        e.preventDefault()
        e.stopPropagation()
        if (ctx.hint?.id !== node.id || ctx.hint.zone !== z) ctx.setHint({ id: node.id, zone: z })
      },
      onDrop: (e: DragEvent) => {
        const z = zoneFromEvent(e, parentDir, group)
        if (!ok(z)) return
        e.preventDefault()
        e.stopPropagation()
        const t = targetOf(z)
        ctx.drop(t.parent, t.before)
      },
    },
  }
}

/** The insertion line for a before/after drop, oriented to the parent's flow. */
function DropLine({ zone, parentDir }: { zone: Zone | null; parentDir: "row" | "col" }) {
  if (zone !== "before" && zone !== "after") return null
  const horiz = parentDir === "col" // vertical flow → horizontal lines (top/bottom)
  const pos =
    zone === "before"
      ? horiz
        ? "inset-x-0 top-0 h-1"
        : "inset-y-0 left-0 w-1"
      : horiz
        ? "inset-x-0 bottom-0 h-1"
        : "inset-y-0 right-0 w-1"
  return <div className={cn("pointer-events-none absolute z-10 rounded bg-primary", pos)} />
}

/** The widget content for a leaf node (the per-type renderer switch). */
function renderWidget(w: NormWidget, ctx: RenderCtx) {
  // Tasks' conceptId is a task FILTER (resolved via subject refs), not a data scope.
  const cid = "conceptId" in w && w.type !== "tasks" ? (w.conceptId ?? undefined) : undefined
  const data = cid ? ctx.instData[cid] : undefined
  const concept = cid ? ctx.cIndex.get(cid) : undefined
  if (cid && ctx.conceptsLoaded && !concept)
    return (
      <p className="text-sm text-muted-foreground">
        Concept unavailable — it may have been deleted.
      </p>
    )
  switch (w.type) {
    case "metric":
      return <MetricWidget widget={w} data={data} concept={concept} />
    case "list":
      return <ListWidget widget={w} data={data} concept={concept} />
    case "attention":
      return <AttentionWidget widget={w} data={data} concept={concept} />
    case "breakdown":
      return (
        <Suspense fallback={<Spinner />}>
          <BreakdownWidget widget={w} data={data} />
        </Suspense>
      )
    case "trend":
      return (
        <Suspense fallback={<Spinner />}>
          <TrendWidget widget={w} />
        </Suspense>
      )
    case "activity":
      return <ActivityWidget widget={w} />
    case "tasks":
      return <TasksWidget widget={w} />
    case "members":
      return <MembersWidget widget={w} />
    case "welcome":
      return <WelcomeWidget widget={w} />
    case "goal":
      return <GoalWidget widget={w} data={data} concept={concept} />
    case "shortcuts":
      return <ShortcutsWidget widget={w} />
    case "note":
      return <NoteWidget widget={w} />
    case "kanban":
      return <KanbanWidget widget={w} data={data} concept={concept} />
    case "calendar":
      return <CalendarWidget widget={w} instData={ctx.instData} cIndex={ctx.cIndex} />
    case "gantt":
      return <GanttWidget widget={w} data={data} concept={concept} />
    case "files":
      return <FilesWidget widget={w} />
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Unsupported widget ({(w as NormNode).type}).
        </p>
      )
  }
}

/** A widget tile's header label (a list/metric/note render their own). Shows ONLY
 *  the explicit title — an empty title means no header (no concept/type fallback). */
function headerLabel(w: NormNode): string {
  if (w.type === "group" || w.type === "list") return ""
  return w.title ?? ""
}

/** A leaf widget tile — a measured card; content reads its box for variants. */
function WidgetLeaf({ node, ctx }: { node: NormWidget; ctx: RenderCtx }) {
  const [ref, size] = useElementSize()
  const label = headerLabel(node)
  const selected = !ctx.readOnly && ctx.selectedId === node.id
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: interactive only in edit mode (role/tabIndex/keydown set together); readOnly tiles are inert.
    <div
      ref={ref}
      role={ctx.readOnly ? undefined : "button"}
      tabIndex={ctx.readOnly ? undefined : 0}
      {...dragProps(ctx, node.id)}
      onClick={
        ctx.readOnly
          ? undefined
          : (e) => {
              e.stopPropagation()
              ctx.onSelect?.(node.id)
            }
      }
      onKeyDown={
        ctx.readOnly
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                ctx.onSelect?.(node.id)
              }
            }
      }
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card p-3 shadow-sm",
        !ctx.readOnly &&
          "cursor-grab transition-shadow hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-primary",
        ctx.dragId === node.id && "opacity-40",
      )}
    >
      {label !== "" && (
        <div className="mb-1 flex items-center gap-2">
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        </div>
      )}
      <div className={cn("min-h-0 flex-1", !ctx.readOnly && "pointer-events-none")}>
        <WidgetBoxProvider value={size}>{renderWidget(node, ctx)}</WidgetBoxProvider>
      </div>
    </div>
  )
}

/** One node: a flex item sized by `nodeStyle`. Groups are flex containers
 *  (invisible in the live view, dashed + labelled in edit mode); widgets are
 *  leaves. Every node is a drop target — its edges reorder it within its parent,
 *  a group's middle nests into it (see {@link nodeDrop}). */
function LayoutNode({
  node,
  parentDir,
  parentId,
  nextId,
  ctx,
}: {
  node: NormNode
  parentDir: "row" | "col"
  parentId: string | null
  nextId: string | null
  ctx: RenderCtx
}) {
  const style = nodeStyle(node, parentDir, ctx.tile)
  const drop = nodeDrop(ctx, node, parentId, parentDir, nextId)
  if (isGroup(node) && node.display === "tabs") {
    return <TabsNode node={node} parentDir={parentDir} ctx={ctx} />
  }
  if (isGroup(node)) {
    const selected = !ctx.readOnly && ctx.selectedId === node.id
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: interactive only in edit mode.
      <div
        style={{
          ...style,
          display: "flex",
          flexDirection: node.direction === "row" ? "row" : "column",
          gap: GAP,
        }}
        role={ctx.readOnly ? undefined : "button"}
        tabIndex={ctx.readOnly ? undefined : 0}
        {...dragProps(ctx, node.id)}
        {...drop.props}
        onClick={
          ctx.readOnly
            ? undefined
            : (e) => {
                e.stopPropagation()
                ctx.onSelect?.(node.id)
              }
        }
        onKeyDown={
          ctx.readOnly
            ? undefined
            : (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  ctx.onSelect?.(node.id)
                }
              }
        }
        className={cn(
          "relative min-h-0 rounded-xl",
          // Edit-only border + inset; never applied in the live (readOnly) render.
          !ctx.readOnly && "border p-2 hover:border-foreground/30",
          // Dashed/muted only while idle — selection or a drop-target switch it to a
          // solid border so a node never shows the dashed and solid outlines at once.
          !ctx.readOnly && !selected && drop.zone !== "into" && "border-dashed border-border/70",
          selected && "border-solid border-primary ring-1 ring-primary",
          drop.zone === "into" && "border-solid border-primary bg-primary/5 ring-2 ring-primary",
          ctx.dragId === node.id && "opacity-40",
        )}
      >
        <DropLine zone={drop.zone} parentDir={parentDir} />
        {node.children.length === 0 && !ctx.readOnly && (
          <div className="flex flex-1 items-center justify-center p-2 text-[11px] text-muted-foreground">
            Empty {node.direction === "row" ? "row" : "column"} group
          </div>
        )}
        {node.children.map((c, i) => (
          <LayoutNode
            key={c.id}
            node={c}
            parentDir={node.direction}
            parentId={node.id}
            nextId={node.children[i + 1]?.id ?? null}
            ctx={ctx}
          />
        ))}
      </div>
    )
  }
  return (
    <div style={style} className="relative min-h-0" {...drop.props}>
      <DropLine zone={drop.zone} parentDir={parentDir} />
      <WidgetLeaf node={node} ctx={ctx} />
    </div>
  )
}

/** A tabs group: one child (panel) visible at a time behind a tab bar. The active
 *  tab follows (a) the selected node, so editing reveals its panel; (b) the last
 *  clicked tab; (c) the persisted `active` default; (d) the first child. Drops onto
 *  the BAR append a new tab; drops into the visible panel add to that panel. */
function TabsNode({
  node,
  parentDir,
  ctx,
}: {
  node: NormGroup
  parentDir: "row" | "col"
  ctx: RenderCtx
}) {
  const style = nodeStyle(node, parentDir, ctx.tile)
  const [picked, setPicked] = useState<string | null>(null)
  const ids = node.children.map((c) => c.id)
  // Selection wins (keep the edited node visible), then a clicked tab, then the
  // persisted default, then the first child.
  const selectedChild =
    !ctx.readOnly && ctx.selectedId
      ? (node.children.find((c) => subtreeIds(c).includes(ctx.selectedId as string))?.id ?? null)
      : null
  const fallback = node.active && ids.includes(node.active) ? node.active : (ids[0] ?? null)
  const activeId = selectedChild ?? (picked && ids.includes(picked) ? picked : null) ?? fallback
  const activeChild = node.children.find((c) => c.id === activeId) ?? null

  const pos = node.tabBar ?? "top"
  const vertical = pos === "left" || pos === "right"
  const barFirst = pos === "top" || pos === "left"
  const containerDir = vertical
    ? barFirst
      ? "row"
      : "row-reverse"
    : barFirst
      ? "column"
      : "column-reverse"

  const selected = !ctx.readOnly && ctx.selectedId === node.id
  // The bar accepts a drop = append the dragged node as a new tab.
  const canBarDrop =
    !ctx.readOnly && ctx.dragId !== null && ctx.dragId !== node.id && !ctx.dropInvalid(node.id)
  const barActive = ctx.hint?.id === node.id && ctx.hint.zone === "into"
  const barDrop = canBarDrop
    ? {
        onDragOver: (e: DragEvent) => {
          e.preventDefault()
          e.stopPropagation()
          if (ctx.hint?.id !== node.id || ctx.hint.zone !== "into")
            ctx.setHint({ id: node.id, zone: "into" })
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault()
          e.stopPropagation()
          ctx.drop(node.id, null)
        },
      }
    : {}

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: interactive only in edit mode (role/tabIndex/keydown set together); readOnly is inert.
    <div
      style={{ ...style, display: "flex", flexDirection: containerDir }}
      {...dragProps(ctx, node.id)}
      role={ctx.readOnly ? undefined : "button"}
      tabIndex={ctx.readOnly ? undefined : 0}
      onClick={
        ctx.readOnly
          ? undefined
          : (e) => {
              e.stopPropagation()
              ctx.onSelect?.(node.id)
            }
      }
      onKeyDown={
        ctx.readOnly
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                ctx.onSelect?.(node.id)
              }
            }
      }
      className={cn(
        "relative min-h-0 gap-2 overflow-hidden rounded-xl",
        // The gap separates the tab bar from the panel in BOTH modes so the content
        // never butts against the bar. Border + inset are edit-only (see group
        // above); the live render carries neither (gap is not an outer inset).
        !ctx.readOnly && "border p-2 hover:border-foreground/30",
        // Dashed only while idle; selection switches to a solid border (never both).
        !ctx.readOnly && !selected && "border-dashed border-border/70",
        selected && "border-solid border-primary ring-1 ring-primary",
        ctx.dragId === node.id && "opacity-40",
      )}
    >
      <div
        {...barDrop}
        className={cn(
          "flex shrink-0 gap-1 overflow-auto",
          vertical ? "flex-col" : "flex-row",
          barActive && "rounded-md bg-primary/10 ring-1 ring-inset ring-primary",
        )}
      >
        {node.children.length === 0 && (
          <span className="px-2 py-1.5 text-sm text-muted-foreground">No tabs</span>
        )}
        {node.children.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setPicked(c.id)
              if (!ctx.readOnly) ctx.onSelect?.(c.id)
            }}
            className={cn(
              "max-w-[180px] shrink-0 truncate rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              c.id === activeId
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {tabTitle(c, i)}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeChild ? (
          <LayoutNode
            node={activeChild}
            parentDir="col"
            parentId={node.id}
            nextId={null}
            ctx={ctx}
          />
        ) : ctx.readOnly ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            No tab added
          </div>
        ) : (
          <div
            {...barDrop}
            className={cn(
              "flex flex-1 items-center justify-center rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground",
              barActive ? "border-primary bg-primary/5 text-foreground" : "border-border/70",
            )}
          >
            Drag a widget or group onto the bar to add a tab.
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The dashboard canvas — renders the auto-layout tree as nested flexbox. The
 * window is a 48×48 tile grid filling this box; sizes resolve to flex via
 * {@link nodeStyle}. `readOnly` (the live dashboard) renders interactive widget
 * content and hides group chrome; edit mode shows group outlines and click-selects
 * nodes for the config panel.
 */
export function WidgetCanvas({
  body,
  instData,
  cIndex,
  conceptsLoaded = true,
  readOnly = false,
  selectedId = null,
  onSelect,
  onMove,
}: {
  body: NormBody
  instData: Record<string, ConceptInstanceData>
  cIndex: Map<string, Concept>
  conceptsLoaded?: boolean
  readOnly?: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** Move a node by drag-and-drop: into `targetParentId` (null = root window),
   *  before `beforeId` (null = append). */
  onMove?: (id: string, targetParentId: string | null, beforeId: string | null) => void
}) {
  const [ref, size] = useElementSize()
  const [dragId, setDragId] = useState<string | null>(null)
  const [hint, setHint] = useState<{ id: string; zone: Zone } | null>(null)
  // The dragged node's subtree — drop targets inside it are invalid (no orphaning).
  const draggedSubtree = useMemo(() => {
    if (!dragId) return null
    const n = findNode(body, dragId)
    return n ? new Set(subtreeIds(n)) : null
  }, [dragId, body])

  const ctx: RenderCtx = {
    instData,
    cIndex,
    conceptsLoaded,
    readOnly,
    selectedId,
    onSelect,
    tile: tilePx(size.width, size.height),
    dragId,
    hint,
    startDrag: setDragId,
    endDrag: () => {
      setDragId(null)
      setHint(null)
    },
    setHint,
    drop: (parentId, beforeId) => {
      if (dragId) onMove?.(dragId, parentId, beforeId)
      setDragId(null)
      setHint(null)
    },
    dropInvalid: (parentId) => parentId !== null && (draggedSubtree?.has(parentId) ?? false),
  }

  // The window's empty area accepts a drop = append to the root.
  const rootActive = dragId !== null
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop-zone surface for drag-and-drop; not a click/key target (selection lives on the tiles).
    <div
      ref={ref}
      style={{
        display: "flex",
        flexDirection: body.direction === "row" ? "row" : "column",
        gap: GAP,
      }}
      className={cn(
        "h-full min-h-0 w-full rounded-lg",
        hint?.id === "__root" && "ring-2 ring-primary/40",
      )}
      onDragOver={
        readOnly || !rootActive
          ? undefined
          : (e) => {
              e.preventDefault()
              if (hint?.id !== "__root") setHint({ id: "__root", zone: "into" })
            }
      }
      onDrop={
        readOnly || !rootActive
          ? undefined
          : (e) => {
              e.preventDefault()
              ctx.drop(null, null)
            }
      }
    >
      {size.width > 0 &&
        body.children.map((c, i) => (
          <LayoutNode
            key={c.id}
            node={c}
            parentDir={body.direction}
            parentId={null}
            nextId={body.children[i + 1]?.id ?? null}
            ctx={ctx}
          />
        ))}
    </div>
  )
}
