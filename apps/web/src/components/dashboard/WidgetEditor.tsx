import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardWidget } from "@/lib/api"
import { ConditionList, useFields } from "../ConditionList"
import { MultiCombobox } from "../MultiCombobox"
import { Button, Field as FieldRow, Input, Modal } from "../ui"

/** Edit one dashboard widget. Type is fixed at add-time. Filters reuse the shared
 *  `ConditionList` (the same authoring UI the sidebar section editor uses). */
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

        {draft.type === "trend" && (
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Bucket">
              <Select
                value={draft.bucket}
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
                value={draft.since}
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
        )}

        {draft.type === "activity" && (
          <FieldRow label="Max items">
            <Input
              type="number"
              min={1}
              value={draft.limit ?? ""}
              onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
              className="w-28"
            />
          </FieldRow>
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
