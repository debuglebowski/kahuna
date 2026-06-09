import { useQuery } from "@tanstack/react-query"
import { Check, ChevronsUpDown, LogOut, Plus, Settings } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { authClient, signOut, useSession } from "../lib/auth-client"
import { cn, initialsOf } from "../lib/utils"
import { useFullOrg } from "../pages/settings/SettingsLayout"
import { CreateOrgModal } from "./CreateOrgModal"

/** Sidebar footer identity menu — the single resting affordance at the bottom of
 *  the sidebar. The trigger shows who you are (avatar + name) and where you are
 *  (active org); one click opens a menu that folds together org switching
 *  (BetterAuth `setActive` → full reload re-scopes all data), org creation, and
 *  account actions (settings, sign out). Built on the shadcn {@link DropdownMenu},
 *  which owns open state, outside-click, Escape, and keyboard navigation. */
export function IdentityMenu() {
  const navigate = useNavigate()
  const { data: session } = useSession()
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
  const user = session?.user
  const name = user?.name?.trim() || user?.email || "Account"
  const email = user?.email ?? ""

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

  const avatar = (
    <Avatar>
      <AvatarImage src={user?.image ?? undefined} alt="" />
      <AvatarFallback>{initialsOf(user?.name, email)}</AvatarFallback>
    </Avatar>
  )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-sidebar-accent">
          {avatar}
          <div className="min-w-0 flex-1 text-left leading-tight">
            <div className="truncate text-sm font-medium text-sidebar-foreground">{name}</div>
            <div className="truncate text-xs text-sidebar-foreground/70">
              {current.data?.name ?? "Organization"}
            </div>
          </div>
          <ChevronsUpDown size={15} className="shrink-0 text-sidebar-foreground/70" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        >
          <DropdownMenuLabel className="flex items-center gap-2 p-2 font-normal">
            {avatar}
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-medium">{name}</div>
              {email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Organization
          </DropdownMenuLabel>
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
          <DropdownMenuItem onSelect={() => setShowCreate(true)}>
            <Plus size={14} />
            New organization
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/settings/profile")}>
            <Settings size={14} />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => signOut().then(() => location.reload())}
          >
            <LogOut size={14} />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} />}
    </>
  )
}
