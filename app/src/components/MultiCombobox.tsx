import { Check, Plus, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface MultiComboboxOption {
  id: string
  label: string
  /** Optional leading adornment in the option row (e.g. a crown or icon). */
  icon?: ReactNode
}

/**
 * Multi-select combobox (shadcn Popover + Command): selected values render as
 * removable chips, a dashed "+" trigger opens a searchable option list, and
 * picking an option toggles it without closing the popover. Pass `renderChip`
 * to customize the chip (defaults to a secondary badge with an ×).
 */
export function MultiCombobox({
  options,
  selectedIds,
  onChange,
  placeholder = "Add",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  renderChip,
}: {
  options: ReadonlyArray<MultiComboboxOption>
  selectedIds: ReadonlyArray<string>
  onChange: (ids: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  renderChip?: (option: MultiComboboxOption, remove: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const selected = new Set(selectedIds)
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }
  const chips = options.filter((o) => selected.has(o.id))

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((o) =>
        renderChip ? (
          <span key={o.id} className="contents">
            {renderChip(o, () => toggle(o.id))}
          </span>
        ) : (
          <Badge key={o.id} variant="secondary" className="gap-1 pr-1">
            {o.label}
            <button
              type="button"
              onClick={() => toggle(o.id)}
              aria-label={`Remove ${o.label}`}
              className="inline-flex rounded-full opacity-70 hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ),
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            className="rounded-full border-dashed font-medium text-muted-foreground hover:text-foreground"
          >
            <Plus />
            {placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-0" align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.id} value={o.label} onSelect={() => toggle(o.id)}>
                    {o.icon}
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    <Check
                      className={cn("size-4", selected.has(o.id) ? "opacity-100" : "opacity-0")}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
