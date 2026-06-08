import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import {
  Home,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Workflow,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { api } from "../lib/api"
import { signOut, useSession } from "../lib/auth-client"
import { conceptsCollection, KEY, useRegisterCollection } from "../lib/collections"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "../lib/icons"
import { useLiveSync } from "../lib/useLiveSync"
import { useSafetyRefetch } from "../lib/useSafetyRefetch"
import { cn } from "../lib/utils"
import { OrgSwitcher } from "./OrgSwitcher"
import { IconButton } from "./ui"

/** Remember whether the user minimized the sidebar across reloads. */
const SIDEBAR_KEY = "km.sidebar.collapsed"
const readCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1"
  } catch {
    return false
  }
}

const GLOBAL: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "/", label: "Overview", icon: Home },
  { to: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
  { to: "/automations", label: "Automations", icon: Workflow },
  { to: "/settings", label: "Settings", icon: Settings },
]

/** A concept's nav target — every concept browses through the generic view. */
const conceptHref = (id: string) => `/concepts/${id}`

function NavItem({
  to,
  label,
  icon,
  active,
  collapsed,
}: {
  to: string
  label: string
  icon: ReactNode
  active: boolean
  collapsed: boolean
}) {
  return (
    <Link
      to={to}
      // When collapsed the label is hidden, so surface it as a hover tooltip.
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center rounded-md text-sm",
        collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-1.5",
        active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  )
}

/** A concept's nav glyph — its chosen icon, or the shared default when unset. */
function conceptGlyph(icon: string | null): ReactNode {
  return <ConceptIcon value={icon || DEFAULT_CONCEPT_ICON} size={16} />
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

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-5 mb-1 flex items-center justify-between px-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {children}
      </span>
      {action}
    </div>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { data } = useSession()
  const loc = useLocation()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggleSidebar = () =>
    setCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0")
      } catch {}
      return next
    })

  // Mount the single live-sync connection + safety backstop here (Layout wraps
  // every authed page). The concepts sidebar is a live query.
  useLiveSync()
  useSafetyRefetch()
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const { data: concepts } = useLiveQuery((q) => q.from({ c: conceptsCollection }))

  const createConcept = useMutation({
    mutationFn: (n: string) => api.createConcept(n),
    onSuccess: (c) => {
      void conceptsCollection.utils.refetch()
      setCreating(false)
      setName("")
      navigate(conceptHref(c.id))
    },
  })

  const submitNewConcept = () => {
    const trimmed = name.trim()
    if (trimmed) createConcept.mutate(trimmed)
  }

  const isActive = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to))

  if (collapsed) {
    return (
      <div className="flex min-h-screen bg-gray-50">
        <aside className="flex w-12 shrink-0 flex-col border-r border-gray-200 bg-white">
          <div className="flex justify-center py-4">
            <IconButton onClick={toggleSidebar} aria-label="Expand sidebar">
              <PanelLeftOpen size={18} />
            </IconButton>
          </div>
          <nav className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-4">
            {GLOBAL.map(({ to, label, icon: Icon }) => (
              <NavItem
                key={to}
                to={to}
                label={label}
                icon={<Icon size={16} />}
                active={isActive(to)}
                collapsed
              />
            ))}
            {concepts && concepts.length > 0 && (
              <div className="mx-2 my-2 border-t border-gray-100" />
            )}
            {concepts?.map((c) => {
              const href = conceptHref(c.id)
              return (
                <NavItem
                  key={c.id}
                  to={href}
                  label={c.name}
                  icon={conceptGlyph(c.icon)}
                  active={loc.pathname === href}
                  collapsed
                />
              )
            })}
          </nav>
        </aside>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center justify-between px-4 py-4">
          <span className="text-lg font-semibold text-gray-900">Kingsmaker</span>
          <IconButton onClick={toggleSidebar} aria-label="Collapse sidebar">
            <PanelLeftClose size={18} />
          </IconButton>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {GLOBAL.map(({ to, label, icon: Icon }) => (
            <NavItem
              key={to}
              to={to}
              label={label}
              icon={<Icon size={16} />}
              active={isActive(to)}
              collapsed={false}
            />
          ))}

          <SectionLabel>Concepts</SectionLabel>

          {creating && (
            <div className="px-1 pb-1">
              <input
                // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened.
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNewConcept()
                  if (e.key === "Escape") {
                    setCreating(false)
                    setName("")
                  }
                }}
                onBlur={() => !name.trim() && setCreating(false)}
                placeholder="New concept name…"
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm outline-none focus:border-gray-500"
              />
              {createConcept.isError && (
                <p className="px-1 pt-1 text-xs text-red-600">
                  {(createConcept.error as Error).message}
                </p>
              )}
            </div>
          )}

          {concepts?.length === 0 && !creating && (
            <p className="px-3 py-1 text-xs text-gray-400">No concepts yet.</p>
          )}
          {concepts?.map((c) => {
            const href = conceptHref(c.id)
            return (
              <NavItem
                key={c.id}
                to={href}
                label={c.name}
                icon={conceptGlyph(c.icon)}
                active={loc.pathname === href}
                collapsed={false}
              />
            )
          })}
        </nav>

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
    </div>
  )
}
