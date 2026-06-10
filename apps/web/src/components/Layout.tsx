import { useLiveQuery } from "@tanstack/react-db"
import { Check, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react"
import { type ReactNode, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  conceptsCollection,
  KEY,
  sidebarViewsCollection,
  useRegisterCollection,
} from "../lib/collections"
import { ConceptIcon } from "../lib/icons"
import {
  DEFAULT_VIEW,
  type ResolvedEntry,
  type ResolvedSection,
  useResolvedView,
} from "../lib/sidebarViews"
import { useLiveSync } from "../lib/useLiveSync"
import { useSafetyRefetch } from "../lib/useSafetyRefetch"
import { cn } from "../lib/utils"
import { IdentityMenu } from "./IdentityMenu"
import { ThemeButton } from "./ThemeButton"
import { IconButton } from "./ui"

/** Remember whether the user minimized the sidebar, its width, and which view is active. */
const COLLAPSED_KEY = "km.sidebar.collapsed"
const ACTIVE_VIEW_KEY = "km.sidebar.activeView"
const WIDTH_KEY = "km.sidebar.width"
const MIN_WIDTH = 180
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 240
const read = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

/** One nav row — a router link, or a plain anchor for external link entries. */
function NavEntry({ entry, collapsed }: { entry: ResolvedEntry; collapsed: boolean }) {
  const className = cn(
    "flex items-center rounded-md text-sm",
    collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-1.5",
    entry.active
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  )
  const inner = (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{entry.icon}</span>
      {!collapsed && <span className="truncate">{entry.label}</span>}
    </>
  )
  const title = collapsed ? entry.label : undefined
  return entry.external ? (
    <a href={entry.to} target="_blank" rel="noreferrer" title={title} className={className}>
      {inner}
    </a>
  ) : (
    <Link to={entry.to} title={title} className={className}>
      {inner}
    </Link>
  )
}

/** A view's resolved sections, with collapsible titled groups. */
function ViewNav({ sections, collapsed }: { sections: ResolvedSection[]; collapsed: boolean }) {
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
            {!isClosed &&
              section.entries.map((e) => <NavEntry key={e.key} entry={e} collapsed={collapsed} />)}
          </div>
        )
      })}
    </>
  )
}

/** Drag handle on the sidebar's right edge — the ARIA "window splitter"
 *  pattern (focusable separator, arrow keys nudge). The sidebar sits at the
 *  viewport's left edge, so the pointer's clientX is the new width directly.
 *  Pointer capture keeps the drag alive when the cursor outruns the handle. */
function ResizeHandle({
  width,
  onResize,
  onCommit,
  onReset,
}: {
  width: number
  onResize: (width: number) => void
  onCommit: () => void
  onReset: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const clamp = (x: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(x)))
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.cursor = ""
    onCommit()
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: an interactive window splitter must be a focusable div, not <hr>
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        document.body.style.cursor = "col-resize"
        setDragging(true)
      }}
      onPointerMove={(e) => dragging && onResize(clamp(e.clientX))}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        e.preventDefault()
        onResize(clamp(width + (e.key === "ArrowLeft" ? -16 : 16)))
        onCommit()
      }}
      className={cn(
        "absolute inset-y-0 -right-px z-10 w-[3px] cursor-col-resize transition-colors hover:bg-sidebar-primary/40 focus-visible:bg-sidebar-primary/60 focus-visible:outline-none",
        dragging && "bg-sidebar-primary/60",
      )}
    />
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === "1")
  const [width, setWidth] = useState(() => {
    const n = Number(read(WIDTH_KEY))
    return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : DEFAULT_WIDTH
  })
  // Latest width for the drag-end commit (state in the closure would be stale).
  const widthRef = useRef(width)
  const resizeTo = (w: number) => {
    widthRef.current = w
    setWidth(w)
  }
  const commitWidth = () => write(WIDTH_KEY, String(widthRef.current))
  const [activeViewId, setActiveViewIdState] = useState(() => read(ACTIVE_VIEW_KEY))

  // Single live-sync connection + safety backstop (Layout wraps every authed page).
  useLiveSync()
  useSafetyRefetch()
  useRegisterCollection(KEY.concepts, conceptsCollection)
  useRegisterCollection(KEY.views, sidebarViewsCollection)
  const { data: concepts } = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  const { data: views } = useLiveQuery((q) => q.from({ v: sidebarViewsCollection }))

  // Pager shows non-hidden views, ordered by `position` — the same order the
  // Settings → Sidebar list uses (and what drag-reorder there persists).
  const pagerViews = useMemo(() => {
    const visible = (views ?? []).filter((v) => !v.hidden).sort((a, b) => a.position - b.position)
    return visible.length > 0 ? visible : [DEFAULT_VIEW]
  }, [views])
  const activeView = pagerViews.find((v) => v.id === activeViewId) ?? pagerViews[0] ?? DEFAULT_VIEW

  const setActiveViewId = (id: string) => {
    setActiveViewIdState(id)
    write(ACTIVE_VIEW_KEY, id)
  }

  const { sections, loaders } = useResolvedView(activeView, concepts ?? [], loc.pathname)

  // ── collapsed rail ───────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <div className="flex min-h-screen">
        {loaders}
        <aside className="flex w-12 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <div className="flex flex-col items-center gap-1 py-4">
            <IconButton
              onClick={() => {
                setCollapsed(false)
                write(COLLAPSED_KEY, "0")
              }}
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen size={18} />
            </IconButton>
          </div>
          <nav
            key={activeView.id}
            className="km-view-in flex flex-1 flex-col overflow-y-auto px-1.5 pb-4"
          >
            <ViewNav sections={sections} collapsed />
          </nav>
          {pagerViews.length > 1 && (
            <div className="flex flex-col items-center py-2">
              <ViewSwitcher
                views={pagerViews}
                active={activeView}
                size="sm"
                onSelect={setActiveViewId}
                onManage={() => navigate("/settings/sidebar")}
              />
            </div>
          )}
        </aside>
        <main className="flex-1 overflow-y-auto">
          <div className="px-6 py-6">{children}</div>
        </main>
      </div>
    )
  }

  // ── expanded sidebar ─────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen">
      {loaders}
      <aside
        style={{ width }}
        className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      >
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
            Kingsmaker
          </span>
          <div className="flex items-center gap-0.5">
            <ThemeButton />
            <IconButton
              onClick={() => {
                setCollapsed(true)
                write(COLLAPSED_KEY, "1")
              }}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </IconButton>
          </div>
        </div>

        <nav key={activeView.id} className="km-view-in flex-1 overflow-y-auto px-2 pb-4">
          {sections.every((s) => s.entries.length === 0) && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              This view is empty — configure it in Settings → Sidebar.
            </p>
          )}
          <ViewNav sections={sections} collapsed={false} />
        </nav>

        {/* View switcher — only when there's more than one view to switch
            between. Creating/editing views lives in Settings → Sidebar. */}
        {pagerViews.length > 1 && (
          <div className="p-2">
            <ViewSwitcher
              views={pagerViews}
              active={activeView}
              size="md"
              onSelect={setActiveViewId}
              onManage={() => navigate("/settings/sidebar")}
            />
          </div>
        )}

        <div className="border-t border-sidebar-border p-2">
          <IdentityMenu />
        </div>

        <ResizeHandle
          width={width}
          onResize={resizeTo}
          onCommit={commitWidth}
          onReset={() => {
            resizeTo(DEFAULT_WIDTH)
            commitWidth()
          }}
        />
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
      </main>
    </div>
  )
}

/** The view switcher — a single dropdown trigger showing the active view (icon,
 *  plus name + chevron when the sidebar is wide enough). The menu lists all
 *  views, with a quiet footer link to Settings → Sidebar where views are
 *  created and edited. Built on the shadcn {@link DropdownMenu}, which owns
 *  open state, outside-click, Escape, and keyboard navigation. */
function ViewSwitcher({
  views,
  active,
  size,
  onSelect,
  onManage,
}: {
  views: { id: string; name: string; icon: string | null }[]
  active: { id: string; name: string; icon: string | null }
  size: "sm" | "md"
  onSelect: (id: string) => void
  onManage: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={active.name || "Untitled view"}
        aria-label="Switch view"
        className={cn(
          "flex items-center rounded-md border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          size === "sm" ? "h-7 w-7 justify-center" : "h-8 w-full gap-2 px-2.5",
        )}
      >
        <ConceptIcon value={active.icon || "lucide:LayoutGrid"} size={size === "sm" ? 15 : 16} />
        {size === "md" && (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
              {active.name || "Untitled view"}
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-sidebar-foreground/70" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={size === "sm" ? "right" : "top"}
        align={size === "sm" ? "end" : "start"}
        className="w-48"
      >
        {views.map((v) => (
          <DropdownMenuItem
            key={v.id}
            onSelect={() => onSelect(v.id)}
            className={cn(v.id === active.id && "font-medium")}
          >
            <ConceptIcon value={v.icon || "lucide:LayoutGrid"} size={14} />
            <span className="min-w-0 flex-1 truncate">{v.name || "Untitled view"}</span>
            {v.id === active.id && <Check size={14} className="shrink-0 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage} className="text-xs text-muted-foreground">
          <Settings2 size={13} /> Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
