import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TaskStatus } from "../../lib/api"

/** Map a status's semantic category to a dot color (a sensible default when the
 *  status has no explicit `color`). */
const CATEGORY_DOT: Record<string, string> = {
  todo: "#94a3b8",
  active: "#2563eb",
  done: "#16a34a",
  cancelled: "#78716c",
}

export function Dot({ status }: { status: TaskStatus }) {
  return (
    <span
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: status.color ?? CATEGORY_DOT[status.category] ?? "#94a3b8" }}
    />
  )
}

/** Picks a task status from the org's configured (live, non-archived) set. */
export function StatusSelect({
  value,
  statuses,
  onChange,
  disabled,
}: {
  value: string | null
  statuses: ReadonlyArray<TaskStatus>
  onChange: (statusId: string) => void
  disabled?: boolean
}) {
  const live = statuses.filter((s) => !s.archivedAt)
  const selected = statuses.find((s) => s.id === value)
  return (
    <Select value={value ?? undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="h-8 w-full">
        <SelectValue>
          {selected ? (
            <span className="flex items-center gap-1.5">
              <Dot status={selected} />
              <span className="truncate">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">No status</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {live.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex items-center gap-1.5">
              <Dot status={s} />
              {s.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
