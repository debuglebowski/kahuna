/**
 * Org-wide look + arrangement settings for the concept graph canvas (the gear
 * in its toolbar). Stored as a loose jsonb document — every field optional on the
 * wire — and normalised here, so a missing, stale or hand-edited value can
 * never break the render: unknown keys are dropped, numbers are clamped,
 * enums fall back to the default.
 *
 * Two kinds of setting:
 * - **Arrange** (method, direction, spacings) — take effect when the graph is
 *   (re-)arranged.
 * - Everything else (lines, cards, labels, dragging) — live.
 *
 * {@link GRAPH_PRESETS} are named bundles of the look + spacing settings.
 */

export type GraphDirection = "down" | "right"
/** How Arrange places cards: layered (Auto) or force-like (Organic). */
export type GraphLayoutMethod = "auto" | "organic"
export type GraphLabelMode = "both" | "forward" | "none"
export type GraphLabelDirection = "horizontal" | "along"
export type GraphLineShape = "square" | "smooth"
/** Built-in cards (e.g. Member): one shared card, or a small one per concept. */
export type GraphBuiltinCards = "shared" | "perConcept"

export interface GraphStyle {
  readonly layoutMethod: GraphLayoutMethod
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
  /** Edge label text size as % of normal (Labels → Text size). */
  readonly labelScale: number
  /** Re-route lines live while a box is dragged, or only once it's dropped. */
  readonly rerouteWhileDragging: boolean
  /** Dragged boxes snap to the canvas dot grid ({@link GRAPH_GRID} px). */
  readonly snapToGrid: boolean
  /** Card size as % of normal (Size slider). */
  readonly cardScale: number
  readonly builtinCards: GraphBuiltinCards
}

/** The canvas dot spacing — also the snap step. */
export const GRAPH_GRID = 20

export const DEFAULT_GRAPH_STYLE: GraphStyle = {
  layoutMethod: "auto",
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
  labelScale: 100,
  rerouteWhileDragging: true,
  snapToGrid: false,
  cardScale: 100,
  builtinCards: "shared",
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
  cardScale: { min: 80, max: 300, step: 5 },
  labelScale: { min: 80, max: 300, step: 5 },
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
    layoutMethod: r.layoutMethod === "organic" ? "organic" : "auto",
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
    labelScale: num(r.labelScale, "labelScale"),
    rerouteWhileDragging: r.rerouteWhileDragging !== false,
    snapToGrid: r.snapToGrid === true,
    cardScale: num(r.cardScale, "cardScale"),
    builtinCards: r.builtinCards === "perConcept" ? "perConcept" : "shared",
  }
}

/** One relation's label under a mode (`inverse` only shows in "both"). */
export function relationLabel(mode: GraphLabelMode, forward: string, inverse?: string | null) {
  if (mode === "none") return ""
  return mode === "both" && inverse ? `${forward} ⇄ ${inverse}` : forward
}

/**
 * Card dimensions at a size percentage (the Size slider; 100 = the original
 * look: 14px text, 16×8 padding, 15px icon). Inline px rather than Tailwind
 * classes because the slider is continuous. Satellites (per-concept Member
 * cards) scale from a smaller base.
 */
export function cardMetrics(scalePct: number) {
  const k = scalePct / 100
  const r = (n: number) => Math.round(n * k * 10) / 10
  return {
    fontSize: r(14),
    padX: r(16),
    padY: r(8),
    icon: Math.round(15 * k),
    gap: r(6),
    radius: r(8),
    satFont: r(12),
    satIcon: Math.round(13 * k),
    satH: Math.round(26 * k),
    satPadX: r(8),
  }
}

/** The settings a preset sets — look + spacing. Method, flow direction,
 *  dragging, Member cards and label direction are left as the user has them. */
type PresetValues = Pick<
  GraphStyle,
  | "cardScale"
  | "labelScale"
  | "labels"
  | "lineShape"
  | "cornerRadius"
  | "lineWidth"
  | "lineSpacing"
  | "clearance"
  | "nodeSpacing"
  | "layerSpacing"
  | "groupSpacing"
>

export type GraphPresetId = "compact" | "balanced" | "spacious" | "presentation"

/** One-click looks. "Balanced" is exactly the defaults. */
export const GRAPH_PRESETS: ReadonlyArray<{
  id: GraphPresetId
  name: string
  values: PresetValues
}> = [
  {
    id: "compact",
    name: "Compact",
    values: {
      cardScale: 85,
      labelScale: 90,
      labels: "forward",
      lineShape: "square",
      cornerRadius: 6,
      lineWidth: 1.25,
      lineSpacing: 8,
      clearance: 10,
      nodeSpacing: 32,
      layerSpacing: 48,
      groupSpacing: 64,
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    values: {
      cardScale: DEFAULT_GRAPH_STYLE.cardScale,
      labelScale: DEFAULT_GRAPH_STYLE.labelScale,
      labels: DEFAULT_GRAPH_STYLE.labels,
      lineShape: DEFAULT_GRAPH_STYLE.lineShape,
      cornerRadius: DEFAULT_GRAPH_STYLE.cornerRadius,
      lineWidth: DEFAULT_GRAPH_STYLE.lineWidth,
      lineSpacing: DEFAULT_GRAPH_STYLE.lineSpacing,
      clearance: DEFAULT_GRAPH_STYLE.clearance,
      nodeSpacing: DEFAULT_GRAPH_STYLE.nodeSpacing,
      layerSpacing: DEFAULT_GRAPH_STYLE.layerSpacing,
      groupSpacing: DEFAULT_GRAPH_STYLE.groupSpacing,
    },
  },
  {
    id: "spacious",
    name: "Spacious",
    values: {
      cardScale: 110,
      labelScale: 105,
      labels: "both",
      lineShape: "smooth",
      cornerRadius: 8,
      lineWidth: 1.5,
      lineSpacing: 16,
      clearance: 20,
      nodeSpacing: 88,
      layerSpacing: 112,
      groupSpacing: 144,
    },
  },
  {
    id: "presentation",
    name: "Presentation",
    values: {
      cardScale: 160,
      labelScale: 150,
      labels: "forward",
      lineShape: "smooth",
      cornerRadius: 12,
      lineWidth: 2.25,
      lineSpacing: 18,
      clearance: 22,
      nodeSpacing: 96,
      layerSpacing: 128,
      groupSpacing: 160,
    },
  },
]

/** The preset the style currently matches exactly, or null ("Custom"). */
export function matchingPreset(style: GraphStyle): GraphPresetId | null {
  for (const p of GRAPH_PRESETS) {
    const keys = Object.keys(p.values) as (keyof PresetValues)[]
    if (keys.every((k) => style[k] === p.values[k])) return p.id
  }
  return null
}
