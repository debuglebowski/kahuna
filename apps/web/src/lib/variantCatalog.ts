import type { ReactNode } from "react"
import type { DashboardWidget } from "./api"

/**
 * The single source of truth for every widget's presentation **variants**.
 *
 * A variant is "layout + preset settings": picking one sets `widget.variant`
 * (which the renderer branches on for layout) and merges its `preset` patch onto
 * the widget config (a bundle of defaults — e.g. a "Compact" variant might preset
 * `format: "compact"`). The id is a free-form string stored verbatim in the
 * dashboard body (`variant?: string` on the widget base) — so **adding a variant
 * is an edit to THIS file plus a renderer branch, never a contract/engine schema
 * change and never an API restart.**
 *
 * Conventions:
 *  - The FIRST entry for a type is its default (used when `widget.variant` is
 *    unset). It MUST match the renderer's hardcoded fallback (e.g. MetricWidget's
 *    `widget.variant ?? "tile"`) so an unset widget and an explicit default render
 *    identically.
 *  - `preset` is optional; pure-layout variants (today's migrated ones) omit it.
 *  - `Preview` is optional; the picker shows it as a thumbnail and falls back to
 *    the label when absent. Populate it (a tiny CSS/SVG mock) for a visual gallery.
 *  - The picker hides itself when a type has fewer than two variants, so the
 *    "populate me" single-entry stubs below are invisible until you add a second.
 */

/** A config patch shallow-merged onto the widget when this variant is selected.
 *  Keys are fields of that widget type's config; values are the preset defaults. */
export type VariantPreset = Partial<Record<string, unknown>>

export interface WidgetVariant {
  /** Stable id persisted as `widget.variant` and branched on by the renderer. */
  readonly id: string
  /** Picker label. */
  readonly label: string
  /** One-line blurb under the label in the picker. */
  readonly description?: string
  /** Config defaults applied on select (the "preset settings" half). Omit for
   *  pure-layout variants. */
  readonly preset?: VariantPreset
  /** Optional gallery thumbnail; falls back to the label when absent. */
  readonly Preview?: () => ReactNode
}

type WidgetType = DashboardWidget["type"]

/** Per-type variant lists. First entry = default. Populate freely. */
export const VARIANT_CATALOG: Record<WidgetType, readonly WidgetVariant[]> = {
  metric: [
    { id: "tile", label: "Tile", description: "Big number centered over its caption." },
    { id: "bar", label: "Stat bar", description: "Number and caption on one row." },
    { id: "spark", label: "Sparkline", description: "Number beside an inline trend line." },
  ],
  list: [
    { id: "table", label: "Table", description: "Columned rows." },
    { id: "cards", label: "Cards", description: "One card per item." },
    { id: "rows", label: "Line feed", description: "Compact one-line rows with a status dot." },
    { id: "grouped", label: "Grouped", description: "Collapsible sections by an enum field." },
    { id: "gallery", label: "Gallery", description: "Responsive tile grid." },
  ],
  attention: [
    { id: "bands", label: "Band badges", description: "Badge rollup + stale queue." },
    { id: "strip", label: "Heat strip", description: "Proportional heat strip + worst-N." },
  ],
  activity: [
    { id: "timeline", label: "Timeline", description: "Avatar rail with timestamps." },
    { id: "log", label: "Dense log", description: "Compact one-line rows." },
  ],
  tasks: [
    { id: "full", label: "Full surface", description: "Toolbar, composer, and groups." },
    { id: "checklist", label: "Checklist", description: "Flat rows, no chrome." },
  ],
  members: [
    { id: "rows", label: "Directory rows", description: "The full member list." },
    { id: "grid", label: "Avatar grid", description: "Read-only orientation cards." },
  ],
  welcome: [
    { id: "hero", label: "Hero banner", description: "The big-title greeting." },
    { id: "card", label: "Orientation card", description: "Compact greeting." },
  ],
  goal: [
    { id: "bar", label: "Progress bar", description: "Horizontal fill toward target." },
    { id: "ring", label: "Ring", description: "Circular progress dial." },
    { id: "number", label: "Number", description: "Current value vs target, plain." },
  ],
  shortcuts: [
    { id: "list", label: "List", description: "Stacked rows." },
    { id: "grid", label: "Icon grid", description: "Tiled buttons." },
  ],
  files: [
    { id: "list", label: "List rows", description: "Filename rows." },
    { id: "gallery", label: "Gallery", description: "Thumbnail grid." },
  ],

  // ── Populate me ───────────────────────────────────────────────────────────
  // These types have no presentation variants yet. Add entries (and a matching
  // branch in the renderer) to give them a Style picker — the single-entry stub
  // keeps the picker hidden until then.
  breakdown: [{ id: "default", label: "Default" }],
  trend: [{ id: "default", label: "Default" }],
  kanban: [{ id: "default", label: "Default" }],
  calendar: [{ id: "default", label: "Default" }],
  gantt: [{ id: "default", label: "Default" }],
  note: [{ id: "default", label: "Default" }],
  document: [{ id: "default", label: "Default" }],
  // Record-scoped panels — single fixed layout each (no variant picker).
  "record-details": [{ id: "default", label: "Default" }],
  "record-connections": [{ id: "default", label: "Default" }],
  "record-graph": [{ id: "default", label: "Default" }],
  "record-labels": [{ id: "default", label: "Default" }],
  "record-versions": [{ id: "default", label: "Default" }],
  "record-notes": [{ id: "default", label: "Default" }],
  "record-tasks": [{ id: "default", label: "Default" }],
  "record-activity": [{ id: "default", label: "Default" }],
}

/** Variants for a widget type (empty array if somehow unknown). */
export const variantsFor = (type: WidgetType): readonly WidgetVariant[] =>
  VARIANT_CATALOG[type] ?? []

/** The default variant id for a type (its first catalog entry). */
export const defaultVariantId = (type: WidgetType): string | undefined => variantsFor(type)[0]?.id

/** Look up one variant definition by id. */
export const findVariant = (type: WidgetType, id: string | undefined): WidgetVariant | undefined =>
  id == null ? undefined : variantsFor(type).find((v) => v.id === id)

/** The effective variant id for a widget: its explicit `variant`, else the
 *  type's default. */
export const resolveVariantId = (widget: {
  readonly type: WidgetType
  readonly variant?: string
}): string | undefined => widget.variant ?? defaultVariantId(widget.type)

/** The config patch to apply when selecting `id`: sets `variant` and merges the
 *  variant's preset (layout + preset settings). Unknown id → just sets `variant`. */
export const variantPatch = (type: WidgetType, id: string): Record<string, unknown> => ({
  variant: id,
  ...(findVariant(type, id)?.preset ?? {}),
})
