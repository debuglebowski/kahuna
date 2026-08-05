import { X } from "lucide-react"
import { Badge, IconButton, Input } from "../ui"

/** ISO datetime → yyyy-mm-dd for a native date input (local date). */
const toDateInput = (iso: string | null): string => (iso ? iso.slice(0, 10) : "")

/** Is an ISO due date strictly before today (overdue)? */
export const isOverdue = (iso: string | null, now: Date = new Date()): boolean => {
  if (!iso) return false
  const due = new Date(iso.slice(0, 10))
  const today = new Date(now.toISOString().slice(0, 10))
  return due.getTime() < today.getTime()
}

/**
 * Due-date control — a native `<Input type="date">` (already precedented in
 * InstanceForm) with a clear button. Emits an ISO date string (midnight UTC) or
 * null. Renders an "Overdue" badge when past.
 */
export function DueDateControl({
  value,
  onChange,
  disabled,
}: {
  value: string | null
  onChange: (iso: string | null) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="date"
        className="h-8 w-[9.5rem]"
        value={toDateInput(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
      />
      {value && isOverdue(value) && <Badge tone="red">Overdue</Badge>}
      {value && !disabled && (
        <IconButton aria-label="Clear due date" onClick={() => onChange(null)}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}
