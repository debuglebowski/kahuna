import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { Check, LogOut, PanelLeftClose, PanelLeftOpen, Pencil, Settings2, X } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { api, type SidebarSection } from "../lib/api"
import { signOut, useSession } from "../lib/auth-client"
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
import { OrgSwitcher } from "./OrgSwitcher"
import { SectionList } from "./sidebar/SectionList"
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
    entry.active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100",
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
                className="mt-5 mb-1 flex w-full items-center gap-1.5 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600"
              >
                {section.icon && <ConceptIcon value={section.icon} size={12} />}
                <span className="truncate">{section.title}</span>
              </button>
            )}
            {collapsed && i > 0 && <div className="mx-2 my-2 border-t border-gray-100" />}
            {!isClosed &&
              section.entries.map((e) => <NavEntry key={e.key} entry={e} collapsed={collapsed} />)}
          </div>
        )
      })}
    </>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { data } = useSession()
  const loc = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === "1")
  const [activeViewId, setActiveViewIdState] = useState(() => read(ACTIVE_VIEW_KEY))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<{ sections: SidebarSection[] } | null>(null)
  // Right-click context menu over a pager chip (only when >1 view exists).
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

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
    setMenu(null)
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
      <div className="flex min-h-screen bg-gray-50">
        {loaders}
        <aside className="flex w-12 shrink-0 flex-col border-r border-gray-200 bg-white">
          <div className="flex justify-center py-4">
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
            <div className="flex flex-col items-center gap-1 border-t border-gray-100 py-2">
              {pagerViews.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  title={v.name}
                  aria-label={v.name}
                  onClick={() => setActiveViewId(v.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ id: v.id, x: e.clientX, y: e.clientY })
                  }}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md",
                    v.id === activeView.id
                      ? "bg-gray-900 text-white"
                      : "text-gray-500 hover:bg-gray-100",
                  )}
                >
                  <ConceptIcon value={v.icon || "lucide:LayoutGrid"} size={15} />
                </button>
              ))}
            </div>
          )}
        </aside>
        {menu && (
          <ViewMenu
            menu={menu}
            onConfigure={configureView}
            onManage={() => navigate("/settings/sidebar")}
            onClose={() => setMenu(null)}
          />
        )}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    )
  }

  // ── expanded sidebar ─────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen bg-gray-50">
      {loaders}
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center justify-between px-4 py-4">
          <span className="text-lg font-semibold text-gray-900">Kingsmaker</span>
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

        {editing && draft ? (
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            <p className="mb-2 px-1 text-xs text-gray-400">
              Editing <span className="font-medium text-gray-600">{activeView.name}</span>
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
              <p className="px-3 py-2 text-xs text-gray-400">
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
          <div className="border-t border-gray-100 p-2">
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
          <div className="flex justify-center gap-1 overflow-x-auto border-t border-gray-100 p-2">
            {pagerViews.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setActiveViewId(v.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ id: v.id, x: e.clientX, y: e.clientY })
                }}
                // Icon-only — the name surfaces as a hover/aria tooltip.
                title={v.name}
                aria-label={v.name}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                  v.id === activeView.id
                    ? "bg-gray-900 text-white"
                    : "text-gray-500 hover:bg-gray-100",
                )}
              >
                <ConceptIcon value={v.icon || "lucide:LayoutGrid"} size={16} />
              </button>
            ))}
          </div>
        ) : null}

        <div className="border-t border-gray-100 p-2">
          <OrgSwitcher />
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-gray-50">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gray-700 to-gray-900 text-xs font-semibold text-white">
              {initialsOf(data?.user.name, data?.user.email ?? "")}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium text-gray-900">
                {data?.user.name?.trim() || data?.user.email}
              </div>
              {data?.user.name?.trim() && (
                <div className="truncate text-xs text-gray-500">{data?.user.email}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => signOut().then(() => location.reload())}
              title="Sign out"
              className="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
      </main>

      {menu && (
        <ViewMenu
          menu={menu}
          onConfigure={configureView}
          onManage={() => navigate("/settings/sidebar")}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** Right-click menu for a pager chip: configure this view, or jump to settings. */
function ViewMenu({
  menu,
  onConfigure,
  onManage,
  onClose,
}: {
  menu: { id: string; x: number; y: number }
  onConfigure: (id: string) => void
  onManage: () => void
  onClose: () => void
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        className="fixed z-50 w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => onConfigure(menu.id)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
        >
          <Pencil size={14} /> Configure
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            onManage()
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
        >
          <Settings2 size={14} /> Manage in settings…
        </button>
      </div>
    </>
  )
}

/** Up to two initials from a name, falling back to the email's first letter. */
function initialsOf(name: string | null | undefined, email: string) {
  const source = name?.trim() || email
  const letters = source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
  return (letters || email[0] || "?").toUpperCase()
}
