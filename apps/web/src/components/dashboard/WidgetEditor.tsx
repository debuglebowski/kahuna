import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useMemo, useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { KNOWN_EVENT_TYPES } from "@/lib/activity"
import { api, type Concept, type DashboardWidget, type RichTextEnvelope } from "@/lib/api"
import { taskStatusesCollection } from "@/lib/collections"
import type { Dim, DimUnit, NormWidget } from "@/lib/dashboards"
import { capitalize } from "@/lib/fieldDisplay"
import { WIDGET_CATALOG } from "@/lib/widgetCatalog"
import { ConceptSelectItems } from "../ConceptSelectItems"
import { ConditionList, useFields } from "../ConditionList"
import { RichTextEditor } from "../editor/RichTextEditor"
import { MultiCombobox } from "../MultiCombobox"
import { Field as FieldRow, IconButton, Input, ToggleChip } from "../ui"
import { CalendarSourcesEditor } from "./CalendarSourcesEditor"
import { InspectorSection } from "./InspectorSection"
import { ShortcutItemsEditor } from "./ShortcutItemsEditor"

/** "InstanceCreated" → "Instance created" (the event-type filter options). */
const humanizeType = (t: string): string => {
  const spaced = t.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** Widget types whose filter block renders (attention's conditions are optional
 *  — a fresh widget lacks the key, so a plain `in` check would hide it). */
const CONDITION_TYPES = new Set<DashboardWidget["type"]>([
  "metric",
  "list",
  "breakdown",
  "attention",
  "goal",
  "kanban",
  "gantt",
])

const ALL_TASK_META = ["due", "priority", "labels", "assignee"] as const
const ALL_MEMBER_FIELDS = ["role", "email", "joined"] as const

/** Toggle one entry of a chip set, keeping the canonical order. */
const toggleIn = <T,>(
  all: ReadonlyArray<T>,
  current: ReadonlyArray<T>,
  item: T,
  on: boolean,
): T[] => all.filter((x) => (x === item ? on : current.includes(x)))

const DIM_UNITS: { value: DimUnit; label: string }[] = [
  { value: "fr", label: "fr" },
  { value: "tiles", label: "tiles" },
  { value: "pct", label: "%" },
]

const parseNum = (raw: string): number | undefined => {
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** A numeric input with a local draft buffer — commits on blur/Enter so the
 *  parse/clamp round-trip doesn't fight typing. */
function NumberField({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  className,
}: {
  value: string
  onCommit: (raw: string) => void
  ariaLabel: string
  placeholder?: string
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        setDraft(null)
        onCommit(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
      }}
      className={className}
    />
  )
}

/** The unit picker for one axis: fr (flex weight) / tiles / %. */
function UnitSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: DimUnit
  onChange: (unit: DimUnit) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as DimUnit)}>
      <SelectTrigger aria-label={`${label} unit`} className="w-20">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DIM_UNITS.map((u) => (
          <SelectItem key={u.value} value={u.value}>
            {u.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** One optional clamp (min or max), in tiles. A blank field clears it. */
function ClampField({
  label,
  ariaLabel,
  value,
  onCommit,
}: {
  label: string
  ariaLabel: string
  value: number | undefined
  onCommit: (value: number | undefined) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <NumberField
        className="h-7 w-16"
        ariaLabel={ariaLabel}
        placeholder="—"
        value={value != null ? String(value) : ""}
        onCommit={(raw) => onCommit(raw.trim() === "" ? undefined : parseNum(raw))}
      />
    </div>
  )
}

/**
 * One axis's size: a value + unit on the top line, with optional min/max clamps
 * (tiles) beneath. A fixed label column keeps the Width and Height rows aligned.
 */
function DimField({
  label,
  dim,
  onChange,
}: {
  label: string
  dim: Dim
  onChange: (d: Dim) => void
}) {
  const set = (p: Partial<Dim>) => onChange({ ...dim, ...p })
  return (
    <div className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-x-2 gap-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <NumberField
        className="w-full"
        ariaLabel={`${label} value`}
        value={String(dim.value)}
        onCommit={(raw) => {
          const n = parseNum(raw)
          if (n != null) set({ value: n })
        }}
      />
      <UnitSelect label={label} value={dim.unit} onChange={(unit) => set({ unit })} />
      {/* Clamps sit under the value/unit, skipping the empty label column. */}
      <div className="col-span-2 col-start-2 flex items-center gap-3">
        <ClampField
          label="min"
          ariaLabel={`${label} min tiles`}
          value={dim.min}
          onCommit={(min) => set({ min })}
        />
        <ClampField
          label="max"
          ariaLabel={`${label} max tiles`}
          value={dim.max}
          onCommit={(max) => set({ max })}
        />
        <span className="ml-auto text-xs text-muted-foreground">tiles</span>
      </div>
    </div>
  )
}

/**
 * Width + height size controls for any node (widget or group). `fr` = flex
 * weight (share of the parent's leftover along its direction); `tiles`/`%` are
 * fixed; `min`/`max` (tiles) keep an `fr` from collapsing to 0 when space runs out.
 */
export function SizeControls({
  node,
  onChange,
}: {
  node: { w: Dim; h: Dim }
  onChange: (patch: { w?: Dim; h?: Dim }) => void
}) {
  return (
    <FieldRow
      label="Size"
      hint="fr = flex weight (a share of the parent's leftover space). tiles/% are fixed. min/max are in tiles and keep an fr from collapsing to 0."
    >
      <div className="space-y-3">
        <DimField label="Width" dim={node.w} onChange={(w) => onChange({ w })} />
        <DimField label="Height" dim={node.h} onChange={(h) => onChange({ h })} />
      </div>
    </FieldRow>
  )
}

/**
 * Configure one dashboard widget — the side panel of the dashboard edit modal's
 * Layout tab. The type dropdown up top recasts the widget in place (id, layout,
 * title and concept survive; other config resets to the new type's defaults).
 * Controlled: every change patches the parent's draft body immediately, so the
 * canvas previews live (the draft only persists when the modal saves). Filters
 * reuse the shared `ConditionList`.
 */
export function WidgetEditor({
  widget,
  concepts,
  onChange,
  onChangeType,
}: {
  widget: NormWidget
  concepts: readonly Concept[]
  onChange: (patch: Partial<NormWidget>) => void
  onChangeType: (type: DashboardWidget["type"]) => void
}) {
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const labels = labelsQ.data ?? []
  // Status options for the tasks widget's status filter. Read-only: no SSE
  // registration (TaskList owns that key while mounted).
  const statusesQ = useLiveQuery((qb) => qb.from({ s: taskStatusesCollection }))
  const taskStatuses = useMemo(
    () =>
      [...(statusesQ.data ?? [])]
        .filter((s) => !s.archivedAt)
        .sort((a, b) => a.position - b.position),
    [statusesQ.data],
  )
  const conceptId = "conceptId" in widget ? (widget.conceptId ?? "") : ""
  const fields = useFields(conceptId)
  const scalarFields = (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file")
  // Rich text shows fine as a list column (text preview) but grouping/sorting
  // on a { doc, text } envelope is meaningless.
  const groupableFields = scalarFields.filter((f) => f.kind !== "richtext")
  const numberFields = (fields.data ?? []).filter((f) => f.kind === "number" || f.kind === "money")
  const computedFields = (fields.data ?? []).filter((f) => f.kind === "computed")
  // Kanban columns: single-valued enums only (a card sits in exactly one column).
  const enumFields = (fields.data ?? []).filter((f) => f.kind === "enum" && !f.config.multiple)
  const dateFields = (fields.data ?? []).filter((f) => f.kind === "date")
  // Gantt swimlanes: enum or user fields (a multi value lanes by its first).
  const laneFields = (fields.data ?? []).filter((f) => f.kind === "enum" || f.kind === "user")
  // Gantt progress: plain 0–100 numbers (money amounts aren't percentages).
  const plainNumberFields = (fields.data ?? []).filter((f) => f.kind === "number")
  const kanbanOptions =
    widget.type === "kanban"
      ? ((fields.data ?? []).find((f) => f.id === widget.groupBy)?.config.options ?? [])
      : []

  const patch = onChange

  return (
    <div className="divide-y divide-border">
      <InspectorSection title="Size">
        <SizeControls node={widget} onChange={onChange} />
      </InspectorSection>

      <InspectorSection title="General">
        <FieldRow label="Type">
          <Select
            value={widget.type}
            onValueChange={(v) => onChangeType(v as DashboardWidget["type"])}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIDGET_CATALOG.map((m) => (
                <SelectItem key={m.type} value={m.type}>
                  <m.icon size={14} />
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow label="Title (optional)">
          <Input
            value={widget.title ?? ""}
            placeholder="Widget title…"
            onChange={(e) => patch({ title: e.target.value || null })}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Content">
        {/* Org-global widgets (members/welcome) have no concept to pick; tasks
          gets its own "Any record" select below (its conceptId is a filter);
          files picks per scope in its own section. */}
        {"conceptId" in widget && widget.type !== "tasks" && widget.type !== "files" && (
          <FieldRow label="Concept">
            <Select
              value={conceptId || "__none"}
              onValueChange={(v) => patch({ conceptId: v === "__none" ? null : v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a concept…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Select a concept…</SelectItem>
                <ConceptSelectItems concepts={concepts} />
              </SelectContent>
            </Select>
          </FieldRow>
        )}

        {widget.type === "metric" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Aggregate">
                <Select
                  value={widget.agg}
                  onValueChange={(v) => patch({ agg: v as "count" | "sum" | "avg" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">Count</SelectItem>
                    <SelectItem value="sum">Sum</SelectItem>
                    <SelectItem value="avg">Average</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              {widget.agg !== "count" && (
                <FieldRow label="Field">
                  <Select
                    value={widget.field || "__none"}
                    onValueChange={(v) => patch({ field: v === "__none" ? null : v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Number field…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">—</SelectItem>
                      {numberFields.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
              )}
            </div>
            <FieldRow label="Label (optional)">
              <Input
                value={widget.label ?? ""}
                placeholder="Auto from the aggregate"
                onChange={(e) => patch({ label: e.target.value || null })}
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "auto"}
                  onValueChange={(v) => patch({ variant: v as "auto" | "tile" | "bar" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (bar when wide)</SelectItem>
                    <SelectItem value="tile">Tile</SelectItem>
                    <SelectItem value="bar">Stat bar</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Number format">
                <Select
                  value={widget.format ?? "plain"}
                  onValueChange={(v) =>
                    patch({ format: v as "plain" | "compact" | "currency" | "percent" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plain">Plain</SelectItem>
                    <SelectItem value="compact">Compact (1.2K)</SelectItem>
                    <SelectItem value="currency">Currency</SelectItem>
                    <SelectItem value="percent">Percent</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Delta">
                <Select
                  value={widget.delta ?? "off"}
                  onValueChange={(v) => patch({ delta: v as "off" | "7d" | "30d" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="7d">vs 7 days ago</SelectItem>
                    <SelectItem value="30d">vs 30 days ago</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Data">
                <ToggleChip
                  pressed={widget.includeArchived ?? false}
                  onPressedChange={(p) => patch({ includeArchived: p })}
                >
                  Archived
                </ToggleChip>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "list" && (
          <>
            <FieldRow label="Columns (optional)">
              <MultiCombobox
                options={scalarFields.map((f) => ({ id: f.id, label: f.name }))}
                selectedIds={widget.columns ?? []}
                onChange={(ids) => patch({ columns: ids })}
                placeholder="All columns"
                searchPlaceholder="Search fields…"
                emptyText="No fields."
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Sort by (optional)">
                <Select
                  value={widget.orderBy || "__none"}
                  onValueChange={(v) => patch({ orderBy: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Default</SelectItem>
                    {groupableFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Max rows">
                <Input
                  type="number"
                  min={1}
                  value={widget.limit ?? ""}
                  onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                  className="w-28"
                />
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "auto"}
                  onValueChange={(v) => patch({ variant: v as "auto" | "table" | "cards" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (cards when narrow)</SelectItem>
                    <SelectItem value="table">Table</SelectItem>
                    <SelectItem value="cards">Cards</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Archived">
                <Select
                  value={widget.archived ?? "exclude"}
                  onValueChange={(v) => patch({ archived: v as "exclude" | "include" | "only" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exclude">Exclude</SelectItem>
                    <SelectItem value="include">Include</SelectItem>
                    <SelectItem value="only">Only archived</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "breakdown" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Group by">
                <Select
                  value={widget.groupBy || "__none"}
                  onValueChange={(v) => patch({ groupBy: v === "__none" ? "" : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Field or label…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">—</SelectItem>
                    <SelectItem value="__labels">Label</SelectItem>
                    {groupableFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Chart">
                <Select
                  value={widget.chart}
                  onValueChange={(v) => patch({ chart: v as "bar" | "pie" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bar">Bar</SelectItem>
                    <SelectItem value="pie">Pie</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Sort">
                <Select
                  value={widget.sort ?? "count"}
                  onValueChange={(v) => patch({ sort: v as "count" | "label" | "field" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">By count</SelectItem>
                    <SelectItem value="label">By label</SelectItem>
                    <SelectItem value="field">Field order</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Values">
                <Select
                  value={widget.values ?? "__off"}
                  onValueChange={(v) =>
                    patch({
                      values: v === "__off" ? undefined : (v as "count" | "percent" | "both"),
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__off">Off</SelectItem>
                    <SelectItem value="count">Count</SelectItem>
                    <SelectItem value="percent">Percent</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <FieldRow label="Collapse past n groups into “Other” (optional)">
              <Input
                type="number"
                min={1}
                placeholder="6"
                value={widget.maxGroups ?? ""}
                onChange={(e) =>
                  patch({ maxGroups: e.target.value ? Number(e.target.value) : null })
                }
                className="w-28"
              />
            </FieldRow>
          </>
        )}

        {widget.type === "attention" && (
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Decay/momentum field">
              <Select
                value={widget.computedField || "__auto"}
                onValueChange={(v) => patch({ computedField: v === "__auto" ? null : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Auto" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto">Auto (first decay)</SelectItem>
                  {computedFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Stale queue size">
              <Input
                type="number"
                min={1}
                value={widget.limit ?? ""}
                onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                className="w-28"
              />
            </FieldRow>
            <FieldRow label="Style">
              <Select
                value={widget.variant ?? "bands"}
                onValueChange={(v) => patch({ variant: v as "bands" | "strip" })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bands">Band badges</SelectItem>
                  <SelectItem value="strip">Heat strip</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Show">
              <ToggleChip
                pressed={widget.showDays ?? true}
                onPressedChange={(p) => patch({ showDays: p })}
              >
                Quiet duration
              </ToggleChip>
            </FieldRow>
          </div>
        )}

        {widget.type === "trend" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Bucket">
                <Select
                  value={widget.bucket}
                  onValueChange={(v) => patch({ bucket: v as "day" | "week" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Per day</SelectItem>
                    <SelectItem value="week">Per week</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Window">
                <Select
                  value={widget.since}
                  onValueChange={(v) => patch({ since: v as "7d" | "30d" | "90d" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                    <SelectItem value="30d">Last 30 days</SelectItem>
                    <SelectItem value="90d">Last 90 days</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Chart">
                <Select
                  value={widget.chart ?? "area"}
                  onValueChange={(v) => patch({ chart: v as "area" | "bars" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="area">Area</SelectItem>
                    <SelectItem value="bars">Bars</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Header">
                <ToggleChip
                  pressed={widget.showDelta ?? false}
                  onPressedChange={(p) => patch({ showDelta: p })}
                >
                  Delta vs prior
                </ToggleChip>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "activity" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Max items">
                <Input
                  type="number"
                  min={1}
                  value={widget.limit ?? ""}
                  onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                  className="w-28"
                />
              </FieldRow>
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "auto"}
                  onValueChange={(v) => patch({ variant: v as "auto" | "timeline" | "log" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (log when wide)</SelectItem>
                    <SelectItem value="timeline">Timeline</SelectItem>
                    <SelectItem value="log">Dense log</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <FieldRow label="Event types (optional)">
              <MultiCombobox
                options={KNOWN_EVENT_TYPES.map((t) => ({ id: t, label: humanizeType(t) }))}
                selectedIds={widget.eventTypes ?? []}
                onChange={(ids) => patch({ eventTypes: ids })}
                placeholder="All events"
                searchPlaceholder="Search event types…"
                emptyText="No event types."
              />
            </FieldRow>
            <FieldRow label="Show">
              <ToggleChip
                pressed={widget.showDiffs ?? true}
                onPressedChange={(p) => patch({ showDiffs: p })}
              >
                Field diffs
              </ToggleChip>
            </FieldRow>
          </>
        )}

        {widget.type === "tasks" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Default assignee">
                <Select
                  value={widget.assignee ?? "all"}
                  onValueChange={(v) => patch({ assignee: v as "all" | "me" | "none" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Everyone</SelectItem>
                    <SelectItem value="me">Me</SelectItem>
                    <SelectItem value="none">Unassigned</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "full"}
                  onValueChange={(v) => patch({ variant: v as "full" | "checklist" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full surface</SelectItem>
                    <SelectItem value="checklist">Checklist</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Group by">
                <Select
                  value={widget.groupBy ?? "schedule"}
                  onValueChange={(v) =>
                    patch({ groupBy: v as "schedule" | "status" | "priority" | "none" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="schedule">Schedule</SelectItem>
                    <SelectItem value="status">Status</SelectItem>
                    <SelectItem value="priority">Priority</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Due">
                <Select
                  value={widget.due ?? "any"}
                  onValueChange={(v) => patch({ due: v as "any" | "overdue" | "week" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any</SelectItem>
                    <SelectItem value="overdue">Overdue</SelectItem>
                    <SelectItem value="week">Next 7 days</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <FieldRow label="Concept (optional)">
              <Select
                value={widget.conceptId || "__any"}
                onValueChange={(v) => patch({ conceptId: v === "__any" ? null : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any">Any record</SelectItem>
                  <ConceptSelectItems concepts={concepts} />
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Statuses (optional)">
              <MultiCombobox
                options={taskStatuses.map((s) => ({ id: s.id, label: s.name }))}
                selectedIds={widget.statusIds ?? []}
                onChange={(ids) => patch({ statusIds: ids })}
                placeholder="All statuses"
                searchPlaceholder="Search statuses…"
                emptyText="No statuses."
              />
            </FieldRow>
            <FieldRow label="Show">
              <div className="flex flex-wrap gap-1.5">
                <ToggleChip
                  pressed={widget.showToolbar ?? true}
                  onPressedChange={(p) => patch({ showToolbar: p })}
                >
                  Toolbar
                </ToggleChip>
                <ToggleChip
                  pressed={widget.showComposer ?? true}
                  onPressedChange={(p) => patch({ showComposer: p })}
                >
                  Composer
                </ToggleChip>
                <ToggleChip
                  pressed={widget.showDone ?? false}
                  onPressedChange={(p) => patch({ showDone: p })}
                >
                  Completed
                </ToggleChip>
              </div>
            </FieldRow>
            <FieldRow label="Row metadata">
              <div className="flex flex-wrap gap-1.5">
                {ALL_TASK_META.map((m) => {
                  const current = widget.rowMeta ?? ALL_TASK_META
                  return (
                    <ToggleChip
                      key={m}
                      pressed={current.includes(m)}
                      onPressedChange={(p) =>
                        patch({ rowMeta: toggleIn(ALL_TASK_META, current, m, p) })
                      }
                    >
                      {capitalize(m)}
                    </ToggleChip>
                  )
                })}
              </div>
            </FieldRow>
          </>
        )}

        {widget.type === "members" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "rows"}
                  onValueChange={(v) => patch({ variant: v as "rows" | "grid" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rows">Directory rows</SelectItem>
                    <SelectItem value="grid">Avatar grid</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Sort">
                <Select
                  value={widget.sort ?? "name"}
                  onValueChange={(v) => patch({ sort: v as "name" | "role" | "joined" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="role">Role</SelectItem>
                    <SelectItem value="joined">Joined</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Max members (optional)">
                <Input
                  type="number"
                  min={1}
                  value={widget.limit ?? ""}
                  onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                  className="w-28"
                />
              </FieldRow>
              <FieldRow label="Show">
                <ToggleChip
                  pressed={widget.showToolbar ?? true}
                  onPressedChange={(p) => patch({ showToolbar: p })}
                >
                  Toolbar
                </ToggleChip>
              </FieldRow>
            </div>
            <FieldRow label="Row fields">
              <div className="flex flex-wrap gap-1.5">
                {ALL_MEMBER_FIELDS.map((f) => {
                  const current = widget.fields ?? ["role", "email"]
                  return (
                    <ToggleChip
                      key={f}
                      pressed={current.includes(f)}
                      onPressedChange={(p) =>
                        patch({ fields: toggleIn(ALL_MEMBER_FIELDS, current, f, p) })
                      }
                    >
                      {capitalize(f)}
                    </ToggleChip>
                  )
                })}
              </div>
            </FieldRow>
          </>
        )}

        {widget.type === "welcome" && (
          <>
            <p className="text-xs text-muted-foreground">The greeting rotates on every visit.</p>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "hero"}
                  onValueChange={(v) => patch({ variant: v as "hero" | "card" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hero">Hero banner</SelectItem>
                    <SelectItem value="card">Orientation card</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Show">
                <ToggleChip
                  pressed={widget.showPulse ?? false}
                  onPressedChange={(p) => patch({ showPulse: p })}
                >
                  Org pulse
                </ToggleChip>
              </FieldRow>
            </div>
            <FieldRow label="Quick links (optional)">
              <ShortcutItemsEditor
                items={widget.links ?? []}
                concepts={concepts}
                onChange={(links) => patch({ links })}
              />
            </FieldRow>
          </>
        )}

        {widget.type === "goal" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Aggregate">
                <Select
                  value={widget.agg}
                  onValueChange={(v) => patch({ agg: v as "count" | "sum" | "avg" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">Count</SelectItem>
                    <SelectItem value="sum">Sum</SelectItem>
                    <SelectItem value="avg">Average</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              {widget.agg !== "count" && (
                <FieldRow label="Field">
                  <Select
                    value={widget.field || "__none"}
                    onValueChange={(v) => patch({ field: v === "__none" ? null : v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Number field…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">—</SelectItem>
                      {numberFields.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Target">
                <Input
                  type="number"
                  value={widget.target ?? ""}
                  placeholder="e.g. 100"
                  onChange={(e) =>
                    patch({ target: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </FieldRow>
              <FieldRow label="Direction">
                <Select
                  value={widget.direction ?? "reach"}
                  onValueChange={(v) => patch({ direction: v as "reach" | "stay" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="reach">Reach at least</SelectItem>
                    <SelectItem value="stay">Stay under</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "bar"}
                  onValueChange={(v) => patch({ variant: v as "bar" | "ring" | "number" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bar">Progress bar</SelectItem>
                    <SelectItem value="ring">Ring</SelectItem>
                    <SelectItem value="number">Number</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Show">
                <ToggleChip
                  pressed={widget.showPercent ?? true}
                  onPressedChange={(p) => patch({ showPercent: p })}
                >
                  Percent
                </ToggleChip>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "shortcuts" && (
          <>
            <FieldRow label="Shortcuts">
              <ShortcutItemsEditor
                items={widget.items}
                concepts={concepts}
                onChange={(items) => patch({ items })}
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "list"}
                  onValueChange={(v) => patch({ variant: v as "list" | "grid" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">List</SelectItem>
                    <SelectItem value="grid">Icon grid</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="URL targets">
                <ToggleChip
                  pressed={widget.newTab ?? false}
                  onPressedChange={(p) => patch({ newTab: p })}
                >
                  New tab
                </ToggleChip>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "note" && (
          <>
            <FieldRow label="Content">
              <RichTextEditor
                value={widget.content}
                editable
                placeholder="Write the note…"
                onChange={(v) => patch({ content: v as unknown as RichTextEnvelope })}
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Appearance">
                <Select
                  value={widget.appearance ?? "plain"}
                  onValueChange={(v) =>
                    patch({ appearance: v as "plain" | "info" | "warn" | "success" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plain">Plain</SelectItem>
                    <SelectItem value="info">Info callout</SelectItem>
                    <SelectItem value="warn">Warning callout</SelectItem>
                    <SelectItem value="success">Success callout</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Overflow">
                <Select
                  value={widget.overflow ?? "clip"}
                  onValueChange={(v) => patch({ overflow: v as "clip" | "scroll" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="clip">Clip with fade</SelectItem>
                    <SelectItem value="scroll">Scroll</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "kanban" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Group by">
                <Select
                  value={widget.groupBy || "__none"}
                  // A new column field invalidates the visible-columns subset.
                  onValueChange={(v) => patch({ groupBy: v === "__none" ? "" : v, columns: [] })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Enum field…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">—</SelectItem>
                    {enumFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Card order">
                <Select
                  value={widget.orderBy || "__none"}
                  onValueChange={(v) => patch({ orderBy: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Default</SelectItem>
                    {groupableFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <FieldRow label="Card fields (optional)">
              <MultiCombobox
                options={scalarFields.map((f) => ({ id: f.id, label: f.name }))}
                selectedIds={widget.cardFields ?? []}
                onChange={(ids) => patch({ cardFields: ids })}
                placeholder="Name + first two"
                searchPlaceholder="Search fields…"
                emptyText="No fields."
              />
            </FieldRow>
            {kanbanOptions.length > 0 && (
              <FieldRow label="Columns (optional)">
                <MultiCombobox
                  options={kanbanOptions.map((v) => ({ id: v, label: capitalize(v) }))}
                  selectedIds={widget.columns ?? []}
                  onChange={(ids) => patch({ columns: ids })}
                  placeholder="All values"
                  searchPlaceholder="Search values…"
                  emptyText="No values."
                />
              </FieldRow>
            )}
            <FieldRow label="Board">
              <div className="flex flex-wrap gap-1.5">
                <ToggleChip
                  pressed={widget.dragToUpdate ?? true}
                  onPressedChange={(p) => patch({ dragToUpdate: p })}
                >
                  Drag to update
                </ToggleChip>
                <ToggleChip
                  pressed={widget.showEmptyColumns ?? true}
                  onPressedChange={(p) => patch({ showEmptyColumns: p })}
                >
                  Empty columns
                </ToggleChip>
                <ToggleChip
                  pressed={widget.includeArchived ?? false}
                  onPressedChange={(p) => patch({ includeArchived: p })}
                >
                  Archived
                </ToggleChip>
              </div>
            </FieldRow>
          </>
        )}

        {widget.type === "calendar" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Mode">
                <Select
                  value={widget.mode}
                  onValueChange={(v) => patch({ mode: v as "month" | "week" | "agenda" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month">Month</SelectItem>
                    <SelectItem value="week">Week</SelectItem>
                    <SelectItem value="agenda">Agenda</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              {widget.mode === "month" && (
                <FieldRow label="Density">
                  <Select
                    value={widget.density ?? "full"}
                    onValueChange={(v) => patch({ density: v as "full" | "dots" })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Event cells</SelectItem>
                      <SelectItem value="dots">Dots + count</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>
              )}
            </div>
            <FieldRow label="Overlay">
              <ToggleChip
                pressed={widget.includeTasks ?? false}
                onPressedChange={(p) => patch({ includeTasks: p })}
              >
                Org tasks (due date)
              </ToggleChip>
            </FieldRow>
            <FieldRow label="Sources">
              <CalendarSourcesEditor
                sources={widget.sources}
                concepts={concepts}
                labels={labels}
                onChange={(sources) => patch({ sources })}
              />
            </FieldRow>
          </>
        )}

        {widget.type === "gantt" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Start field">
                <Select
                  value={widget.startField || "__none"}
                  onValueChange={(v) => patch({ startField: v === "__none" ? "" : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Date field…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">—</SelectItem>
                    {dateFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="End field (optional)">
                <Select
                  value={widget.endField || "__none"}
                  onValueChange={(v) => patch({ endField: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Milestones" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">None (milestones)</SelectItem>
                    {dateFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Scale">
                <Select
                  value={widget.scale}
                  onValueChange={(v) => patch({ scale: v as "day" | "week" | "month" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Day</SelectItem>
                    <SelectItem value="week">Week</SelectItem>
                    <SelectItem value="month">Month</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Window">
                <Select
                  value={widget.window ?? "fit"}
                  onValueChange={(v) => patch({ window: v as "fit" | "90d" | "quarter" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fit">Fit the data</SelectItem>
                    <SelectItem value="90d">Rolling 90 days</SelectItem>
                    <SelectItem value="quarter">This quarter</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Group by (optional)">
                <Select
                  value={widget.groupBy || "__none"}
                  onValueChange={(v) => patch({ groupBy: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Flat" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Flat</SelectItem>
                    {laneFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Bar label">
                <Select
                  value={widget.barLabelField || "__name"}
                  onValueChange={(v) => patch({ barLabelField: v === "__name" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__name">Name</SelectItem>
                    {scalarFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Progress (optional)">
                <Select
                  value={widget.progressField || "__none"}
                  onValueChange={(v) => patch({ progressField: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Off" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Off</SelectItem>
                    {plainNumberFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name} (0–100)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Show">
                <ToggleChip
                  pressed={widget.showTodayLine ?? true}
                  onPressedChange={(p) => patch({ showTodayLine: p })}
                >
                  Today line
                </ToggleChip>
              </FieldRow>
            </div>
          </>
        )}

        {widget.type === "files" && (
          <>
            <FieldRow label="Scope">
              <Select
                value={widget.scope}
                onValueChange={(v) => {
                  const scope = v as "instance" | "concept" | "org"
                  // Clear the other scope's key so a stale ref can't linger; give
                  // instance scope a usable default (the drop-zone on).
                  if (scope === "concept") patch({ scope, instanceId: null })
                  else if (scope === "instance")
                    patch({ scope, conceptId: null, allowUpload: widget.allowUpload ?? true })
                  else patch({ scope, conceptId: null, instanceId: null })
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instance">One record</SelectItem>
                  <SelectItem value="concept">A concept (recent uploads)</SelectItem>
                  <SelectItem value="org">Whole org</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            {widget.scope === "concept" && (
              <FieldRow label="Concept">
                <Select
                  value={conceptId || "__none"}
                  onValueChange={(v) => patch({ conceptId: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a concept…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Select a concept…</SelectItem>
                    <ConceptSelectItems concepts={concepts} />
                  </SelectContent>
                </Select>
              </FieldRow>
            )}
            {widget.scope === "instance" && (
              <FieldRow label="Record">
                <FilesInstancePicker
                  instanceId={widget.instanceId ?? null}
                  concepts={concepts}
                  onPick={(instanceId) => patch({ instanceId })}
                />
              </FieldRow>
            )}
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Style">
                <Select
                  value={widget.variant ?? "list"}
                  onValueChange={(v) => patch({ variant: v as "gallery" | "list" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">List rows</SelectItem>
                    <SelectItem value="gallery">Gallery (thumbnails)</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Sort">
                <Select
                  value={widget.sort ?? "newest"}
                  onValueChange={(v) => patch({ sort: v as "newest" | "name" | "size" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest</SelectItem>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="size">Size</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="File type">
                <Select
                  value={widget.fileType ?? "all"}
                  onValueChange={(v) =>
                    patch({ fileType: v as "all" | "image" | "doc" | "pdf" | "other" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="image">Images</SelectItem>
                    <SelectItem value="doc">Documents</SelectItem>
                    <SelectItem value="pdf">PDFs</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Max files (optional)">
                <Input
                  type="number"
                  min={1}
                  value={widget.limit ?? ""}
                  onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                  className="w-28"
                />
              </FieldRow>
            </div>
            {widget.scope === "instance" && (
              <FieldRow label="Show">
                <ToggleChip
                  pressed={widget.allowUpload ?? false}
                  onPressedChange={(p) => patch({ allowUpload: p })}
                >
                  Upload drop-zone
                </ToggleChip>
              </FieldRow>
            )}
          </>
        )}

        {conceptId && CONDITION_TYPES.has(widget.type) && (
          <FieldRow label="Filter">
            <ConditionList
              conceptId={conceptId}
              conditions={("conditions" in widget ? widget.conditions : undefined) ?? []}
              labels={labels}
              onChange={(conditions) => patch({ conditions })}
              match={("match" in widget ? widget.match : undefined) ?? "all"}
              onMatchChange={(match) => patch({ match })}
            />
          </FieldRow>
        )}
      </InspectorSection>
    </div>
  )
}

/** The picked record's display label: instance → its item lineage → the
 *  server-resolved subject ref (instance state keys by field id, so the client
 *  can't label it alone). A gone record degrades to an honest note. */
function PickedInstanceLabel({ instanceId }: { instanceId: string }) {
  const detail = useQuery({
    queryKey: ["instanceItem", instanceId],
    queryFn: () => api.getInstance(instanceId),
    retry: false,
  })
  const itemId = detail.data?.instance.itemId
  const ref = useQuery({
    queryKey: ["subjectRef", itemId],
    queryFn: () => api.resolveTaskSubjects(itemId ? [itemId] : []),
    enabled: !!itemId,
  })
  if (detail.error)
    return <span className="text-muted-foreground">Record unavailable — pick another.</span>
  return <span className="truncate">{ref.data?.[0]?.label ?? "…"}</span>
}

/** Concept + search → one instance ref (the Shortcuts picker pattern), with the
 *  current pick shown as a clearable row. */
function FilesInstancePicker({
  instanceId,
  concepts,
  onPick,
}: {
  instanceId: string | null
  concepts: readonly Concept[]
  onPick: (instanceId: string | null) => void
}) {
  const [searchConceptId, setSearchConceptId] = useState("")
  const [query, setQuery] = useState("")
  const results = useQuery({
    queryKey: ["search", searchConceptId, query],
    queryFn: () => api.searchInstances(searchConceptId, query),
    enabled: !!searchConceptId,
  })

  if (instanceId)
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">
          <PickedInstanceLabel instanceId={instanceId} />
        </span>
        <IconButton aria-label="Clear record" onClick={() => onPick(null)}>
          <X size={14} />
        </IconButton>
      </div>
    )

  return (
    <div className="space-y-2">
      <Select
        value={searchConceptId || "__none"}
        onValueChange={(v) => setSearchConceptId(v === "__none" ? "" : v)}
      >
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder="Concept…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">Concept…</SelectItem>
          <ConceptSelectItems concepts={concepts} />
        </SelectContent>
      </Select>
      {searchConceptId && (
        <>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" />
          <div className="max-h-36 space-y-0.5 overflow-y-auto">
            {(results.data ?? []).map((r) => (
              <button
                key={r.itemId}
                type="button"
                onClick={() => onPick(r.instanceId)}
                className="flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-accent"
              >
                {r.label}
              </button>
            ))}
            {results.data?.length === 0 && (
              <p className="px-2 py-1 text-sm text-muted-foreground">No items match.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
