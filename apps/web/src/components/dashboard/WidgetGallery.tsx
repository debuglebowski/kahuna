import { Search } from "lucide-react"
import { useState } from "react"
import { Input } from "@/components/ui"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { DashboardWidget } from "@/lib/api"
import { GROUP_BY_OPTIONS, GROUP_SECTIONS, type GroupBy, WIDGET_CATALOG } from "@/lib/widgetCatalog"

const STORE_KEY = "km:dash:widgetGroupBy"

const isGroupBy = (v: string | null): v is GroupBy =>
  v === "intent" || v === "source" || v === "scope"

/** Read the sticky group-by choice, defaulting to "intent". */
const readGroupBy = (): GroupBy => {
  try {
    const v = localStorage.getItem(STORE_KEY)
    if (isGroupBy(v)) return v
  } catch {
    // ignore unavailable storage
  }
  return "intent"
}

/** Whitespace-split query terms; a widget matches when every term is found in
 *  its label, description, keywords or type. */
const matchesQuery = (w: (typeof WIDGET_CATALOG)[number], terms: readonly string[]): boolean => {
  if (terms.length === 0) return true
  const hay = `${w.label} ${w.description} ${w.keywords.join(" ")} ${w.type}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/**
 * The Add-widget gallery — a modal browser over every widget type, each a list
 * row with a static preview, label and blurb. A search box filters by name /
 * blurb / keywords, and a Group-by dropdown reshuffles the rows into sections by
 * intent / data source / scope (the choice is sticky across sessions). Picking a
 * row adds that widget and closes the gallery (the caller's `addOfType` then
 * opens its config panel).
 */
export function WidgetGallery({
  onPick,
  onClose,
}: {
  onPick: (type: DashboardWidget["type"]) => void
  onClose: () => void
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy)
  const [query, setQuery] = useState("")

  const pick = (type: DashboardWidget["type"]) => {
    onPick(type)
    onClose()
  }
  const changeGroup = (g: GroupBy) => {
    setGroupBy(g)
    try {
      localStorage.setItem(STORE_KEY, g)
    } catch {
      // ignore unavailable storage
    }
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = WIDGET_CATALOG.filter((w) => matchesQuery(w, terms))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(691px,94vw)] flex-col gap-0 p-0 sm:max-w-none">
        <div className="shrink-0 space-y-3 border-b py-3 pr-12 pl-5">
          <DialogTitle className="text-sm font-semibold">Add widget</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a widget to add to this dashboard.
          </DialogDescription>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search widgets…"
                className="h-8 pl-8"
              />
            </div>
            <Select value={groupBy} onValueChange={(v) => changeGroup(v as GroupBy)}>
              <SelectTrigger size="sm" className="shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUP_BY_OPTIONS.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-9 overflow-y-auto p-5">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No widgets match “{query.trim()}”.
            </p>
          ) : (
            GROUP_SECTIONS[groupBy].map((section) => {
              const items = filtered.filter((w) => w.groups[groupBy] === section)
              if (items.length === 0) return null
              return (
                <section key={section}>
                  <h3 className="mb-3 border-b pb-1.5 text-base font-semibold text-foreground">
                    {section}
                  </h3>
                  <div className="space-y-2">
                    {items.map((w) => (
                      <button
                        key={w.type}
                        type="button"
                        onClick={() => pick(w.type)}
                        className="group flex w-full items-center gap-3 rounded-lg border bg-card p-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <div className="w-28 shrink-0">
                          <w.Preview />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <w.icon size={14} className="shrink-0 text-muted-foreground" />
                            <span className="text-sm font-medium">{w.label}</span>
                          </div>
                          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                            {w.description}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
