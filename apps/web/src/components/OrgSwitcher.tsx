import { useQuery } from "@tanstack/react-query"
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react"
import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { authClient } from "../lib/auth-client"
import { cn } from "../lib/utils"
import { useFullOrg } from "../pages/settings/SettingsLayout"
import { CreateOrgModal } from "./CreateOrgModal"

/** Sidebar org switcher: lists the orgs you belong to, lets you switch the
 *  active one (BetterAuth `setActive` → full reload re-scopes all data), and
 *  opens the create-org dialog. Built on the shadcn {@link DropdownMenu}, which
 *  owns open state, outside-click, Escape, and keyboard navigation. */
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

  const [showCreate, setShowCreate] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const currentId = current.data?.id

  const switchTo = async (id: string) => {
    if (id === currentId) return
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Building2 size={16} />
          </div>
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">
            {current.data?.name ?? "Organization"}
          </span>
          <ChevronsUpDown size={15} className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        >
          {orgs.isPending && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>}
          {orgs.error && (
            <p className="px-2 py-1.5 text-xs text-destructive">Couldn't load organizations.</p>
          )}
          {switchError && <p className="px-2 py-1.5 text-xs text-destructive">{switchError}</p>}
          {orgs.data?.map((o) => {
            const active = o.id === currentId
            return (
              <DropdownMenuItem
                key={o.id}
                disabled={switching}
                onSelect={() => switchTo(o.id)}
                className={cn(active && "font-medium")}
              >
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {active && <Check size={14} className="shrink-0 text-muted-foreground" />}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setShowCreate(true)}>
            <Plus size={14} className="shrink-0 text-muted-foreground" />
            Create new organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} />}
    </>
  )
}
