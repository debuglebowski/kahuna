import type { Dashboard, DashboardBody, DashboardNode } from "./api"

/**
 * Pick which record dashboard renders an instance. `records` is a concept's
 * record dashboards as returned by `listRecordDashboards` (ordered by position).
 * Resolution order:
 *   1. an explicit `viewRef` that names one of THIS concept's record dashboards
 *      (a foreign/stale ref simply isn't found → falls through), then
 *   2. the FIRST record dashboard (top of the order — the concept's default), then
 *   3. none — the caller renders the built-in fallback layout.
 */
export const resolveRecordDashboard = (
  records: ReadonlyArray<Dashboard>,
  viewRef?: string | null,
): Dashboard | null => {
  if (viewRef) {
    const named = records.find((d) => d.id === viewRef)
    if (named) return named
  }
  return records[0] ?? null
}

const recordW = (id: string, type: DashboardNode["type"]): DashboardNode =>
  ({ id, type, title: null }) as DashboardNode

// ── instance_view → record dashboard migration ───────────────────────────────

/** A legacy instance-view tile (mirror of the contract `InstanceViewTile`). */
export interface ViewTileLike {
  readonly id: string
  readonly contents: ReadonlyArray<string>
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface TilesToBodyOpts {
  readonly versioned: boolean
  readonly hasDocuments: boolean
  /** The concept's first rich text field — bound to migrated `document` tiles. */
  readonly richtextFieldId: string | null
  readonly conceptId: string
}

/** A legacy content key → its record widget node (null = drop: not applicable to
 *  this concept, or has no record-widget equivalent that can stand alone). */
const contentToNode = (key: string, id: string, opts: TilesToBodyOpts): DashboardNode | null => {
  if (key === "document") {
    if (!opts.hasDocuments || !opts.richtextFieldId) return null
    return {
      id,
      type: "document",
      title: null,
      conceptId: opts.conceptId,
      fieldId: opts.richtextFieldId,
    } as DashboardNode
  }
  if (key === "files") {
    return { id, type: "files", title: null, scope: "instance", allowUpload: true } as DashboardNode
  }
  if (key === "versions" && !opts.versioned) return null
  const map: Record<string, DashboardNode["type"]> = {
    details: "record-details",
    connected: "record-connections",
    graph: "record-graph",
    labels: "record-labels",
    versions: "record-versions",
    notes: "record-notes",
    tasks: "record-tasks",
    activity: "record-activity",
  }
  const type = map[key]
  return type ? recordW(id, type) : null
}

/** One tile → a node: a single widget, or a tabs group when it held >1 content
 *  (the instance view rendered multi-content tiles as tabs). null when nothing in
 *  it applies to this concept. */
const tileToNode = (tile: ViewTileLike, opts: TilesToBodyOpts): DashboardNode | null => {
  const nodes = tile.contents
    .map((k, i) => contentToNode(k, `${tile.id}-${i}`, opts))
    .filter((n): n is DashboardNode => n !== null)
  if (nodes.length === 0) return null
  const w = { unit: "fr" as const, value: Math.max(1, tile.w) }
  if (nodes.length === 1) return { ...nodes[0]!, w }
  return {
    id: `${tile.id}-tabs`,
    type: "group",
    direction: "col",
    display: "tabs",
    tabBar: "top",
    w,
    children: nodes,
  } as DashboardNode
}

/**
 * Translate a saved instance-view tile layout into a record dashboard body —
 * preserving WHICH panels a concept's custom layout showed (and their left-right
 * proportions) by grouping tiles into rows (by `y`, ordered by `x`) and mapping
 * each content key to its record widget. Tiles/contents that don't apply to the
 * concept (versions on a non-versioned concept, document with no rich text) drop.
 * Returns null when nothing survives (caller falls back to the built-in layout).
 */
export const tilesToBody = (
  tiles: ReadonlyArray<ViewTileLike>,
  opts: TilesToBodyOpts,
): DashboardBody | null => {
  const byRow = new Map<number, ViewTileLike[]>()
  for (const t of [...tiles].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const list = byRow.get(t.y) ?? []
    list.push(t)
    byRow.set(t.y, list)
  }
  const rows = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, list], ri): DashboardNode | null => {
      const children = list
        .map((t) => tileToNode(t, opts))
        .filter((n): n is DashboardNode => n !== null)
      if (children.length === 0) return null
      // A single-tile row collapses to the tile itself (no needless wrapper).
      if (children.length === 1) return children[0]!
      return { id: `row-${y}-${ri}`, type: "group", direction: "row", children } as DashboardNode
    })
    .filter((n): n is DashboardNode => n !== null)
  if (rows.length === 0) return null
  return { direction: "col", children: rows }
}

/**
 * The built-in record layout — what a record renders with when its concept has no
 * record dashboards yet. Mirrors the old `metadata-rail` instance view: a wide
 * main column (details, notes, tasks, files, activity) beside a narrower rail
 * (labels, connections, versions when the concept is versioned). Stable ids so it
 * doesn't churn across renders. The client migrates it to the runtime tree.
 */
export const defaultRecordBody = (versioned: boolean): DashboardBody => ({
  direction: "row",
  children: [
    {
      id: "rec-main",
      type: "group",
      direction: "col",
      w: { unit: "fr", value: 2 },
      children: [
        recordW("rec-details", "record-details"),
        recordW("rec-notes", "record-notes"),
        recordW("rec-tasks", "record-tasks"),
        { id: "rec-files", type: "files", title: null, scope: "instance", allowUpload: true },
        recordW("rec-activity", "record-activity"),
      ],
    },
    {
      id: "rec-side",
      type: "group",
      direction: "col",
      w: { unit: "fr", value: 1 },
      children: [
        recordW("rec-labels", "record-labels"),
        recordW("rec-connected", "record-connections"),
        ...(versioned ? [recordW("rec-versions", "record-versions")] : []),
      ],
    },
  ],
})
