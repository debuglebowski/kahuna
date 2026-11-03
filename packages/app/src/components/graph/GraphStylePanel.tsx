import { RotateCcw, Settings2, Sparkles } from "lucide-react"
import type { ReactNode } from "react"
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
import { DEFAULT_GRAPH_STYLE, GRAPH_STYLE_RANGES, type GraphStyle } from "../../lib/graphStyle"

type NumericKey = keyof typeof GRAPH_STYLE_RANGES
type BooleanKey = {
  [K in keyof GraphStyle]: GraphStyle[K] extends boolean ? K : never
}[keyof GraphStyle]
type Change = (patch: Partial<GraphStyle>) => void

/* ── rows: one label column, one control column, same rhythm everywhere ── */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h4 className="text-xs font-medium text-muted-foreground">
        {title}
        {hint && <span className="font-normal"> · {hint}</span>}
      </h4>
      {children}
    </section>
  )
}

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
      <Label className="text-sm font-normal">{label}</Label>
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
}: {
  label: string
  k: NumericKey
  style: GraphStyle
  onChange: Change
}) {
  const { min, max, step } = GRAPH_STYLE_RANGES[k]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-normal">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{style[k]}px</span>
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

/**
 * The concept graph's look settings (gear next to Layout). Non-modal so the
 * canvas stays visible; any click outside (e.g. on the canvas) closes it.
 * Everything except "Auto layout" applies live; that section applies when
 * Auto runs, so it carries its own "Re-run Auto". Settings that can't apply
 * (corner rounding on smooth lines, label direction with labels hidden) are
 * hidden rather than greyed out.
 */
export function GraphStylePanel({
  style,
  onChange,
  onRerunAuto,
}: {
  style: GraphStyle
  onChange: (next: GraphStyle) => void
  onRerunAuto: () => void
}) {
  const set: Change = (patch) => onChange({ ...style, ...patch })
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="shadow-sm"
          aria-label="Graph look settings"
          title="Look settings"
        >
          <Settings2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[1040px] max-w-[calc(100vw-2rem)] p-0 shadow-2xl"
        // Clicks outside close it — except inside this panel's own dropdown
        // lists, which are portaled out of its DOM and would count as outside.
        onInteractOutside={(e) => {
          const t = e.target
          if (t instanceof Element && t.closest("[data-radix-popper-content-wrapper]"))
            e.preventDefault()
        }}
      >
        <div className="grid grid-cols-4 gap-x-8 p-6">
          <Section title="Lines">
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
            <SliderRow label="Gap between lines" k="lineSpacing" style={style} onChange={set} />
            <SliderRow label="Clearance around boxes" k="clearance" style={style} onChange={set} />
          </Section>
          <Section title="Labels">
            <SelectRow
              label="Show"
              value={style.labels}
              options={[
                { value: "both", label: "Both names" },
                { value: "forward", label: "Field name" },
                { value: "none", label: "Hidden" },
              ]}
              onChange={(labels) => set({ labels })}
            />
            {style.labels !== "none" && (
              <SelectRow
                label="Direction"
                value={style.labelDirection}
                options={[
                  { value: "horizontal", label: "Horizontal" },
                  { value: "along", label: "Along line" },
                ]}
                onChange={(labelDirection) => set({ labelDirection })}
              />
            )}
          </Section>
          <Section title="Dragging">
            <CheckRow label="Snap to grid" k="snapToGrid" style={style} onChange={set} />
            <CheckRow
              label="Re-route lines while dragging"
              k="rerouteWhileDragging"
              style={style}
              onChange={set}
            />
          </Section>
          <Section title="Auto layout" hint="applies on re-run">
            <SelectRow
              label="Flow"
              value={style.direction}
              options={[
                { value: "down", label: "Top to bottom" },
                { value: "right", label: "Left to right" },
              ]}
              onChange={(direction) => set({ direction })}
            />
            <SliderRow label="Space between boxes" k="nodeSpacing" style={style} onChange={set} />
            <SliderRow label="Space between rows" k="layerSpacing" style={style} onChange={set} />
            <SliderRow label="Space between groups" k="groupSpacing" style={style} onChange={set} />
          </Section>
        </div>
        {/* Footer: panel-wide actions, apart from the settings themselves. */}
        <div className="flex items-center justify-between border-t px-6 py-3">
          <Button
            size="sm"
            variant="ghost"
            // Optical alignment: pull the ghost button's padding back to the column edge.
            className="-ml-2.5 text-muted-foreground"
            onClick={() => onChange(DEFAULT_GRAPH_STYLE)}
          >
            <RotateCcw />
            Reset to defaults
          </Button>
          <Button size="sm" variant="outline" onClick={onRerunAuto}>
            <Sparkles />
            Re-run Auto
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
