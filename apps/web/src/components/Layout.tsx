import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { Check, PanelLeftClose, PanelLeftOpen, Pencil, Settings2, X } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { api, type SidebarSection } from "../lib/api"
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
import { SectionList } from "./sidebar/SectionList"
import { ThemeButton } from "./ThemeButton"
import { Button, IconButton } from "./ui"

/** Remember whether the user minimized the sidebar, and which view is active. */
const COLLAPSED_KEY = "km.sidebar.collapsed"
const ACTIVE_VIEW_KEY = "km.sidebar.activeView"
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

export function Layout({ children }: { children: ReactNode }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === "1")
  const [activeViewId, setActiveViewIdState] = useState(() => read(ACTIVE_VIEW_KEY))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<{ sections: SidebarSection[] } | null>(null)

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
    setEditing(false)
  }

  const { sections, loaders } = useResolvedView(activeView, concepts ?? [], loc.pathname)

  const createMut = useMutation({
    mutationFn: (input: Parameters<typeof api.createView>[0]) => api.createView(input),
    onSuccess: async (v) => {
      await sidebarViewsCollection.utils.refetch()
      setActiveViewIdState(v.id)
      write(ACTIVE_VIEW_KEY, v.id)
    },
  })
  const updateMut = useMutation({
    mutationFn: (input: Parameters<typeof api.updateView>[0]) => api.updateView(input),
    onSuccess: () => sidebarViewsCollection.utils.refetch(),
  })

  // Enter in-place edit mode for a specific view (from the chip's right-click
  // "Configure"). Creating/deleting/managing views lives in Settings → Sidebar.
  const configureView = (id: string) => {
    const v = pagerViews.find((x) => x.id === id)
    if (!v) return
    setActiveViewIdState(id)
    write(ACTIVE_VIEW_KEY, id)
    setDraft({ sections: [...v.body.sections] })
    setEditing(true)
  }
  const saveEdit = () => {
    if (!draft) return
    const body = { sections: draft.sections }
    if (activeView.id === DEFAULT_VIEW.id) {
      createMut.mutate(
        { name: "My sidebar", icon: DEFAULT_VIEW.icon, scope: "personal", body },
        { onSuccess: () => setEditing(false) },
      )
    } else {
      updateMut.mutate({ id: activeView.id, body }, { onSuccess: () => setEditing(false) })
    }
  }

  const saving = createMut.isPending || updateMut.isPending

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
            <ThemeButton />
          </div>
          <nav
            key={activeView.id}
            className="km-view-in flex flex-1 flex-col overflow-y-auto px-1.5 pb-4"
          >
            <ViewNav sections={sections} collapsed />
          </nav>
          {pagerViews.length > 1 && (
            <div className="flex flex-col items-center gap-1 border-t border-sidebar-border py-2">
              {pagerViews.map((v) => (
                <PagerChip
                  key={v.id}
                  view={v}
                  active={v.id === activeView.id}
                  size="sm"
                  onSelect={() => setActiveViewId(v.id)}
                  onConfigure={() => configureView(v.id)}
                  onManage={() => navigate("/settings/sidebar")}
                />
              ))}
            </div>
          )}
        </aside>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    )
  }

  // ── expanded sidebar ─────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen">
      {loaders}
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
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

        {editing && draft ? (
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              Editing <span className="font-medium text-foreground">{activeView.name}</span>
            </p>
            <SectionList
              sections={draft.sections}
              concepts={concepts ?? []}
              onChange={(s) => setDraft({ sections: s })}
            />
          </div>
        ) : (
          <nav key={activeView.id} className="km-view-in flex-1 overflow-y-auto px-2 pb-4">
            {sections.every((s) => s.entries.length === 0) && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                This view is empty — configure it in Settings → Sidebar.
              </p>
            )}
            <ViewNav sections={sections} collapsed={false} />
          </nav>
        )}

        {/* View pager — only when there's more than one view to switch between.
            Creating/managing views lives in Settings → Sidebar; right-click a
            chip to configure that view in place. */}
        {editing ? (
          <div className="border-t border-sidebar-border p-2">
            <div className="flex gap-2">
              <Button className="flex-1" onClick={saveEdit} disabled={saving}>
                <Check size={15} /> {saving ? "Saving…" : "Done"}
              </Button>
              <Button variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                <X size={15} /> Cancel
              </Button>
            </div>
          </div>
        ) : pagerViews.length > 1 ? (
          <div className="flex justify-center gap-1 overflow-x-auto border-t border-sidebar-border p-2">
            {pagerViews.map((v) => (
              <PagerChip
                key={v.id}
                view={v}
                active={v.id === activeView.id}
                size="md"
                onSelect={() => setActiveViewId(v.id)}
                onConfigure={() => configureView(v.id)}
                onManage={() => navigate("/settings/sidebar")}
              />
            ))}
          </div>
        ) : null}

        <div className="border-t border-sidebar-border p-2">
          <IdentityMenu />
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
      </main>
    </div>
  )
}

/** A pager chip — left-click switches view, right-click opens its context menu
 *  (configure in place, or jump to Settings → Sidebar). Built on the shadcn
 *  {@link ContextMenu}, which owns positioning / outside-click / Escape. */
function PagerChip({
  view,
  active,
  size,
  onSelect,
  onConfigure,
  onManage,
}: {
  view: { id: string; name: string; icon: string | null }
  active: boolean
  size: "sm" | "md"
  onSelect: () => void
  onConfigure: () => void
  onManage: () => void
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={view.name}
          aria-label={view.name}
          onClick={onSelect}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md",
            size === "sm" ? "h-7 w-7" : "h-8 w-8",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <ConceptIcon value={view.icon || "lucide:LayoutGrid"} size={size === "sm" ? 15 : 16} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={onConfigure}>
          <Pencil size={14} /> Configure
        </ContextMenuItem>
        <ContextMenuItem onSelect={onManage}>
          <Settings2 size={14} /> Manage in settings…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
