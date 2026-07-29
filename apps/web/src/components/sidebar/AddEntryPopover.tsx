import type { ReactNode } from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Concept, Dashboard } from "../../lib/api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "../../lib/icons"
import { conceptEntryId, GLOBAL_NAV, globalEntryId } from "../../lib/sidebarViews"

/**
 * Searchable entry picker (shadcn Popover + Command) for placing entries into
 * a sidebar section: global nav items, non-hidden dashboards, and single-record
 * concepts not yet in the section. Picking one appends it and keeps the popover
 * open for multi-add (the picked item drops out of the list). Used by the inline
 * sidebar and the settings SectionsEditor.
 */
export function AddEntryPopover({
  dashboards,
  concepts,
  excludeIds,
  onPick,
  open,
  onOpenChange,
  align = "start",
  children,
}: {
  dashboards: readonly Dashboard[]
  concepts: readonly Concept[]
  excludeIds: ReadonlyArray<string>
  onPick: (entryId: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: "start" | "center" | "end"
  /** The trigger element. */
  children: ReactNode
}) {
  const excluded = new Set(excludeIds)
  const globals = GLOBAL_NAV.filter((g) => !excluded.has(globalEntryId(g.key)))
  const dashboardOptions = dashboards
    .filter((d) => !d.hidden && !excluded.has(d.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  // Only single-record concepts are offered: a list concept has no one record to
  // land on, so it has no `/c/<slug>` page to link to.
  const conceptOptions = concepts
    .filter((c) => c.singleRecord && !c.archivedAt && !excluded.has(conceptEntryId(c.id)))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-60 p-0" align={align}>
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>Nothing to add.</CommandEmpty>
            {globals.length > 0 && (
              <CommandGroup heading="Global items">
                {globals.map((g) => (
                  <CommandItem
                    key={g.key}
                    value={`global ${g.label}`}
                    onSelect={() => onPick(globalEntryId(g.key))}
                  >
                    <span className="flex h-4 w-4 items-center justify-center">{g.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {dashboardOptions.length > 0 && (
              <CommandGroup heading="Dashboards">
                {dashboardOptions.map((d) => (
                  <CommandItem key={d.id} value={d.name} onSelect={() => onPick(d.id)}>
                    <ConceptIcon value={d.icon || "lucide:LayoutDashboard"} size={15} />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {conceptOptions.length > 0 && (
              <CommandGroup heading="Records">
                {conceptOptions.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.name}
                    onSelect={() => onPick(conceptEntryId(c.id))}
                  >
                    <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={15} />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
