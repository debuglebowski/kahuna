import { Search } from "lucide-react"
import { useState } from "react"
import { Input, ToggleChip } from "@/components/ui"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import type { DashboardWidget } from "@/lib/api"
import { WIDGET_CATALOG, WIDGET_CATEGORIES, type WidgetCategory } from "@/lib/widgetCatalog"

const STORE_KEY = "km:dash:widgetCategories"

const VALID = new Set<string>(WIDGET_CATEGORIES)

/** Read the sticky set of active category filters (an empty set = show all). */
const readActive = (): Set<WidgetCategory> => {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is WidgetCategory => VALID.has(v)))
      }
    }
  } catch {
    // ignore unavailable / corrupt storage
  }
  return new Set()
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
 * blurb / keywords, and a row of category filter chips toggles which sections
 * are shown (no chips active = every section; the selection is sticky across
 * sessions). Picking a row adds that widget and closes the gallery (the caller's
 * `addOfType` then opens its config panel).
 */
export function WidgetGallery({
  onPick,
  onClose,
}: {
  onPick: (type: DashboardWidget["type"]) => void
  onClose: () => void
}) {
  const [active, setActive] = useState<Set<WidgetCategory>>(readActive)
  const [query, setQuery] = useState("")

  const pick = (type: DashboardWidget["type"]) => {
    onPick(type)
    onClose()
  }
  const toggle = (cat: WidgetCategory) => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify([...next]))
      } catch {
        // ignore unavailable storage
      }
      return next
    })
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // A category section shows when nothing is toggled (browse-all) or it's on.
  const isShown = (cat: WidgetCategory) => active.size === 0 || active.has(cat)
  const filtered = WIDGET_CATALOG.filter((w) => isShown(w.category) && matchesQuery(w, terms))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(691px,94vw)] flex-col gap-0 p-0 sm:max-w-none">
        <div className="shrink-0 space-y-3 border-b px-5 py-3">
          <DialogTitle className="text-sm font-semibold">Add widget</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a widget to add to this dashboard.
          </DialogDescription>
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search widgets…"
              className="h-8 w-full pl-8"
            />
          </div>
          <div className="flex gap-1.5 overflow-x-auto [&>*]:shrink-0">
            {WIDGET_CATEGORIES.map((cat) => (
              <ToggleChip key={cat} pressed={active.has(cat)} onPressedChange={() => toggle(cat)}>
                {cat}
              </ToggleChip>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-9 overflow-y-auto p-5">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No widgets match{query.trim() ? ` “${query.trim()}”` : " these filters"}.
            </p>
          ) : (
            WIDGET_CATEGORIES.map((cat) => {
              const items = filtered.filter((w) => w.category === cat)
              if (items.length === 0) return null
              return (
                <section key={cat}>
                  <h3 className="mb-3 border-b pb-1.5 text-base font-semibold text-foreground">
                    {cat}
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
