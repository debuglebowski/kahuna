import { CalendarDays } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatDateValue, parseDateValue, toISODate } from "../lib/dates"
import { cn } from "../lib/utils"

/**
 * Popover calendar over a stored `YYYY-MM-DD` value. The trigger shows the
 * formatted date (or a placeholder) + a calendar glyph; picking a day commits.
 */
export function DatePicker({
  value,
  onChange,
  onClear,
  triggerClassName,
  placeholder = "—",
  align = "start",
}: {
  value?: string
  onChange: (value: string) => void
  /** When provided, the popover gets a "Clear" footer that calls it. */
  onClear?: () => void
  triggerClassName?: string
  placeholder?: ReactNode
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = useState(false)
  const selected = parseDateValue(value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn("inline-flex items-center gap-1.5 text-sm", triggerClassName)}
        >
          {value ? (
            <span className="truncate">{formatDateValue(value)}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <CalendarDays className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(d) => {
            if (d) {
              onChange(toISODate(d))
              setOpen(false)
            }
          }}
          initialFocus
        />
        {onClear && (
          <div className="border-t border-border p-1">
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
              onClick={() => {
                onClear()
                setOpen(false)
              }}
            >
              Clear
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
