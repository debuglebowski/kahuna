import type { CSSProperties } from "react"
import type { DashboardBody, DashboardNode, DashboardWidget } from "./api"

/**
 * The dashboard auto-layout engine. A dashboard is a TREE of nodes laid out like
 * Figma auto-layout / CSS flexbox: a Group is an invisible container with a
 * `direction` that flows its children; a Widget is a leaf. The window is the root
 * container — a 48×48 tile grid that fills the viewport. A tile is a global unit
 * (viewport / 48 per axis); fixed sizes nest within it. fr = flex weight (share of
 * the parent's leftover along its direction). No React here — `LayoutNode` wires
 * the resolved styles to the DOM.
 */

/** Window is GRID×GRID tiles. */
export const GRID = 48

export type Axis = "w" | "h"
export type DimUnit = "tiles" | "fr" | "pct"
/** A node's size on one axis. `min`/`max` are in tiles. */
export interface Dim {
  unit: DimUnit
  value: number
  min?: number
  max?: number
}

// ── Normalized runtime tree (every node has a guaranteed size) ────────────────
export type NormWidget = DashboardWidget & { w: Dim; h: Dim }
export interface NormGroup {
  id: string
  type: "group"
  direction: "row" | "col"
  w: Dim
  h: Dim
  children: NormNode[]
}
export type NormNode = NormWidget | NormGroup
export interface NormBody {
  direction: "row" | "col"
  children: NormNode[]
}

export const isGroup = (n: NormNode): n is NormGroup => n.type === "group"

/** Default size for a fresh/migrated node: fill (flex weight 1) on both axes. */
export const FILL: Dim = { unit: "fr", value: 1 }

const dim = (d: Dim | undefined, fallback: Dim): Dim =>
  d
    ? {
        unit: d.unit,
        value: d.value,
        ...(d.min != null ? { min: d.min } : {}),
        ...(d.max != null ? { max: d.max } : {}),
      }
    : { ...fallback }

const normNode = (n: DashboardNode): NormNode => {
  if (n.type === "group") {
    return {
      id: n.id,
      type: "group",
      direction: n.direction,
      w: dim(n.w, FILL),
      h: dim(n.h, FILL),
      children: n.children.map(normNode),
    }
  }
  // Drop the legacy `layout` placement; size comes from w/h (defaulted to fill).
  const { layout: _legacy, ...rest } = n
  return { ...rest, w: dim(n.w, FILL), h: dim(n.h, FILL) } as NormWidget
}

/**
 * Normalize a stored body — new tree OR legacy flat widget list — into the
 * runtime tree. Legacy bodies dump every widget into a `col` root (each fills its
 * row); the user re-arranges from there.
 */
export const migrate = (body: DashboardBody): NormBody => {
  if (body.children !== undefined) {
    return { direction: body.direction ?? "col", children: body.children.map(normNode) }
  }
  return { direction: "col", children: (body.widgets ?? []).map(normNode) }
}

/** Back to the stored shape for persistence (the contract validates it). */
export const serialize = (body: NormBody): DashboardBody => ({
  direction: body.direction,
  children: body.children as unknown as readonly DashboardNode[],
})

// ── Tree operations (immutable) ───────────────────────────────────────────────
export const findNode = (body: NormBody, id: string): NormNode | null => {
  const walk = (nodes: NormNode[]): NormNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n
      if (isGroup(n)) {
        const f = walk(n.children)
        if (f) return f
      }
    }
    return null
  }
  return walk(body.children)
}

/** The parent group id of `id`, or null when it sits in the root. Undefined if
 *  the node isn't found. */
export const parentOf = (body: NormBody, id: string): string | null | undefined => {
  let found: string | null | undefined
  const walk = (nodes: NormNode[], parent: string | null) => {
    for (const n of nodes) {
      if (n.id === id) {
        found = parent
        return
      }
      if (isGroup(n)) walk(n.children, n.id)
    }
  }
  walk(body.children, null)
  return found
}

export const updateNode = (body: NormBody, id: string, fn: (n: NormNode) => NormNode): NormBody => {
  const walk = (nodes: NormNode[]): NormNode[] =>
    nodes.map((n) => {
      if (n.id === id) return fn(n)
      if (isGroup(n)) return { ...n, children: walk(n.children) }
      return n
    })
  return { ...body, children: walk(body.children) }
}

export const removeNode = (body: NormBody, id: string): NormBody => {
  const walk = (nodes: NormNode[]): NormNode[] =>
    nodes
      .filter((n) => n.id !== id)
      .map((n) => (isGroup(n) ? { ...n, children: walk(n.children) } : n))
  return { ...body, children: walk(body.children) }
}

/** Move a node by `delta` (±1) among its siblings; clamped at the ends. */
export const reorderNode = (body: NormBody, id: string, delta: number): NormBody => {
  const walk = (nodes: NormNode[]): NormNode[] => {
    const i = nodes.findIndex((n) => n.id === id)
    if (i >= 0) {
      const j = i + delta
      if (j < 0 || j >= nodes.length) return nodes
      const next = [...nodes]
      const [moved] = next.splice(i, 1)
      if (moved) next.splice(j, 0, moved)
      return next
    }
    return nodes.map((n) => (isGroup(n) ? { ...n, children: walk(n.children) } : n))
  }
  return { ...body, children: walk(body.children) }
}

/** Insert `node` into `parentId` (null = root) at `index` (default end). */
export const insertNode = (
  body: NormBody,
  parentId: string | null,
  node: NormNode,
  index?: number,
): NormBody => {
  const into = (children: NormNode[]): NormNode[] => {
    const next = [...children]
    next.splice(index ?? next.length, 0, node)
    return next
  }
  if (parentId === null) return { ...body, children: into(body.children) }
  return updateNode(body, parentId, (n) => (isGroup(n) ? { ...n, children: into(n.children) } : n))
}

/** Every id in a node's subtree (including the node itself). */
export const subtreeIds = (node: NormNode): string[] =>
  isGroup(node) ? [node.id, ...node.children.flatMap(subtreeIds)] : [node.id]

/** Reparent `id` into `targetParentId` (null = root). With `beforeId`, insert
 *  directly before that sibling (for drag-to-position); otherwise append. No-op
 *  if the target is the node itself or one of its descendants (would orphan it),
 *  or if it's already appended to the same parent. */
export const moveNode = (
  body: NormBody,
  id: string,
  targetParentId: string | null,
  beforeId?: string | null,
): NormBody => {
  const node = findNode(body, id)
  if (!node) return body
  if (targetParentId !== null && subtreeIds(node).includes(targetParentId)) return body
  if (!beforeId && parentOf(body, id) === targetParentId) return body // already there, no reposition
  const removed = removeNode(body, id)
  let index: number | undefined
  if (beforeId && beforeId !== id) {
    const siblings =
      targetParentId === null
        ? removed.children
        : ((findNode(removed, targetParentId) as NormGroup | null)?.children ?? [])
    const i = siblings.findIndex((n) => n.id === beforeId)
    if (i >= 0) index = i
  }
  return insertNode(removed, targetParentId, node, index)
}

/** Dissolve a group, promoting its children into its parent at its position
 *  (keeps the children; only the wrapper is removed). */
export const unwrapGroup = (body: NormBody, id: string): NormBody => {
  const replace = (nodes: NormNode[]): NormNode[] =>
    nodes.flatMap((n) => {
      if (n.id === id && isGroup(n)) return n.children
      if (isGroup(n)) return [{ ...n, children: replace(n.children) }]
      return [n]
    })
  return { ...body, children: replace(body.children) }
}

// ── Flex resolution ───────────────────────────────────────────────────────────
/** Px size of one tile on each axis, given the measured window content box. */
export interface TilePx {
  x: number
  y: number
}
export const tilePx = (width: number, height: number): TilePx => ({
  x: width / GRID,
  y: height / GRID,
})

const px = (tiles: number, per: number) => `${tiles * per}px`

/**
 * The flex style for a node, given its PARENT's direction and the global tile
 * size. The main axis (along the parent direction) drives `flex`; the cross axis
 * sets an explicit size or stretches. `fr` with no leftover collapses to 0 unless
 * a `min` holds it open.
 */
export const nodeStyle = (
  node: NormNode,
  parentDir: "row" | "col",
  tile: TilePx,
): CSSProperties => {
  const mainAxis: Axis = parentDir === "row" ? "w" : "h"
  const crossAxis: Axis = mainAxis === "w" ? "h" : "w"
  const mainDim = node[mainAxis]
  const crossDim = node[crossAxis]
  const mainTile = mainAxis === "w" ? tile.x : tile.y
  const crossTile = crossAxis === "w" ? tile.x : tile.y
  const style: CSSProperties = { minWidth: 0, minHeight: 0 }

  // Main axis → flex.
  if (mainDim.unit === "fr") {
    style.flexGrow = mainDim.value
    style.flexShrink = 1
    style.flexBasis = 0
  } else {
    style.flexGrow = 0
    style.flexShrink = 0
    style.flexBasis = mainDim.unit === "tiles" ? px(mainDim.value, mainTile) : `${mainDim.value}%`
  }
  if (mainDim.min != null)
    style[mainAxis === "w" ? "minWidth" : "minHeight"] = px(mainDim.min, mainTile)
  if (mainDim.max != null)
    style[mainAxis === "w" ? "maxWidth" : "maxHeight"] = px(mainDim.max, mainTile)

  // Cross axis → explicit size, or stretch to fill the parent.
  if (crossDim.unit === "fr") {
    style.alignSelf = "stretch"
  } else {
    style[crossAxis === "w" ? "width" : "height"] =
      crossDim.unit === "tiles" ? px(crossDim.value, crossTile) : `${crossDim.value}%`
  }
  if (crossDim.min != null)
    style[crossAxis === "w" ? "minWidth" : "minHeight"] = px(crossDim.min, crossTile)
  if (crossDim.max != null)
    style[crossAxis === "w" ? "maxWidth" : "maxHeight"] = px(crossDim.max, crossTile)

  return style
}

// ── Concept references (walk the tree) ────────────────────────────────────────
/** Concept ids whose INSTANCES the dashboard needs loaded. Excludes trend/activity
 *  (event log), tasks (filter, not scope), files (own RPC); calendar scopes per
 *  source. */
export const referencedConceptIds = (body: NormBody): string[] => {
  const ids = new Set<string>()
  const walk = (n: NormNode) => {
    if (isGroup(n)) {
      n.children.forEach(walk)
      return
    }
    if (n.type === "trend" || n.type === "activity" || n.type === "tasks" || n.type === "files")
      return
    if (n.type === "calendar") {
      for (const s of n.sources) if (s.conceptId) ids.add(s.conceptId)
      return
    }
    if ("conceptId" in n && n.conceptId) ids.add(n.conceptId)
  }
  body.children.forEach(walk)
  return [...ids]
}

// ── Node construction ─────────────────────────────────────────────────────────
// New nodes flex (fr) but carry a default `min` (tiles) so they can't silently
// collapse to nothing when a parent fills up — the sustainable default the
// min/max mechanism is for. Cleared/edited freely in the size panel.
const NEW: Dim = { unit: "fr", value: 1, min: 6 }

export const newGroup = (direction: "row" | "col" = "row"): NormGroup => ({
  id: crypto.randomUUID(),
  type: "group",
  direction,
  w: { ...NEW },
  h: { ...NEW },
  children: [],
})

/** A blank widget of the given type — fills its slot; the editor sets concept/config. */
export const newWidget = (type: DashboardWidget["type"]): NormWidget => {
  const base = { id: crypto.randomUUID(), title: null, w: { ...NEW }, h: { ...NEW } } as const
  const scoped = { ...base, conceptId: null } as const
  switch (type) {
    case "metric":
      return { ...scoped, type: "metric", conditions: [], agg: "count" } as NormWidget
    case "list":
      return { ...scoped, type: "list", conditions: [], orderBy: null, limit: 10 } as NormWidget
    case "breakdown":
      return {
        ...scoped,
        type: "breakdown",
        conditions: [],
        groupBy: "",
        chart: "bar",
      } as NormWidget
    case "attention":
      return { ...scoped, type: "attention" } as NormWidget
    case "trend":
      return { ...scoped, type: "trend", bucket: "day", since: "30d" } as NormWidget
    case "activity":
      return { ...scoped, type: "activity" } as NormWidget
    case "tasks":
      return { ...base, type: "tasks" } as NormWidget
    case "members":
      return { ...base, type: "members" } as NormWidget
    case "welcome":
      return { ...base, type: "welcome" } as NormWidget
    case "goal":
      return { ...scoped, type: "goal", conditions: [], agg: "count", target: null } as NormWidget
    case "shortcuts":
      return { ...base, type: "shortcuts", items: [] } as NormWidget
    case "note":
      return { ...base, type: "note" } as NormWidget
    case "kanban":
      return { ...scoped, type: "kanban", conditions: [], groupBy: "" } as NormWidget
    case "calendar":
      return { ...base, type: "calendar", mode: "month", sources: [] } as NormWidget
    case "gantt":
      return {
        ...scoped,
        type: "gantt",
        conditions: [],
        scale: "week",
        startField: "",
      } as NormWidget
    case "files":
      return { ...scoped, type: "files", scope: "org" } as NormWidget
  }
}

/** Recast a widget to a different type, keeping id, size, and title (and concept
 *  when both types are concept-scoped). */
export const retypeWidget = (existing: NormWidget, type: DashboardWidget["type"]): NormWidget => {
  const fresh = newWidget(type)
  const carryConcept =
    "conceptId" in existing && "conceptId" in fresh ? { conceptId: existing.conceptId } : null
  return {
    ...fresh,
    id: existing.id,
    w: existing.w,
    h: existing.h,
    title: existing.title,
    ...carryConcept,
  } as NormWidget
}

// ── Display helpers (metric + goal) ───────────────────────────────────────────
/** Format a widget's hero number: integers with separators, else 2dp. */
export const formatWidgetNumber = (n: number): string =>
  Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

export type MetricFormat = "plain" | "compact" | "currency" | "percent"

export const formatMetric = (n: number, format: MetricFormat, currency?: string): string => {
  switch (format) {
    case "compact":
      return n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })
    case "currency":
      try {
        return n.toLocaleString(undefined, { style: "currency", currency: currency || "USD" })
      } catch {
        return `${formatWidgetNumber(n)} ${currency}`
      }
    case "percent":
      return n.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })
    default:
      return formatWidgetNumber(n)
  }
}

// ── Measured display variants ─────────────────────────────────────────────────
// Widgets are flex-sized, so their on-screen size is emergent — these read the
// MEASURED pixel box (see `useWidgetBox`) rather than any stored dimension.
export type SizeVariant = "sm" | "md" | "lg"

/** Hero-element variant from a tile's pixel height. */
export const sizeVariant = (heightPx: number): SizeVariant =>
  heightPx <= 150 ? "sm" : heightPx <= 300 ? "md" : "lg"

/** Tailwind class for a hero number at the tile's height (Metric + Goal). */
export const heroTextClass = (heightPx: number): string =>
  ({ sm: "text-3xl", md: "text-4xl", lg: "text-6xl" })[sizeVariant(heightPx)]

/** Wide enough for the dense layout (Metric bar, Activity log, List table). */
export const isWide = (widthPx: number): boolean => widthPx >= 400
