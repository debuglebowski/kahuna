import { Plus, X } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Concept, Label } from "@/lib/api"
import { cn } from "@/lib/utils"
import { type CalendarSource, SOURCE_FALLBACK_COLORS, sourceColor } from "@/lib/widgetDates"
import { ConceptSelectItems } from "../ConceptSelectItems"
import { ConditionList, useFields } from "../ConditionList"
import { Button, Field as FieldRow, IconButton } from "../ui"

/**
 * The Calendar widget's `sources[]` editor — one card per overlaid concept:
 * concept → date field (+ optional label field), a color, and per-source
 * conditions. Lives beside the other config rows in `WidgetEditor`'s side
 * panel; every change patches the whole array up.
 */
export function CalendarSourcesEditor({
  sources,
  concepts,
  labels,
  onChange,
}: {
  sources: readonly CalendarSource[]
  concepts: readonly Concept[]
  labels: readonly Label[]
  onChange: (next: CalendarSource[]) => void
}) {
  const patchAt = (i: number, p: Partial<CalendarSource>) =>
    onChange(sources.map((s, j) => (j === i ? { ...s, ...p } : s)))
  return (
    <div className="space-y-2">
      {sources.map((s, i) => (
        <SourceCard
          // biome-ignore lint/suspicious/noArrayIndexKey: sources have no id; index is their identity
          key={i}
          source={s}
          index={i}
          concepts={concepts}
          labels={labels}
          onChange={(p) => patchAt(i, p)}
          onRemove={() => onChange(sources.filter((_, j) => j !== i))}
        />
      ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange([...sources, { conceptId: "", dateField: "" }])}
      >
        <Plus size={14} /> Add source
      </Button>
    </div>
  )
}

function SourceCard({
  source,
  index,
  concepts,
  labels,
  onChange,
  onRemove,
}: {
  source: CalendarSource
  index: number
  concepts: readonly Concept[]
  labels: readonly Label[]
  onChange: (p: Partial<CalendarSource>) => void
  onRemove: () => void
}) {
  const fields = useFields(source.conceptId)
  const dateFields = (fields.data ?? []).filter((f) => f.kind === "date")
  const labelFields = (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file")
  const concept = concepts.find((c) => c.id === source.conceptId)
  return (
    <div className="space-y-3 rounded-lg border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {concept ? concept.pluralName || concept.name : `Source ${index + 1}`}
        </span>
        <IconButton aria-label="Remove source" onClick={onRemove}>
          <X size={14} />
        </IconButton>
      </div>
      <FieldRow label="Concept">
        <Select
          value={source.conceptId || "__none"}
          // A new concept invalidates the field picks (ids are per-concept).
          onValueChange={(v) =>
            onChange({ conceptId: v === "__none" ? "" : v, dateField: "", labelField: null })
          }
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
      {source.conceptId && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Date field">
              <Select
                value={source.dateField || "__none"}
                onValueChange={(v) => onChange({ dateField: v === "__none" ? "" : v })}
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
            <FieldRow label="Event label">
              <Select
                value={source.labelField || "__name"}
                onValueChange={(v) => onChange({ labelField: v === "__name" ? null : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__name">Name</SelectItem>
                  {labelFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
          {dateFields.length === 0 && fields.data && (
            <p className="text-xs text-muted-foreground">This concept has no date fields.</p>
          )}
          <FieldRow label="Color">
            <div className="flex flex-wrap items-center gap-1">
              {SOURCE_FALLBACK_COLORS.map((hex) => {
                const selected = (source.color ?? sourceColor(null, index)) === hex
                return (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`Color ${hex}`}
                    aria-pressed={selected}
                    style={{ backgroundColor: hex }}
                    className={cn(
                      "size-4 rounded-full transition-transform hover:scale-110",
                      selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                    )}
                    onClick={() => onChange({ color: hex })}
                  />
                )
              })}
            </div>
          </FieldRow>
          <FieldRow label="Filter">
            <ConditionList
              conceptId={source.conceptId}
              conditions={source.conditions ?? []}
              labels={labels}
              onChange={(conditions) => onChange({ conditions })}
              match={source.match ?? "all"}
              onMatchChange={(match) => onChange({ match })}
            />
          </FieldRow>
        </>
      )}
    </div>
  )
}
