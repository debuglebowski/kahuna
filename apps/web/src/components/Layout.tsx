import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LogOut } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { api } from "../lib/api"
import { signOut, useSession } from "../lib/auth-client"
import { cn } from "../lib/utils"

const GLOBAL: ReadonlyArray<readonly [string, string]> = [
  ["/", "Overview"],
  ["/dashboards", "Dashboards"],
  ["/automations", "Automations"],
  ["/settings", "Settings"],
]

/** A concept's nav target — Account keeps its bespoke hub experience. */
const conceptHref = (name: string) =>
  name === "Account" ? "/accounts" : `/concepts/${encodeURIComponent(name)}`

function NavItem({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        "block rounded-md px-3 py-1.5 text-sm",
        active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100",
      )}
    >
      {label}
    </Link>
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
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")

  const concepts = useQuery({
    queryKey: ["concepts"],
    queryFn: () => api.listConcepts(),
  })

  const createConcept = useMutation({
    mutationFn: (n: string) => api.createConcept(n),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["concepts"] })
      setCreating(false)
      setName("")
      navigate(conceptHref(c.name))
    },
  })

  const submitNewConcept = () => {
    const trimmed = name.trim()
    if (trimmed) createConcept.mutate(trimmed)
  }

  const isActive = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to))

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="px-4 py-4 text-lg font-semibold text-gray-900">Kingsmaker</div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {GLOBAL.map(([to, label]) => (
            <NavItem key={to} to={to} label={label} active={isActive(to)} />
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

          {concepts.data?.length === 0 && !creating && (
            <p className="px-3 py-1 text-xs text-gray-400">No concepts yet.</p>
          )}
          {concepts.data?.map((c) => {
            const href = conceptHref(c.name)
            return <NavItem key={c.id} to={href} label={c.name} active={loc.pathname === href} />
          })}
        </nav>

        <div className="border-t border-gray-100 p-2">
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
