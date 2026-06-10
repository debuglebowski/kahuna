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
import {
  api,
  type Concept,
  type DashboardWidget,
  type Field,
  type Label,
  type SidebarCondition,
} from "@/lib/api"
import { MultiCombobox } from "../MultiCombobox"
import { Button, Field as FieldRow, IconButton, Input, Modal } from "../ui"

/** Edit one dashboard widget (metric or list). Type is fixed at add-time. The
 *  filter/condition model + `coerce` mirror the sidebar `SectionEditor`. */

const useFields = (conceptId: string) =>
  useQuery({
    queryKey: ["fields", conceptId],
    queryFn: () => api.listFields(conceptId),
    enabled: !!conceptId,
  })

/** Coerce a free-text equality value to match the field's stored JSON type. */
const coerce = (raw: string, field: Field | undefined): unknown => {
  if (field?.kind === "number" || field?.kind === "money") return Number(raw)
  if (field?.kind === "bool") return raw === "true"
  return raw
}

/** One condition: a label (has-label) or a field (equals). */
function ConditionList({
  conceptId,
  conditions,
  labels,
  onChange,
}: {
  conceptId: string
  conditions: readonly SidebarCondition[]
  labels: readonly Label[]
  onChange: (next: SidebarCondition[]) => void
}) {
  const fields = useFields(conceptId)
  const liveFields = useMemo(
    () => (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file"),
    [fields.data],
  )
  const set = (i: number, c: SidebarCondition) =>
    onChange(conditions.map((x, j) => (j === i ? c : x)))
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i))

  return (
    <div className="space-y-1.5">
      {conditions.map((cond, i) => {
        const field = liveFields.find((f) => f.id === cond.field)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={cond.op === "hasLabel" ? "__label" : cond.field}
              onValueChange={(v) =>
                set(
                  i,
                  v === "__label"
                    ? { field: "__labels", op: "hasLabel", value: labels[0]?.id ?? "" }
                    : { field: v, op: "eq", value: "" },
                )
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__label">Has label</SelectItem>
                {liveFields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name} =
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {cond.op === "hasLabel" ? (
              <Select
                value={String(cond.value)}
                onValueChange={(v) => set(i, { ...cond, value: v })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {labels.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field?.kind === "enum" ? (
              <Select
                value={cond.value ? String(cond.value) : "__none"}
                onValueChange={(v) => set(i, { ...cond, value: v === "__none" ? "" : v })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">—</SelectItem>
                  {(field.config.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={String(cond.value ?? "")}
                placeholder="value"
                onChange={(e) => set(i, { ...cond, value: coerce(e.target.value, field) })}
                className="flex-1"
              />
            )}
            <IconButton aria-label="Remove condition" onClick={() => remove(i)}>
              <X size={14} />
            </IconButton>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...conditions,
            { field: "__labels", op: "hasLabel", value: labels[0]?.id ?? "" },
          ])
        }
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        + Condition
      </button>
    </div>
  )
}

export function WidgetEditor({
  widget,
  concepts,
  onSave,
  onClose,
}: {
  widget: DashboardWidget
  concepts: readonly Concept[]
  onSave: (widget: DashboardWidget) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<DashboardWidget>(widget)
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const labels = labelsQ.data ?? []
  const conceptId = "conceptId" in draft ? (draft.conceptId ?? "") : ""
  const fields = useFields(conceptId)
  const scalarFields = (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file")
  const numberFields = (fields.data ?? []).filter((f) => f.kind === "number" || f.kind === "money")
  const computedFields = (fields.data ?? []).filter((f) => f.kind === "computed")

  const patch = (p: Partial<DashboardWidget>) =>
    setDraft((d) => ({ ...d, ...p }) as DashboardWidget)

  return (
    <Modal title={`Edit ${draft.type} widget`} onClose={onClose}>
      <div className="space-y-4">
        <FieldRow label="Title (optional)">
          <Input
            value={draft.title ?? ""}
            placeholder="Widget title…"
            onChange={(e) => patch({ title: e.target.value || null })}
          />
        </FieldRow>

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
              {concepts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.pluralName || c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        {draft.type === "metric" && (
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Aggregate">
              <Select
                value={draft.agg}
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
            {draft.agg !== "count" && (
              <FieldRow label="Field">
                <Select
                  value={draft.field || "__none"}
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
        )}

        {draft.type === "list" && (
          <>
            <FieldRow label="Columns (optional)">
              <MultiCombobox
                options={scalarFields.map((f) => ({ id: f.id, label: f.name }))}
                selectedIds={draft.columns ?? []}
                onChange={(ids) => patch({ columns: ids })}
                placeholder="All columns"
                searchPlaceholder="Search fields…"
                emptyText="No fields."
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Sort by (optional)">
                <Select
                  value={draft.orderBy || "__none"}
                  onValueChange={(v) => patch({ orderBy: v === "__none" ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Default</SelectItem>
                    {scalarFields.map((f) => (
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
                  value={draft.limit ?? ""}
                  onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                  className="w-28"
                />
              </FieldRow>
            </div>
          </>
        )}

        {draft.type === "breakdown" && (
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Group by">
              <Select
                value={draft.groupBy || "__none"}
                onValueChange={(v) => patch({ groupBy: v === "__none" ? "" : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Field or label…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">—</SelectItem>
                  <SelectItem value="__labels">Label</SelectItem>
                  {scalarFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Chart">
              <Select
                value={draft.chart}
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
        )}

        {draft.type === "attention" && (
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Decay/momentum field">
              <Select
                value={draft.computedField || "__auto"}
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
                value={draft.limit ?? ""}
                onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
                className="w-28"
              />
            </FieldRow>
          </div>
        )}

        {conceptId && "conditions" in draft && (
          <FieldRow label="Filter">
            <ConditionList
              conceptId={conceptId}
              conditions={draft.conditions}
              labels={labels}
              onChange={(conditions) => patch({ conditions })}
            />
          </FieldRow>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => {
              onSave(draft)
              onClose()
            }}
          >
            Save widget
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  )
}
