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

/** Default inner padding of a widget tile (px). A widget's own `padding` overrides
 *  it; 0 means full bleed — content runs to the tile's edge AND the tile drops its
 *  card chrome (border/background/shadow), so a widget that frames itself doesn't
 *  double up. Shared so the canvas and the config panel's placeholder can't drift. */
export const TILE_PAD = 12

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
  /** Absent = "flow" (children laid out along `direction`). "tabs" = one child
   *  visible at a time behind a tab bar (each child is a tab/panel). */
  display?: "flow" | "tabs"
  /** Optional name — Layers label, and this node's tab title under a tabs parent. */
  label?: string | null
  /** Tabs only: child id open by default (persisted); falls back to the first. */
  active?: string | null
  /** Tabs only: tab-bar edge (default "top"). */
  tabBar?: "top" | "bottom" | "left" | "right"
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
/** A group that presents its children as tabs (one visible at a time). */
export const isTabs = (n: NormNode): n is NormGroup => isGroup(n) && n.display === "tabs"

/** A node's tab title under a tabs parent: its own name, else "Tab N" (1-based). */
export const tabTitle = (n: NormNode, index: number): string =>
  (isGroup(n) ? n.label : n.title) || `Tab ${index + 1}`

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
      // Flow is implicit (absent); carry "tabs" + its fields through.
      ...(n.display === "tabs" ? { display: "tabs" } : {}),
      ...(n.label != null ? { label: n.label } : {}),
      ...(n.active != null ? { active: n.active } : {}),
      ...(n.tabBar != null ? { tabBar: n.tabBar } : {}),
      w: dim(n.w, FILL),
      h: dim(n.h, FILL),
      children: n.children.map(normNode),
    }
  }
  // Drop the legacy `layout` placement; size comes from w/h (defaulted to fill).
  const { layout: _legacy, ...rest } = n
  return { ...normalizeLegacyValues(rest), w: dim(n.w, FILL), h: dim(n.h, FILL) } as NormWidget
}

/**
 * Rewrite the pre-rename wire value `"instance"` to `"recordVersion"` wherever a
 * stored widget still carries it (a row saved before the vocabulary migration,
 * or the interim window before `0012_record_vocabulary` back-fills `dashboards.body`
 * — see the plan's belt-and-braces note). The contract's `Schema.Literal` still
 * accepts `"instance"` so decode doesn't reject the row; this is what actually
 * makes it render like a normal one. Drop this once no stored body round-trips
 * with the legacy value.
 */
const isLegacyInstance = (kind: string): boolean => kind === "instance"

const normalizeLegacyValues = (w: DashboardWidget): DashboardWidget => {
  if (w.type === "files" && isLegacyInstance(w.scope)) {
    return { ...w, scope: "recordVersion" }
  }
  if (w.type === "shortcuts") {
    return {
      ...w,
      items: w.items.map((i) => (isLegacyInstance(i.kind) ? { ...i, kind: "recordVersion" } : i)),
    }
  }
  if (w.type === "welcome" && w.links) {
    return {
      ...w,
      links: w.links.map((i) => (isLegacyInstance(i.kind) ? { ...i, kind: "recordVersion" } : i)),
    }
  }
  return w
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
/** Concept ids whose RECORDS the dashboard needs loaded. Excludes trend/activity
 *  (event log), tasks (filter, not scope), files/document (own RPC); calendar
 *  scopes per source. */
export const referencedConceptIds = (body: NormBody): string[] => {
  const ids = new Set<string>()
  const walk = (n: NormNode) => {
    if (isGroup(n)) {
      n.children.forEach(walk)
      return
    }
    // files/document skip even when they carry a `conceptId` — including a
    // `bindToConceptRecord` one. Their concept ref is a lookup key (which single
    // record? which fields?), resolved by their own RPCs; loading the concept's
    // record version list would fetch rows nobody reads.
    if (
      n.type === "trend" ||
      n.type === "activity" ||
      n.type === "tasks" ||
      n.type === "files" ||
      n.type === "document"
    )
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

/** A widget-owned file bucket: its id, and whether other widgets may list it. */
export type WidgetBucket = { readonly id: string; readonly shared: boolean }

/** Widget-owned file buckets anywhere in a subtree (a node, or a whole body's
 *  `children`). Deleting such a widget would strand its files, so the editor asks
 *  what to do with them first — this finds the buckets at stake. `shared` decides
 *  what "keep" means: a shared bucket's files stay reachable from a whole-org
 *  Files widget, a private one's become unreachable. */
export const bucketsIn = (nodes: ReadonlyArray<NormNode>): WidgetBucket[] => {
  const found = new Map<string, WidgetBucket>()
  const walk = (n: NormNode) => {
    if (isGroup(n)) {
      n.children.forEach(walk)
      return
    }
    if (n.type === "files" && n.scope === "widget" && n.bucketId)
      found.set(n.bucketId, { id: n.bucketId, shared: n.bucketShared !== false })
  }
  nodes.forEach(walk)
  return [...found.values()]
}

/** Just the ids — what the purge calls take. */
export const bucketIdsIn = (nodes: ReadonlyArray<NormNode>): string[] =>
  bucketsIn(nodes).map((b) => b.id)

/** Record-view ids this dashboard "uses" — the record view its list/kanban widgets
 *  open rows with. An explicit `recordDashboardId` wins; otherwise the rows open the
 *  concept's DEFAULT view (its first by order, what "Open rows with: Default record
 *  view" means), so that's resolved via `defaultByConcept` (concept id → its default
 *  record-view id) when supplied. Drives the dashboard list's usage grouping (a used
 *  record view nests beneath its referencer). */
export const referencedDashboardIds = (
  body: NormBody,
  defaultByConcept?: ReadonlyMap<string, string>,
): string[] => {
  const ids = new Set<string>()
  const walk = (n: NormNode) => {
    if (isGroup(n)) {
      n.children.forEach(walk)
      return
    }
    if (n.type !== "list" && n.type !== "kanban") return
    if (n.recordDashboardId) {
      ids.add(n.recordDashboardId)
      return
    }
    // No explicit view → rows open the concept's default (first) record view.
    if (n.conceptId && defaultByConcept) {
      const def = defaultByConcept.get(n.conceptId)
      if (def) ids.add(def)
    }
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

/** A blank tabs group — starts with NO tabs (the dashboard shows "No tab added").
 *  Tabs are added by dragging any node (widget or group) onto the tab bar; the
 *  dropped node IS the tab. `direction` is irrelevant under tabs but kept so a
 *  flow⇄tabs toggle is lossless. */
export const newTabs = (): NormGroup => ({
  id: crypto.randomUUID(),
  type: "group",
  direction: "col",
  display: "tabs",
  tabBar: "top",
  w: { ...NEW },
  h: { ...NEW },
  children: [],
})

/**
 * A blank widget of the given type — fills its slot; the editor sets concept/config.
 *
 * `recordMode` = being added to a RECORD dashboard, where the open record is the
 * obvious subject. It only changes defaults that would otherwise land useless
 * there: a Files widget defaulting to whole-org scope browses every file in the
 * org and offers no upload, so "add Files to a record view" produced a tile with
 * no drop target at all.
 */
export const newWidget = (type: DashboardWidget["type"], recordMode = false): NormWidget => {
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
    // Analytics carries a query, not a conceptId — its numbers come from the
    // provider, not from record versions.
    case "analytics":
      return {
        ...base,
        type: "analytics",
        provider: "posthog",
        metric: "active_users",
        interval: "week",
        since: "30d",
      } as NormWidget
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
      // On a record dashboard: this record's files, uploadable. `recordVersionId` stays
      // null — WidgetCanvas fills it from the open record, so one template serves
      // every record of the concept.
      return recordMode
        ? ({
            ...scoped,
            type: "files",
            scope: "recordVersion",
            recordVersionId: null,
            allowUpload: true,
          } as NormWidget)
        : ({ ...scoped, type: "files", scope: "org" } as NormWidget)
    case "document":
      return { ...scoped, type: "document", recordVersionId: null, fieldId: null } as NormWidget
    // Record-scoped widgets carry no config — the current record is supplied by
    // page context on a record dashboard.
    case "record-details":
    case "record-connections":
    case "record-graph":
    case "record-labels":
    case "record-versions":
    case "record-notes":
    case "record-tasks":
    case "record-mentions":
    case "record-activity":
      return { ...base, type } as NormWidget
  }
}

/** Recast a widget to a different type, keeping id, size, and title (and concept
 *  when both types are concept-scoped). Everything else is reset to the new type's
 *  defaults — including a files widget's `bucketId`, which the target type has
 *  nowhere to store. Retyping away therefore strands that widget's files, so the
 *  editor prompts about them first (see `withBucketPrompt`). */
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
