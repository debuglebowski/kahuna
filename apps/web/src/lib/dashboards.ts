import type { DashboardBody, DashboardWidget } from "./api"

/**
 * Pure helpers for the dashboard canvas: which concepts a body references (to
 * mount their live collections), and translating between the stored widget list
 * and react-grid-layout's `Layout[]`. No React — the page wires these to RGL.
 */

export const GRID_COLS = 12
export const GRID_ROW_HEIGHT = 72

/** A react-grid-layout item (subset we use). */
export interface GridItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

/** Concept ids whose INSTANCES a dashboard needs loaded. Excludes trend/activity
 *  — those read the event log (via `listEvents`), not the instance collections. */
export const referencedConceptIds = (
  body: DashboardBody,
  implicitConceptId?: string | null,
): string[] => {
  const ids = new Set<string>()
  for (const w of body.widgets) {
    if (w.type === "trend" || w.type === "activity") continue
    const cid = w.conceptId ?? implicitConceptId
    if (cid) ids.add(cid)
  }
  return [...ids]
}

/** RGL layout array derived from the widgets (coords live inline on each). */
export const widgetLayouts = (body: DashboardBody): GridItem[] =>
  body.widgets.map((w) => ({ i: w.id, ...w.layout, minW: 2, minH: 2 }))

/** Fold an RGL layout change back onto the body (match by widget id). */
export const applyLayouts = (body: DashboardBody, layout: readonly GridItem[]): DashboardBody => {
  const byId = new Map(layout.map((l) => [l.i, l] as const))
  return {
    ...body,
    widgets: body.widgets.map((w) => {
      const l = byId.get(w.id)
      return l ? { ...w, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : w
    }),
  }
}

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
  w: number,
  h: number,
): boolean => x < a.x + a.w && x + w > a.x && y < a.y + a.h && y + h > a.y

/** First free slot for a `w`×`h` tile, scanning left-to-right then top-to-bottom
 *  — so new widgets flow across the row and wrap, instead of piling at x:0. */
const nextSlot = (body: DashboardBody, w: number, h: number): { x: number; y: number } => {
  const cols = body.cols ?? GRID_COLS
  const ws = body.widgets.map((wi) => wi.layout)
  const maxY = ws.reduce((m, l) => Math.max(m, l.y + l.h), 0)
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (!ws.some((l) => overlaps(l, x, y, w, h))) return { x, y }
    }
  }
  return { x: 0, y: maxY }
}

export const addWidget = (body: DashboardBody, widget: DashboardWidget): DashboardBody => ({
  ...body,
  widgets: [...body.widgets, widget],
})

export const removeWidget = (body: DashboardBody, id: string): DashboardBody => ({
  ...body,
  widgets: body.widgets.filter((w) => w.id !== id),
})

/** Replace one widget by id, merging a partial patch (type/id preserved). */
export const updateWidget = (
  body: DashboardBody,
  id: string,
  patch: Partial<DashboardWidget>,
): DashboardBody => ({
  ...body,
  widgets: body.widgets.map((w) => (w.id === id ? ({ ...w, ...patch } as DashboardWidget) : w)),
})

/** Default tile size per widget type (on the 12-col grid). */
const DEFAULT_SIZE: Record<DashboardWidget["type"], { w: number; h: number }> = {
  metric: { w: 3, h: 2 },
  list: { w: 6, h: 4 },
  breakdown: { w: 4, h: 4 },
  attention: { w: 4, h: 3 },
  trend: { w: 6, h: 3 },
  activity: { w: 4, h: 4 },
}

/** A blank widget of the given type, appended at the bottom of the grid with no
 *  concept set (the editor fills in the concept + config). */
export const newWidget = (body: DashboardBody, type: DashboardWidget["type"]): DashboardWidget => {
  const size = DEFAULT_SIZE[type]
  const base = {
    id: crypto.randomUUID(),
    title: null,
    layout: { ...nextSlot(body, size.w, size.h), ...size },
    conceptId: null,
  } as const
  switch (type) {
    case "metric":
      return { ...base, type: "metric", conditions: [], agg: "count" }
    case "list":
      return { ...base, type: "list", conditions: [], orderBy: null, limit: 10 }
    case "breakdown":
      return { ...base, type: "breakdown", conditions: [], groupBy: "", chart: "bar" }
    case "attention":
      return { ...base, type: "attention" }
    case "trend":
      return { ...base, type: "trend", bucket: "day", since: "30d" }
    case "activity":
      return { ...base, type: "activity" }
  }
}
