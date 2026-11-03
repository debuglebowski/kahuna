/**
 * Org-wide look settings for the concept graph canvas (the gear next to
 * Layout). Stored as a loose jsonb document — every field optional on the
 * wire — and normalised here, so a missing, stale or hand-edited value can
 * never break the render: unknown keys are dropped, numbers are clamped,
 * enums fall back to the default.
 *
 * Two kinds of setting:
 * - **Layout** (direction, spacings) — only take effect when Auto runs.
 * - **Lines** (corners, line spacing, clearance, width, labels) — live.
 */

export type GraphDirection = "down" | "right"
export type GraphLabelMode = "both" | "forward" | "none"
export type GraphLabelDirection = "horizontal" | "along"
export type GraphLineShape = "square" | "smooth"

export interface GraphStyle {
  readonly direction: GraphDirection
  /** Gap between nodes in the same layer. */
  readonly nodeSpacing: number
  /** Gap between layers (rows when flowing down). */
  readonly layerSpacing: number
  /** Gap between unconnected groups. */
  readonly groupSpacing: number
  /** Rounding of line elbows; 0 = sharp corners. */
  readonly cornerRadius: number
  /** Square corners (rounded by `cornerRadius`) or one smooth curve per line. */
  readonly lineShape: GraphLineShape
  /** Gap between parallel lines. */
  readonly lineSpacing: number
  /** How far lines keep clear of nodes they pass. */
  readonly clearance: number
  readonly lineWidth: number
  /** Edge label text: both directions, the forward name only, or none. */
  readonly labels: GraphLabelMode
  /** Labels always horizontal, or turned to follow vertical line segments. */
  readonly labelDirection: GraphLabelDirection
  /** Re-route lines live while a box is dragged, or only once it's dropped. */
  readonly rerouteWhileDragging: boolean
  /** Dragged boxes snap to the canvas dot grid ({@link GRAPH_GRID} px). */
  readonly snapToGrid: boolean
}

/** The canvas dot spacing — also the snap step. */
export const GRAPH_GRID = 20

export const DEFAULT_GRAPH_STYLE: GraphStyle = {
  direction: "down",
  nodeSpacing: 48,
  layerSpacing: 64,
  groupSpacing: 96,
  cornerRadius: 8,
  lineShape: "square",
  lineSpacing: 12,
  clearance: 14,
  lineWidth: 1.5,
  labels: "both",
  labelDirection: "horizontal",
  rerouteWhileDragging: true,
  snapToGrid: false,
}

/** Slider bounds per numeric setting — also the clamp range on read. */
export const GRAPH_STYLE_RANGES = {
  nodeSpacing: { min: 16, max: 160, step: 4 },
  layerSpacing: { min: 24, max: 200, step: 4 },
  groupSpacing: { min: 32, max: 240, step: 8 },
  cornerRadius: { min: 0, max: 24, step: 1 },
  lineSpacing: { min: 4, max: 32, step: 1 },
  clearance: { min: 4, max: 40, step: 1 },
  lineWidth: { min: 1, max: 3, step: 0.25 },
} as const satisfies Record<string, { min: number; max: number; step: number }>

type NumericKey = keyof typeof GRAPH_STYLE_RANGES

const num = (raw: unknown, key: NumericKey): number => {
  const { min, max } = GRAPH_STYLE_RANGES[key]
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, raw))
    : DEFAULT_GRAPH_STYLE[key]
}

/** Any stored value → a complete, in-range style. */
export function normalizeGraphStyle(raw: unknown): GraphStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    direction: r.direction === "right" ? "right" : "down",
    nodeSpacing: num(r.nodeSpacing, "nodeSpacing"),
    layerSpacing: num(r.layerSpacing, "layerSpacing"),
    groupSpacing: num(r.groupSpacing, "groupSpacing"),
    cornerRadius: num(r.cornerRadius, "cornerRadius"),
    lineShape: r.lineShape === "smooth" ? "smooth" : "square",
    lineSpacing: num(r.lineSpacing, "lineSpacing"),
    clearance: num(r.clearance, "clearance"),
    lineWidth: num(r.lineWidth, "lineWidth"),
    labels: r.labels === "forward" || r.labels === "none" ? r.labels : "both",
    labelDirection: r.labelDirection === "along" ? "along" : "horizontal",
    rerouteWhileDragging: r.rerouteWhileDragging !== false,
    snapToGrid: r.snapToGrid === true,
  }
}

/** One relation's label under a mode (`inverse` only shows in "both"). */
export function relationLabel(mode: GraphLabelMode, forward: string, inverse?: string | null) {
  if (mode === "none") return ""
  return mode === "both" && inverse ? `${forward} ⇄ ${inverse}` : forward
}
