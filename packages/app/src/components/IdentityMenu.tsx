import { ChevronRight, LogOut, Settings } from "lucide-react"
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
import { signOut, useSession } from "../lib/auth-client"
import { initialsOf } from "../lib/utils"
import { useFullOrg } from "../pages/settings/SettingsLayout"

/** Sidebar footer identity menu — the single resting affordance at the bottom of
 *  the sidebar. The trigger shows who you are (avatar + name) and where you are
 *  (the org); one click opens account actions (settings, sign out). Built on the
 *  shadcn {@link DropdownMenu}, which owns open state, outside-click, Escape, and
 *  keyboard navigation.
 *
 *  There is no org switcher and no "new organization": a deployment holds exactly
 *  one org (`createOrgDirect` in server/provision.ts refuses a second), so the
 *  org name here is a label, not a control. */
export function IdentityMenu() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const current = useFullOrg()

  const user = session?.user
  const name = user?.name?.trim() || user?.email || "Account"
  const email = user?.email ?? ""

  const avatar = (
    <Avatar>
      <AvatarImage src={user?.image ?? undefined} alt="" />
      <AvatarFallback>{initialsOf(user?.name, email)}</AvatarFallback>
    </Avatar>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-sidebar-accent">
        {avatar}
        <div className="min-w-0 flex-1 text-left leading-tight">
          <div className="truncate text-sm font-medium text-sidebar-foreground">{name}</div>
          <div className="truncate text-xs text-sidebar-foreground/70">
            {current.data?.name ?? "Organization"}
          </div>
        </div>
        <ChevronRight size={15} className="shrink-0 text-sidebar-foreground/70" />
      </DropdownMenuTrigger>

      <DropdownMenuContent side="right" align="end" className="min-w-56">
        <DropdownMenuLabel className="flex items-center gap-2 p-2 font-normal">
          {avatar}
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium">{name}</div>
            {email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => navigate("/settings/profile")}>
          <Settings size={14} />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => signOut().then(() => location.reload())}
        >
          <LogOut size={14} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
