import { Crown } from "lucide-react"
import type { Label } from "../lib/api"
import { cn } from "../lib/utils"
import { readableOn } from "./ui"

/**
 * Toggle-chip multi-select over the org label vocabulary. Selected chips render
 * in the label's color; unselected render as neutral outlines. `excludeIds`
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
  const selected = new Set(selectedIds)
  const options = all.filter((l) => !exclude.has(l.id)).sort((a, b) => a.name.localeCompare(b.name))
  if (options.length === 0) return <p className="text-xs text-gray-400">{emptyHint}</p>

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((l) => {
        const on = selected.has(l.id)
        const style =
          on && l.color ? { backgroundColor: l.color, color: readableOn(l.color) } : undefined
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => toggle(l.id)}
            style={style}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition",
              on
                ? style
                  ? "border-transparent"
                  : "border-transparent bg-gray-800 text-white"
                : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50",
            )}
          >
            {l.primary && <Crown className="h-3 w-3 shrink-0" aria-label="Primary" />}
            {l.name}
          </button>
        )
      })}
    </div>
  )
}
