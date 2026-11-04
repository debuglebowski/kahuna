import { RotateCcw, Settings2, Sparkles } from "lucide-react"
import type { ReactNode } from "react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  DEFAULT_GRAPH_STYLE,
  GRAPH_PRESETS,
  GRAPH_STYLE_RANGES,
  type GraphPresetId,
  type GraphStyle,
  matchingPreset,
} from "../../lib/graphStyle"

type NumericKey = keyof typeof GRAPH_STYLE_RANGES
type BooleanKey = {
  [K in keyof GraphStyle]: GraphStyle[K] extends boolean ? K : never
}[keyof GraphStyle]
type Change = (patch: Partial<GraphStyle>) => void

/* ── rows: one label column, one control column, same rhythm everywhere ── */

function SelectRow<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: V
  options: ReadonlyArray<{ value: V; label: string }>
  onChange: (v: V) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="whitespace-nowrap text-sm font-normal">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as V)}>
        <SelectTrigger size="sm" className="w-36" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SliderRow({
  label,
  k,
  style,
  onChange,
  unit = "px",
}: {
  label: string
  k: NumericKey
  style: GraphStyle
  onChange: Change
  unit?: string
}) {
  const { min, max, step } = GRAPH_STYLE_RANGES[k]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-normal">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {style[k]}
          {unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[style[k]]}
        onValueChange={([v]) => v !== undefined && onChange({ [k]: v })}
        aria-label={label}
      />
    </div>
  )
}

function CheckRow({
  label,
  k,
  style,
  onChange,
}: {
  label: string
  k: BooleanKey
  style: GraphStyle
  onChange: Change
}) {
  const id = `graph-style-${k}`
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Checkbox id={id} checked={style[k]} onCheckedChange={(v) => onChange({ [k]: v === true })} />
    </div>
  )
}

/** Tiny preview glyphs for the preset tiles: box size, gap and line shape. */
function PresetGlyph({ id }: { id: GraphPresetId }) {
  const g = {
    compact: { w: 14, h: 9, gap: 10, curve: false },
    balanced: { w: 16, h: 11, gap: 8, curve: false },
    spacious: { w: 13, h: 12, gap: 16, curve: true },
    presentation: { w: 19, h: 17, gap: 4, curve: true },
  }[id]
  const y = 13 - g.h / 2
  const x2 = 2 + g.w + g.gap
  const mid = 13
  return (
    <svg width="46" height="26" viewBox="0 0 46 26" aria-hidden="true" className="mx-auto">
      <rect x="2" y={y} width={g.w} height={g.h} rx="2.5" fill="none" stroke="currentColor" />
      <rect x={x2} y={y} width={g.w} height={g.h} rx="2.5" fill="none" stroke="currentColor" />
      {g.curve ? (
        <path
          d={`M ${2 + g.w} ${mid} Q ${2 + g.w + g.gap / 2} ${mid - 8} ${x2} ${mid}`}
          fill="none"
          stroke="currentColor"
        />
      ) : (
        <path d={`M ${2 + g.w} ${mid} H ${x2}`} stroke="currentColor" />
      )}
    </svg>
  )
}

/** One collapsible group: title + a one-line summary of its current values. */
function Group({
  value,
  title,
  summary,
  children,
}: {
  value: string
  title: string
  summary: string
  children: ReactNode
}) {
  return (
    <AccordionItem value={value} className="border-t border-b-0 px-4">
      <AccordionTrigger className="items-center py-3 hover:no-underline">
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <span>{title}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{summary}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-3.5 pb-4">{children}</AccordionContent>
    </AccordionItem>
  )
}

const LABEL_MODES = { both: "Both names", forward: "Field name", none: "Hidden" } as const

/**
 * The concept graph's look + arrangement settings (gear in the toolbar).
 * Preset tiles on top — one click restyles AND re-arranges — then the
 * individual settings in collapsible groups, each summarised while closed.
 * Groups follow what you're adjusting: Arrange (placement: method, flow,
 * spacing, snap — the canvas has no separate Layout menu), Cards, Lines (how
 * lines look), Labels, Routing (how lines find their path). The footer holds
 * the panel-wide actions: Reset to defaults and Arrange now. Non-modal; a
 * click outside closes it.
 */
export function GraphStylePanel({
  style,
  onChange,
  onArrange,
  onApplyPreset,
}: {
  style: GraphStyle
  onChange: (next: GraphStyle) => void
  /** Re-arrange with the current settings. */
  onArrange: () => void
  /** Apply a preset's values AND re-arrange with them. */
  onApplyPreset: (next: GraphStyle) => void
}) {
  const set: Change = (patch) => onChange({ ...style, ...patch })
  const active = matchingPreset(style)
  const auto = style.layoutMethod === "auto"
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" title="Style and layout">
          <Settings2 />
          Settings
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="w-[380px] p-0 shadow-2xl"
        // Clicks outside close it — except inside this panel's own dropdown
        // lists, which are portaled out of its DOM and would count as outside.
        onInteractOutside={(e) => {
          const t = e.target
          if (t instanceof Element && t.closest("[data-radix-popper-content-wrapper]"))
            e.preventDefault()
        }}
      >
        <div className="p-4">
          <div className="mb-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>Style</span>
            {!active && <span>Custom</span>}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {GRAPH_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={active === p.id}
                onClick={() => onApplyPreset({ ...style, ...p.values })}
                className={`rounded-lg border px-1 pt-2 pb-1.5 text-center text-xs transition-colors ${
                  active === p.id
                    ? "border-foreground text-foreground"
                    : "border-input text-muted-foreground hover:border-ring hover:text-foreground"
                }`}
              >
                <PresetGlyph id={p.id} />
                <span className="mt-1 block">{p.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* All groups start collapsed; one open at a time keeps the panel short
            enough to never scroll. */}
        <Accordion type="single" collapsible>
          <Group
            value="arrange"
            title="Arrange"
            summary={[
              auto
                ? `Auto · ${style.direction === "down" ? "top to bottom" : "left to right"}`
                : "Organic",
              style.snapToGrid ? "snap" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <SelectRow
              label="Method"
              value={style.layoutMethod}
              options={[
                { value: "auto", label: "Auto" },
                { value: "organic", label: "Organic" },
              ]}
              onChange={(layoutMethod) => set({ layoutMethod })}
            />
            {auto && (
              <>
                <SelectRow
                  label="Flow"
                  value={style.direction}
                  options={[
                    { value: "down", label: "Top to bottom" },
                    { value: "right", label: "Left to right" },
                  ]}
                  onChange={(direction) => set({ direction })}
                />
                <SliderRow
                  label="Space between boxes"
                  k="nodeSpacing"
                  style={style}
                  onChange={set}
                />
                <SliderRow
                  label="Space between rows"
                  k="layerSpacing"
                  style={style}
                  onChange={set}
                />
                <SliderRow
                  label="Space between groups"
                  k="groupSpacing"
                  style={style}
                  onChange={set}
                />
              </>
            )}
            <CheckRow label="Snap to grid" k="snapToGrid" style={style} onChange={set} />
          </Group>

          <Group
            value="cards"
            title="Cards"
            summary={`${style.cardScale}% · ${
              style.builtinCards === "perConcept" ? "built-ins per concept" : "shared built-ins"
            }`}
          >
            <SliderRow label="Size" k="cardScale" unit="%" style={style} onChange={set} />
            <SelectRow
              label="Built-in cards"
              value={style.builtinCards}
              options={[
                { value: "shared", label: "One card" },
                { value: "perConcept", label: "Per concept" },
              ]}
              onChange={(builtinCards) => set({ builtinCards })}
            />
          </Group>

          <Group
            value="lines"
            title="Lines"
            summary={`${style.lineShape === "smooth" ? "Smooth" : "Square"} · ${style.lineWidth}px`}
          >
            <SelectRow
              label="Shape"
              value={style.lineShape}
              options={[
                { value: "square", label: "Square" },
                { value: "smooth", label: "Smooth" },
              ]}
              onChange={(lineShape) => set({ lineShape })}
            />
            {style.lineShape === "square" && (
              <SliderRow label="Corner rounding" k="cornerRadius" style={style} onChange={set} />
            )}
            <SliderRow label="Width" k="lineWidth" style={style} onChange={set} />
          </Group>

          <Group
            value="labels"
            title="Labels"
            summary={
              style.labels === "none"
                ? "Hidden"
                : `${LABEL_MODES[style.labels]} · ${style.labelScale}%`
            }
          >
            <SelectRow
              label="Show"
              value={style.labels}
              options={[
                { value: "both", label: LABEL_MODES.both },
                { value: "forward", label: LABEL_MODES.forward },
                { value: "none", label: LABEL_MODES.none },
              ]}
              onChange={(labels) => set({ labels })}
            />
            {style.labels !== "none" && (
              <>
                <SliderRow label="Text size" k="labelScale" unit="%" style={style} onChange={set} />
                <SelectRow
                  label="Direction"
                  value={style.labelDirection}
                  options={[
                    { value: "horizontal", label: "Horizontal" },
                    { value: "along", label: "Along line" },
                  ]}
                  onChange={(labelDirection) => set({ labelDirection })}
                />
              </>
            )}
          </Group>

          <Group
            value="routing"
            title="Routing"
            summary={`${style.lineSpacing}px gap · ${style.clearance}px clearance${
              style.rerouteWhileDragging ? "" : " · on drop"
            }`}
          >
            <SliderRow label="Gap between lines" k="lineSpacing" style={style} onChange={set} />
            <SliderRow label="Clearance around boxes" k="clearance" style={style} onChange={set} />
            <CheckRow
              label="Re-route lines while dragging"
              k="rerouteWhileDragging"
              style={style}
              onChange={set}
            />
          </Group>
        </Accordion>

        <div className="flex items-center justify-between border-t px-4 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            // Optical alignment: pull the ghost button's padding back to the edge.
            className="-ml-2.5 text-muted-foreground"
            onClick={() => onChange(DEFAULT_GRAPH_STYLE)}
          >
            <RotateCcw />
            Reset to defaults
          </Button>
          <Button size="sm" onClick={onArrange}>
            <Sparkles />
            Arrange now
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
