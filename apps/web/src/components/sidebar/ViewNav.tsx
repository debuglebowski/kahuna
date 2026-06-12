import { useState } from "react"
import { Link } from "react-router-dom"
import { ConceptIcon } from "../../lib/icons"
import type { ResolvedEntry, ResolvedSection } from "../../lib/sidebarViews"
import { cn } from "../../lib/utils"

/** One nav row — a router link. */
export function NavEntry({ entry, collapsed }: { entry: ResolvedEntry; collapsed: boolean }) {
  const className = cn(
    "flex items-center rounded-md text-sm",
    collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-1.5",
    entry.active
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  )
  return (
    <Link to={entry.to} title={collapsed ? entry.label : undefined} className={className}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{entry.icon}</span>
      {!collapsed && <span className="truncate">{entry.label}</span>}
    </Link>
  )
}

/** Read-only resolved sections, with collapsible titled groups — the sidebar's
 *  one renderer (expanded, collapsed rail, settings nav, and the ViewEditor
 *  preview); all editing lives in Settings → Sidebar. */
export function ViewNav({
  sections,
  collapsed,
}: {
  sections: ResolvedSection[]
  collapsed: boolean
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  return (
    <>
      {sections.map((section, i) => {
        const isClosed = closed[section.id] ?? section.collapsed
        // The title is optional. When present it's a collapsible header; when
        // absent the section still renders its entries — just delimited by a
        // little spacing (so an untitled section after another reads as its own).
        const hasTitle = !collapsed && !!section.title
        return (
          <div key={section.id} className={!collapsed && !hasTitle && i > 0 ? "mt-3" : undefined}>
            {hasTitle && (
              <button
                type="button"
                onClick={() => setClosed((c) => ({ ...c, [section.id]: !isClosed }))}
                className="mt-5 mb-1 flex w-full items-center gap-1.5 px-3 text-xs font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground"
              >
                {section.icon && <ConceptIcon value={section.icon} size={12} />}
                <span className="truncate">{section.title}</span>
              </button>
            )}
            {collapsed && i > 0 && <div className="mx-2 my-2 border-t border-sidebar-border" />}
            {!isClosed && (
              <div className="space-y-0.5">
                {section.entries.map((e) => (
                  <NavEntry key={e.key} entry={e} collapsed={collapsed} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
