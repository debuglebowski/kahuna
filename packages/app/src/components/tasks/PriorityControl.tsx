import { Flag } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TaskPriority } from "@/lib/api"

/** A priority's flag glyph — tinted by its color; muted outline when none. */
export function PriorityFlag({
  priority,
  size = 14,
}: {
  priority: TaskPriority | null | undefined
  size?: number
}) {
  if (!priority) return <Flag size={size} className="shrink-0 text-muted-foreground/50" />
  return (
    <Flag
      size={size}
      fill="currentColor"
      className="shrink-0"
      style={{ color: priority.color ?? "var(--muted-foreground)" }}
    />
  )
}

/** Sentinel for "no priority" — shadcn Select can't carry a null item value. */
const NONE = "__none"

/** Picks a task priority from the org's configured (live) set; clearable. */
export function PrioritySelect({
  value,
  priorities,
  onChange,
  disabled,
}: {
  value: string | null
  priorities: ReadonlyArray<TaskPriority>
  onChange: (priorityId: string | null) => void
  disabled?: boolean
}) {
  const live = priorities.filter((p) => !p.archivedAt)
  const selected = priorities.find((p) => p.id === value)
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-full">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            <PriorityFlag priority={selected} />
            <span className={`truncate ${selected ? "" : "text-muted-foreground"}`}>
              {selected?.name ?? "No priority"}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="flex items-center gap-1.5">
            <PriorityFlag priority={null} />
            No priority
          </span>
        </SelectItem>
        {live.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <span className="flex items-center gap-1.5">
              <PriorityFlag priority={p} />
              {p.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
