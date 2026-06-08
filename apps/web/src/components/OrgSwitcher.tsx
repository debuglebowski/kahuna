import { useQuery } from "@tanstack/react-query"
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { authClient } from "../lib/auth-client"
import { cn } from "../lib/utils"
import { useFullOrg } from "../pages/settings/SettingsLayout"
import { CreateOrgModal } from "./CreateOrgModal"

/** Sidebar org switcher: lists the orgs you belong to, lets you switch the
 *  active one (BetterAuth `setActive` → full reload re-scopes all data), and
 *  opens the create-org dialog. Available to every member. */
export function OrgSwitcher() {
  const current = useFullOrg()
  const orgs = useQuery({
    queryKey: ["orgList"],
    queryFn: async () => {
      const { data, error } = await authClient.organization.list()
      if (error) throw new Error(error.message ?? "Failed to load organizations")
      return data ?? []
    },
  })

  const [open, setOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  // Close the menu on Escape, mirroring the Modal/Drawer primitives.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  const currentId = current.data?.id

  const switchTo = async (id: string) => {
    if (id === currentId) {
      setOpen(false)
      return
    }
    setSwitching(true)
    setSwitchError(null)
    const { error } = await authClient.organization.setActive({ organizationId: id })
    if (error) {
      setSwitchError(error.message ?? "Failed to switch organization")
      setSwitching(false)
      return
    }
    window.location.reload()
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-gray-50"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600">
          <Building2 size={16} />
        </div>
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-gray-900">
          {current.data?.name ?? "Organization"}
        </span>
        <ChevronsUpDown size={15} className="shrink-0 text-gray-400" />
      </button>

      {open && (
        <>
          {/* Outside-click closes the menu; a real button keeps it keyboard-accessible. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          >
            {orgs.isPending && <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>}
            {orgs.error && (
              <p className="px-3 py-2 text-xs text-red-600">Couldn't load organizations.</p>
            )}
            {switchError && <p className="px-3 py-2 text-xs text-red-600">{switchError}</p>}
            {orgs.data?.map((o) => {
              const active = o.id === currentId
              return (
                <button
                  key={o.id}
                  type="button"
                  role="menuitem"
                  disabled={switching}
                  onClick={() => switchTo(o.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:opacity-50",
                    active ? "font-medium text-gray-900" : "text-gray-600",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {active && <Check size={14} className="shrink-0 text-gray-500" />}
                </button>
              )
            })}
            <div className="my-1 border-t border-gray-100" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setShowCreate(true)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-50"
            >
              <Plus size={14} className="shrink-0 text-gray-400" />
              Create new organization
            </button>
          </div>
        </>
      )}

      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}
