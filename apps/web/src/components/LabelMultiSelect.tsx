import { Crown } from "lucide-react"
import type { Label } from "../lib/api"
import { MultiCombobox } from "./MultiCombobox"
import { LabelChip } from "./ui"

/**
 * Multi-select over the org label vocabulary — selected labels render as
 * colored chips (with ×), and a searchable combobox adds more. `excludeIds`
 * hides options (e.g. static labels when picking item-level / default labels).
 */
export function LabelMultiSelect({
  all,
  selectedIds,
  onChange,
  excludeIds = [],
  emptyHint = "No labels in the vocabulary yet.",
}: {
  all: ReadonlyArray<Label>
  selectedIds: ReadonlyArray<string>
  onChange: (ids: string[]) => void
  excludeIds?: ReadonlyArray<string>
  emptyHint?: string
}) {
  const exclude = new Set(excludeIds)
  const byId = new Map(all.map((l) => [l.id, l]))
  const options = all
    .filter((l) => !exclude.has(l.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => ({
      id: l.id,
      label: l.name,
      icon: l.primary ? (
        <Crown className="size-3 shrink-0 text-muted-foreground" aria-label="Primary" />
      ) : undefined,
    }))
  if (options.length === 0) return <p className="text-xs text-muted-foreground">{emptyHint}</p>

  return (
    <MultiCombobox
      options={options}
      selectedIds={selectedIds}
      onChange={onChange}
      placeholder="Label"
      searchPlaceholder="Search labels…"
      emptyText="No matching labels."
      renderChip={(o, remove) => {
        const l = byId.get(o.id)
        return (
          <LabelChip color={l?.color ?? null} primary={l?.primary} onRemove={remove}>
            {o.label}
          </LabelChip>
        )
      }}
    />
  )
}
