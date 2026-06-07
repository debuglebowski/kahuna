import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
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
          <SectionLabel>Global</SectionLabel>
          {GLOBAL.map(([to, label]) => (
            <NavItem key={to} to={to} label={label} active={isActive(to)} />
          ))}

          <SectionLabel
            action={
              <button
                type="button"
                onClick={() => setCreating((v) => !v)}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                title="New concept"
              >
                <Plus size={14} />
              </button>
            }
          >
            Concepts
          </SectionLabel>

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

        <div className="border-t border-gray-100 px-3 py-3 text-xs text-gray-500">
          <div className="truncate">{data?.user.email}</div>
          <button
            type="button"
            onClick={() => signOut().then(() => location.reload())}
            className="mt-1 text-gray-400 hover:text-gray-700 hover:underline"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
      </main>
    </div>
  )
}
