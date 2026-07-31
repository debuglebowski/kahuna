import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useMemo, useState } from "react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { humanizeEventType, KNOWN_EVENT_TYPES } from "@/lib/activity"
import {
  type AnalyticsMetric,
  type AnalyticsProvider,
  METRICS_BY_PROVIDER,
  PROVIDERS,
  QUERY_LANGUAGE,
  QUERY_PLACEHOLDER,
} from "@/lib/analyticsProviders"
import { api, type Concept, type DashboardWidget, type RichTextEnvelope } from "@/lib/api"
import { taskStatusesCollection } from "@/lib/collections"
import { type Dim, type DimUnit, type NormWidget, TILE_PAD } from "@/lib/dashboards"
import { capitalize } from "@/lib/fieldDisplay"
import { resolveVariantId } from "@/lib/variantCatalog"
import { WIDGET_CATALOG, WIDGET_CATEGORIES } from "@/lib/widgetCatalog"
import { ConceptSelectItems } from "../ConceptSelectItems"
import { ConditionList, useFields } from "../ConditionList"
import { RichTextEditor } from "../editor/RichTextEditor"
import { MultiCombobox } from "../MultiCombobox"
import { Field as FieldRow, HintList, IconButton, Input, ToggleChip } from "../ui"
import { CalendarSourcesEditor } from "./CalendarSourcesEditor"
import { InspectorSection } from "./InspectorSection"
import { ShortcutItemsEditor } from "./ShortcutItemsEditor"
import { VariantPicker } from "./VariantPicker"

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
  recordMode = false,
  recordConceptId = null,
}: {
  widget: NormWidget
  concepts: readonly Concept[]
  onChange: (patch: Partial<NormWidget>) => void
  onChangeType: (type: DashboardWidget["type"]) => void
  /** Record dashboard: offer relation-scoping + auto-bind Document/Files. */
  recordMode?: boolean
  recordConceptId?: string | null
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
  // Record dashboards: relation-scope a concept-scoped widget to the current
  // record's related instances. The owning concept's relation fields are the
  // options; picking one sets conceptId = the relation's target.
  const RELATION_SCOPABLE = new Set(["metric", "list", "breakdown", "kanban"])
  const relationScopable = recordMode && !!recordConceptId && RELATION_SCOPABLE.has(widget.type)
  // The owning concept's fields (record mode) — drives both the relation-source
  // picker and the Document widget's field picker (the record is implicit).
  const recordFields = useFields(recordMode && recordConceptId ? recordConceptId : "")
  const recordRelationFields = (recordFields.data ?? []).filter(
    (f) => f.kind === "relation" && !!f.config.target,
  )
  const recordRichTextFields = (recordFields.data ?? []).filter((f) => f.kind === "richtext")
  // List/Kanban can open their rows with a specific record view of the rows' concept
  // (else the concept's default). Drives the dashboards-list "usage" grouping.
  const opensRecords = widget.type === "list" || widget.type === "kanban"
  const recordViewsQ = useQuery({
    queryKey: ["recordDashboards", conceptId],
    queryFn: () => api.listRecordDashboards(conceptId),
    enabled: opensRecords && !!conceptId,
  })
  const recordViews = recordViewsQ.data ?? []
  const recordDashboardId =
    "recordDashboardId" in widget
      ? ((widget as { recordDashboardId?: string | null }).recordDashboardId ?? null)
      : null
  const relationFieldId =
    "relationFieldId" in widget
      ? ((widget as { relationFieldId?: string | null }).relationFieldId ?? null)
      : null
  const scalarFields = (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file")
  // Rich text shows fine as a list column (text preview) but grouping/sorting
  // on a { doc, text } envelope is meaningless.
  const groupableFields = scalarFields.filter((f) => f.kind !== "richtext")
  const richTextFields = (fields.data ?? []).filter((f) => f.kind === "richtext")
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
              {WIDGET_CATEGORIES.map((cat) => {
                const inCat = WIDGET_CATALOG.filter(
                  (m) =>
                    m.category === cat &&
                    (!m.kinds || m.kinds.includes(recordMode ? "record" : "page")),
                )
                if (inCat.length === 0) return null
                return (
                  <SelectGroup key={cat} className="mt-2 first:mt-0">
                    <SelectLabel>{cat}</SelectLabel>
                    {inCat.map((m) => (
                      <SelectItem key={m.type} value={m.type}>
                        <m.icon size={14} />
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )
              })}
            </SelectContent>
          </Select>
        </FieldRow>

        <VariantPicker widget={widget} onChange={patch} />

        <FieldRow label="Title (optional)">
          <Input
            value={widget.title ?? ""}
            placeholder="Widget title…"
            onChange={(e) => patch({ title: e.target.value || null })}
          />
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Size">
        <SizeControls node={widget} onChange={onChange} />
      </InspectorSection>

      <InspectorSection title="Style">
        <FieldRow
          label="Padding"
          hint="Space between the tile's edge and its content, in px. Blank = the default; 0 goes full bleed — content runs to the edge and the tile drops its border and background."
        >
          <div className="flex items-center gap-2">
            <NumberField
              className="w-20"
              ariaLabel="Tile padding"
              placeholder={String(TILE_PAD)}
              value={widget.padding != null ? String(widget.padding) : ""}
              onCommit={(raw) => patch({ padding: raw.trim() === "" ? undefined : parseNum(raw) })}
            />
            <span className="text-xs text-muted-foreground">px</span>
          </div>
        </FieldRow>
      </InspectorSection>

      <InspectorSection title="Content">
        {/* Record dashboards: scope a concept-scoped widget to the whole concept,
          or to THIS record's related instances via one of its relations. */}
        {relationScopable && (
          <FieldRow label="Source">
            <Select
              value={relationFieldId ?? "__concept"}
              onValueChange={(v) => {
                if (v === "__concept") {
                  patch({ relationFieldId: null } as Partial<NormWidget>)
                } else {
                  const target = recordRelationFields.find((f) => f.id === v)?.config.target ?? null
                  patch({ relationFieldId: v, conceptId: target } as Partial<NormWidget>)
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__concept">Whole concept</SelectItem>
                {recordRelationFields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    Related: {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        )}

        {/* Org-global widgets (members/welcome) have no concept to pick; tasks
          gets its own "Any record" select below (its conceptId is a filter);
          files/document pick a record in their own section. When a record-relation
          source is active the relation already fixes the concept (hidden). */}
        {"conceptId" in widget &&
          widget.type !== "tasks" &&
          widget.type !== "files" &&
          widget.type !== "document" &&
          !(relationScopable && relationFieldId) && (
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

        {/* Which record view a row opens with — also nests this dashboard's view
          beneath it in the dashboards-list "usage" grouping. */}
        {opensRecords && conceptId && (
          <FieldRow label="Open rows with">
            <Select
              value={recordDashboardId ?? "__default"}
              onValueChange={(v) =>
                patch({ recordDashboardId: v === "__default" ? null : v } as Partial<NormWidget>)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">Default record view</SelectItem>
                {recordViews.map((rv) => (
                  <SelectItem key={rv.id} value={rv.id}>
                    {rv.name || "(untitled view)"}
                  </SelectItem>
                ))}
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
            {/* The grouped/rows variants section/color by an enum field; absent =
              the concept's first enum. Shown only when that variant is active. */}
            {resolveVariantId(widget) === "grouped" && (
              <FieldRow label="Group by">
                <Select
                  value={widget.groupBy || "__none"}
                  onValueChange={(v) => patch({ groupBy: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a field…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Select a field…</SelectItem>
                    {enumFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            )}
            {resolveVariantId(widget) === "rows" && (
              <FieldRow label="Status dot">
                <Select
                  value={widget.statusField || "__auto"}
                  onValueChange={(v) => patch({ statusField: v === "__auto" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto">First enum field</SelectItem>
                    {enumFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            )}
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
                  onValueChange={(v) =>
                    patch({
                      chart: v as "bar" | "pie" | "bars-h" | "donut" | "stacked" | "table",
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bar">Bars (vertical)</SelectItem>
                    <SelectItem value="bars-h">Bars (ranked)</SelectItem>
                    <SelectItem value="pie">Pie</SelectItem>
                    <SelectItem value="donut">Donut</SelectItem>
                    <SelectItem value="stacked">Composition bar</SelectItem>
                    <SelectItem value="table">Table</SelectItem>
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
            {widget.chart === "table" && (
              <FieldRow label="Trend column (table only)">
                <Select
                  value={widget.delta ?? "off"}
                  onValueChange={(v) => patch({ delta: v as "off" | "7d" | "30d" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                    <SelectItem value="30d">Last 30 days</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            )}
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

        {widget.type === "analytics" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Provider">
                <Select
                  value={widget.provider}
                  onValueChange={(v) => patch({ provider: v as AnalyticsProvider })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              {/* Metrics come FROM the provider, so a second provider brings its
                  own list (including its own custom-query flavor). */}
              <FieldRow label="Metric">
                <Select
                  value={widget.metric}
                  onValueChange={(v) => patch({ metric: v as AnalyticsMetric })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(METRICS_BY_PROVIDER[widget.provider] ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
            {/* A custom query buckets, filters and splits itself, so the
                structured knobs it subsumes (per/event/breakdown) hide. */}
            {widget.metric === "custom" && (
              <FieldRow label={`${QUERY_LANGUAGE[widget.provider]} query`}>
                <Textarea
                  value={widget.query ?? ""}
                  onChange={(e) => patch({ query: e.target.value || null })}
                  placeholder={QUERY_PLACEHOLDER[widget.provider]}
                  spellCheck={false}
                  className="min-h-[9rem] font-mono text-xs"
                />
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Return columns aliased <code>bucket</code>, <code>value</code>, and optionally{" "}
                  <code>series</code> (one line per value). <code>{"{from}"}</code> and{" "}
                  <code>{"{to}"}</code> are bound to the window below
                  {recordMode && (
                    <>
                      , <code>{"{recordValue}"}</code> to the matched record field
                    </>
                  )}
                  . Results are capped at 2000 rows.
                </p>
              </FieldRow>
            )}
            <div className="grid grid-cols-2 gap-3">
              {widget.metric !== "custom" && (
                <FieldRow label="Per">
                  <Select
                    value={widget.interval}
                    onValueChange={(v) => patch({ interval: v as "day" | "week" | "month" })}
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
              )}
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
                  onValueChange={(v) => patch({ chart: v as "area" | "bars" | "table" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="area">Area</SelectItem>
                    <SelectItem value="bars">Bars</SelectItem>
                    <SelectItem value="table">Table</SelectItem>
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
            {widget.metric !== "custom" && (
              <>
                <FieldRow label="Event (optional)">
                  <Input
                    value={widget.event ?? ""}
                    onChange={(e) => patch({ event: e.target.value || null })}
                    placeholder="All events (e.g. $pageview)"
                  />
                </FieldRow>
                <FieldRow label="Break down by (optional)">
                  <Input
                    value={widget.breakdown ?? ""}
                    onChange={(e) => patch({ breakdown: e.target.value || null })}
                    placeholder="PostHog property (e.g. plan)"
                  />
                </FieldRow>
              </>
            )}
            {/* Record dashboards: narrow the same query to THIS record by matching
                one of its field values against a provider property. A custom
                query writes its own WHERE, so it only needs the field — the value
                arrives as the `{recordValue}` param. */}
            {recordMode && (
              <div className="grid grid-cols-2 gap-3">
                <FieldRow
                  label={
                    widget.metric === "custom" ? "Bind {recordValue} to" : "Match record field"
                  }
                >
                  <Select
                    value={widget.recordFilter?.fieldId ?? "__none"}
                    onValueChange={(v) =>
                      patch({
                        recordFilter:
                          v === "__none"
                            ? null
                            : {
                                fieldId: v,
                                property: widget.recordFilter?.property ?? "email",
                              },
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Whole workspace</SelectItem>
                      {(recordFields.data ?? [])
                        .filter((f) => f.kind === "text" || f.kind === "user")
                        .map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
                {widget.metric !== "custom" && (
                  <FieldRow label="…against property">
                    <Input
                      value={widget.recordFilter?.property ?? ""}
                      disabled={!widget.recordFilter}
                      onChange={(e) =>
                        widget.recordFilter &&
                        patch({
                          recordFilter: { ...widget.recordFilter, property: e.target.value },
                        })
                      }
                      placeholder="email"
                    />
                  </FieldRow>
                )}
              </div>
            )}
          </>
        )}

        {widget.type === "activity" && (
          <>
            <FieldRow label="Max items">
              <Input
                type="number"
                min={1}
                value={widget.limit ?? ""}
                onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                className="w-28"
              />
            </FieldRow>
            <FieldRow label="Event types (optional)">
              <MultiCombobox
                options={KNOWN_EVENT_TYPES.map((t) => ({ id: t, label: humanizeEventType(t) }))}
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
            <FieldRow label="Show">
              <ToggleChip
                pressed={widget.showPulse ?? false}
                onPressedChange={(p) => patch({ showPulse: p })}
              >
                Org pulse
              </ToggleChip>
            </FieldRow>
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
            <FieldRow label="Show">
              <ToggleChip
                pressed={widget.showPercent ?? true}
                onPressedChange={(p) => patch({ showPercent: p })}
              >
                Percent
              </ToggleChip>
            </FieldRow>
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
            <FieldRow label="URL targets">
              <ToggleChip
                pressed={widget.newTab ?? false}
                onPressedChange={(p) => patch({ newTab: p })}
              >
                New tab
              </ToggleChip>
            </FieldRow>
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

        {widget.type === "document" &&
          (widget.bindToConceptRecord ? (
            // Bound: the concept picks itself out one record; the field list is that
            // concept's, read through the same `conceptId` the binding uses.
            <>
              <ConceptRecordBinding
                conceptId={conceptId}
                concepts={concepts}
                onChange={patch}
                what="document"
              />
              {conceptId && (
                <FieldRow label="Rich text field">
                  <Select
                    value={widget.fieldId || "__none"}
                    onValueChange={(v) => patch({ fieldId: v === "__none" ? null : v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a field…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Select a field…</SelectItem>
                      {richTextFields.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {richTextFields.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This concept has no rich text fields.
                    </p>
                  )}
                </FieldRow>
              )}
            </>
          ) : recordMode ? (
            // The record is the one being viewed — only the field is chosen,
            // from the owning concept's rich text fields.
            <>
              <FieldRow label="Rich text field" hint="Edited for whichever record is open.">
                <Select
                  value={widget.fieldId || "__none"}
                  onValueChange={(v) =>
                    patch({ fieldId: v === "__none" ? null : v, conceptId: recordConceptId })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a field…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Select a field…</SelectItem>
                    {recordRichTextFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {recordRichTextFields.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    This concept has no rich text fields.
                  </p>
                )}
              </FieldRow>
              <BindToConceptRecordButton concepts={concepts} onChange={patch} />
            </>
          ) : (
            <>
              <FieldRow label="Record">
                <FilesInstancePicker
                  instanceId={widget.instanceId ?? null}
                  concepts={concepts}
                  onPick={(instanceId, pickedConceptId) =>
                    // A new record carries its concept (the field scope) and clears
                    // the field; clearing the record clears both.
                    patch({
                      instanceId,
                      conceptId: instanceId ? (pickedConceptId ?? null) : null,
                      fieldId: null,
                    })
                  }
                />
              </FieldRow>
              {widget.instanceId ? (
                <FieldRow label="Rich text field">
                  <Select
                    value={widget.fieldId || "__none"}
                    onValueChange={(v) => patch({ fieldId: v === "__none" ? null : v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a field…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Select a field…</SelectItem>
                      {richTextFields.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {richTextFields.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This record’s concept has no rich text fields.
                    </p>
                  )}
                </FieldRow>
              ) : (
                <BindToConceptRecordButton concepts={concepts} onChange={patch} />
              )}
            </>
          ))}

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
            <FieldRow
              label="Scope"
              hint={
                <HintList
                  lead="Which files this widget lists."
                  items={[
                    {
                      term: "This widget",
                      desc: "Files that belong to the widget itself — upload straight in, no record needed.",
                    },
                    {
                      term: "One record",
                      desc: "Files attached to a single record. You can upload into it too.",
                    },
                    {
                      term: "A concept",
                      desc: "The most recent files across all records of that concept. Browse only.",
                    },
                    { term: "Whole org", desc: "Every file in the workspace. Browse only." },
                  ]}
                />
              }
            >
              <Select
                value={widget.scope}
                onValueChange={(v) => {
                  const scope = v as "instance" | "concept" | "org" | "widget"
                  // Clear the other scopes' keys so a stale ref can't linger; the
                  // two uploadable scopes default the drop-zone on.
                  // `bindToConceptRecord` is instance-scope only — every other scope
                  // clears it, or the flag would silently outlive its meaning.
                  if (scope === "concept")
                    patch({ scope, instanceId: null, bindToConceptRecord: false })
                  else if (scope === "instance")
                    patch({ scope, conceptId: null, allowUpload: widget.allowUpload ?? true })
                  else if (scope === "widget")
                    patch({
                      scope,
                      conceptId: null,
                      instanceId: null,
                      bindToConceptRecord: false,
                      // One bucket per widget, minted once and kept for its life —
                      // reusing the widget id would make two dashboards share files.
                      bucketId: widget.bucketId ?? crypto.randomUUID(),
                      allowUpload: widget.allowUpload ?? true,
                    })
                  else
                    patch({ scope, conceptId: null, instanceId: null, bindToConceptRecord: false })
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="widget">This widget (its own files)</SelectItem>
                  <SelectItem value="instance">One record</SelectItem>
                  <SelectItem value="concept">A concept (recent uploads)</SelectItem>
                  <SelectItem value="org">Whole org</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
            {widget.scope === "widget" && (
              <FieldRow
                label="Also list elsewhere"
                hint={
                  <HintList
                    lead="Whether a “Whole org” Files widget shows these files."
                    items={[
                      {
                        term: "On",
                        desc: "They appear in org-wide file lists, like files on a record do.",
                      },
                      {
                        term: "Off",
                        desc: "Only this widget lists them. Anyone with a file's link can still open it — this hides files from other lists, it doesn't lock them.",
                      },
                    ]}
                  />
                }
              >
                <ToggleChip
                  pressed={widget.bucketShared !== false}
                  onPressedChange={(p) => patch({ bucketShared: p })}
                >
                  Visible to org-wide widgets
                </ToggleChip>
              </FieldRow>
            )}
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
            {widget.scope === "instance" &&
              (widget.bindToConceptRecord ? (
                <ConceptRecordBinding
                  conceptId={conceptId}
                  concepts={concepts}
                  onChange={patch}
                  what="files"
                />
              ) : recordMode ? (
                <>
                  <p className="px-1 text-xs text-muted-foreground">
                    Shows files for whichever record is open.
                  </p>
                  <BindToConceptRecordButton concepts={concepts} onChange={patch} />
                </>
              ) : (
                <>
                  <FieldRow label="Record">
                    <FilesInstancePicker
                      instanceId={widget.instanceId ?? null}
                      concepts={concepts}
                      onPick={(instanceId) => patch({ instanceId })}
                    />
                  </FieldRow>
                  {!widget.instanceId && (
                    <BindToConceptRecordButton concepts={concepts} onChange={patch} />
                  )}
                </>
              ))}
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
                  className="w-full"
                />
              </FieldRow>
            </div>
            {(widget.scope === "instance" || widget.scope === "widget") && (
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

/** The single-record concepts a widget can bind to — the only ones with a record
 *  that's resolvable from a concept id alone. */
const bindableConcepts = (concepts: readonly Concept[]) =>
  concepts.filter((c) => c.singleRecord && !c.archivedAt)

/** Opt into `bindToConceptRecord`, offered beside the explicit record picker.
 *  Hidden entirely when the org has no single-record concept — there'd be nothing
 *  to bind to, and the flag is meaningless without one. */
function BindToConceptRecordButton({
  concepts,
  onChange,
}: {
  concepts: readonly Concept[]
  onChange: (patch: Partial<NormWidget>) => void
}) {
  const bindable = bindableConcepts(concepts)
  if (bindable.length === 0) return null
  return (
    <ToggleChip
      pressed={false}
      onPressedChange={() =>
        onChange({
          bindToConceptRecord: true,
          instanceId: null,
          conceptId: bindable.length === 1 ? bindable[0]!.id : null,
        } as Partial<NormWidget>)
      }
    >
      Use a single-record concept’s record
    </ToggleChip>
  )
}

/** The bound state: pick WHICH single-record concept, or drop back to an explicit
 *  record. The record itself isn't chosen — the concept has exactly one. */
function ConceptRecordBinding({
  conceptId,
  concepts,
  onChange,
  what,
}: {
  conceptId: string
  concepts: readonly Concept[]
  onChange: (patch: Partial<NormWidget>) => void
  /** What the bound record supplies, for the hint copy. */
  what: "files" | "document"
}) {
  const bindable = bindableConcepts(concepts)
  return (
    <>
      <FieldRow
        label="Record"
        hint={
          what === "files"
            ? "Shows the files of a single-record concept's one record. Follows that record wherever it goes — including a new version, which an explicit record wouldn't."
            : "Edits the field on a single-record concept's one record. Follows that record across versions, which an explicit record wouldn't."
        }
      >
        <Select
          value={conceptId || "__none"}
          onValueChange={(v) =>
            // Switching the bound concept invalidates a Document field pick (the
            // field belongs to the old concept); Files has no field to clear.
            onChange({
              conceptId: v === "__none" ? null : v,
              ...(what === "document" ? { fieldId: null } : {}),
            } as Partial<NormWidget>)
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Single-record concept…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">Single-record concept…</SelectItem>
            <ConceptSelectItems concepts={bindable} label={(c) => c.name} />
          </SelectContent>
        </Select>
      </FieldRow>
      {bindable.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          No concept is in single-record mode yet — turn it on in the concept’s settings.
        </p>
      )}
      <ToggleChip
        pressed
        onPressedChange={() =>
          onChange({
            bindToConceptRecord: false,
            conceptId: null,
            ...(what === "document" ? { fieldId: null } : {}),
          } as Partial<NormWidget>)
        }
      >
        Bound to a single-record concept
      </ToggleChip>
    </>
  )
}

/** Concept + search → one instance ref (the Shortcuts picker pattern), with the
 *  current pick shown as a clearable row. `onPick` also reports the search
 *  concept so callers that store it (the Document widget) can scope a field
 *  picker; callers that don't (Files) just ignore it. */
function FilesInstancePicker({
  instanceId,
  concepts,
  onPick,
}: {
  instanceId: string | null
  concepts: readonly Concept[]
  onPick: (instanceId: string | null, conceptId: string | null) => void
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
        <IconButton aria-label="Clear record" onClick={() => onPick(null, null)}>
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
                onClick={() => onPick(r.instanceId, searchConceptId)}
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
