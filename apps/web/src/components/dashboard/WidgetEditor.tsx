import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardWidget, type RichTextEnvelope } from "@/lib/api"
import { ConditionList, useFields } from "../ConditionList"
import { RichTextEditor } from "../editor/RichTextEditor"
import { MultiCombobox } from "../MultiCombobox"
import { Field as FieldRow, IconButton, Input, ToggleChip } from "../ui"
import { ShortcutItemsEditor } from "./ShortcutItemsEditor"

/**
 * Configure one dashboard widget — the side panel of the dashboard edit modal's
 * Layout tab. Type is fixed at add-time. Controlled: every change patches the
 * parent's draft body immediately, so the canvas previews live (the draft only
 * persists when the modal saves). Filters reuse the shared `ConditionList`.
 */
export function WidgetEditor({
  widget,
  concepts,
  onChange,
  onClose,
}: {
  widget: DashboardWidget
  concepts: readonly Concept[]
  onChange: (patch: Partial<DashboardWidget>) => void
  onClose: () => void
}) {
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const labels = labelsQ.data ?? []
  const conceptId = "conceptId" in widget ? (widget.conceptId ?? "") : ""
  const fields = useFields(conceptId)
  const scalarFields = (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file")
  // Rich text shows fine as a list column (text preview) but grouping/sorting
  // on a { doc, text } envelope is meaningless.
  const groupableFields = scalarFields.filter((f) => f.kind !== "richtext")
  const numberFields = (fields.data ?? []).filter((f) => f.kind === "number" || f.kind === "money")
  const computedFields = (fields.data ?? []).filter((f) => f.kind === "computed")

  const patch = onChange

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground capitalize">{widget.type} widget</h3>
        <IconButton aria-label="Close widget settings" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>

      <FieldRow label="Title (optional)">
        <Input
          value={widget.title ?? ""}
          placeholder="Widget title…"
          onChange={(e) => patch({ title: e.target.value || null })}
        />
      </FieldRow>

      {/* Org-global widgets (tasks/members/welcome) have no concept to pick. */}
      {"conceptId" in widget && (
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
      )}

      {widget.type === "metric" && (
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
        </>
      )}

      {widget.type === "breakdown" && (
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
        </div>
      )}

      {widget.type === "trend" && (
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
      )}

      {widget.type === "activity" && (
        <FieldRow label="Max items">
          <Input
            type="number"
            min={1}
            value={widget.limit ?? ""}
            onChange={(e) => patch({ limit: e.target.value ? Number(e.target.value) : null })}
            className="w-28"
          />
        </FieldRow>
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
        </>
      )}

      {widget.type === "members" && (
        <FieldRow label="Show">
          <ToggleChip
            pressed={widget.showToolbar ?? true}
            onPressedChange={(p) => patch({ showToolbar: p })}
          >
            Toolbar
          </ToggleChip>
        </FieldRow>
      )}

      {widget.type === "welcome" && (
        <p className="text-xs text-muted-foreground">
          No settings — the greeting rotates on every visit.
        </p>
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
                onChange={(e) => patch({ target: e.target.value ? Number(e.target.value) : null })}
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

      {conceptId && "conditions" in widget && (
        <FieldRow label="Filter">
          <ConditionList
            conceptId={conceptId}
            conditions={widget.conditions}
            labels={labels}
            onChange={(conditions) => patch({ conditions })}
            match={widget.match ?? "all"}
            onMatchChange={(match) => patch({ match })}
          />
        </FieldRow>
      )}
    </div>
  )
}
