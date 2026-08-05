import { useQuery } from "@tanstack/react-query"
import { Box, Globe, LayoutDashboard } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { api, type DashboardWidget } from "@/lib/api"
import { recordHref } from "@/lib/recordHref"
import { cn } from "@/lib/utils"

type Shortcuts = Extract<DashboardWidget, { type: "shortcuts" }>
type Item = Shortcuts["items"][number]

const KIND_ICON: Record<Item["kind"], typeof Box> = {
  recordVersion: Box,
  // "instance" is the pre-rename value, still decodable for one release.
  instance: Box,
  dashboard: LayoutDashboard,
  url: Globe,
}

/** Bare hosts are stored as typed ("example.com") — default them to https so the
 *  anchor doesn't resolve relative to the app. (Shared with Welcome's links.) */
export const urlHref = (ref: string): string =>
  /^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : `https://${ref}`

/** Curated jump-off points — hand-picked links to record versions, dashboards, or
 *  external URLs. Fully manual by design: the curation IS the filter. */
export function ShortcutsWidget({ widget }: { widget: Shortcuts }) {
  // Dashboard targets re-resolve to the live name (shares the page's query).
  const hasDashboardItems = widget.items.some((i) => i.kind === "dashboard")
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
    enabled: hasDashboardItems,
  })

  if (widget.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No shortcuts yet — add some in the widget settings.
      </p>
    )
  }

  const grid = widget.variant === "grid"
  const labelOf = (item: Item): string => {
    if (item.kind === "dashboard")
      return dashboards?.find((d) => d.id === item.ref)?.name ?? item.label ?? "Dashboard"
    return item.label || item.ref
  }

  const entry = (item: Item) => {
    const Icon = KIND_ICON[item.kind]
    const className = grid
      ? "flex flex-col items-center justify-center gap-1.5 rounded-lg border p-3 text-center transition hover:bg-accent"
      : "flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-accent"
    const content = (
      <>
        <Icon size={grid ? 18 : 14} className="shrink-0 text-muted-foreground" />
        <span className={cn("min-w-0 truncate text-sm text-foreground", grid && "w-full")}>
          {labelOf(item)}
        </span>
      </>
    )
    if (item.kind === "url") {
      return (
        <a
          key={item.id}
          href={urlHref(item.ref)}
          target={widget.newTab ? "_blank" : undefined}
          rel={widget.newTab ? "noreferrer" : undefined}
          className={className}
        >
          {content}
        </a>
      )
    }
    const to = item.kind === "dashboard" ? `/dashboards/${item.ref}` : recordHref(item.ref)
    return (
      <Link key={item.id} to={to} className={className}>
        {content}
      </Link>
    )
  }

  return (
    // cancel-drag: clicking a shortcut must never start a tile drag.
    <div
      className={cn(
        "cancel-drag h-full overflow-y-auto",
        grid ? "grid auto-rows-min grid-cols-2 gap-2" : "flex flex-col gap-0.5",
      )}
    >
      {widget.items.map(entry)}
    </div>
  )
}

/** Glyph + resolved label for one item — reused by the editor's item rows. */
export function ShortcutItemGlyph({ kind }: { kind: Item["kind"] }): ReactNode {
  const Icon = KIND_ICON[kind]
  return <Icon size={14} className="shrink-0 text-muted-foreground" />
}
