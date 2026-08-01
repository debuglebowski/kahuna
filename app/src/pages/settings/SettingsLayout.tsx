import { useQuery } from "@tanstack/react-query"
import {
  Building2,
  LayoutDashboard,
  ListTodo,
  PanelLeft,
  Plug,
  Shapes,
  Tags,
  UserRound,
  Workflow,
} from "lucide-react"
import type { ReactNode } from "react"
import { Navigate, Outlet, useLocation } from "react-router-dom"
import { Spinner } from "../../components/ui"
import { authClient, useSession } from "../../lib/auth-client"

interface SettingsItem {
  readonly to: string
  readonly label: string
  readonly admin: boolean
  readonly icon: ReactNode
  /** Render this section as a full-height flex column (heading fixed, Outlet
   *  fills) so the page can pin a footer or own its scroll. The page must also
   *  request `usePageChrome({ fillHeight: true })`. Default: normal flow. */
  readonly fillHeight?: boolean
  /** An absolute path OUTSIDE /settings that this entry links to. For a section
   *  that lives at the top level but still belongs in the settings menu (see
   *  Automations): the nav shows it here, the click leaves /settings. */
  readonly external?: string
}

interface SettingsGroup {
  readonly title: string
  readonly items: ReadonlyArray<SettingsItem>
}

/** The settings nav — rendered by Layout as the sidebar while under /settings,
 *  and the source of truth for the admin route guard here. */
export const SETTINGS_NAV: ReadonlyArray<SettingsGroup> = [
  {
    title: "Account",
    items: [{ to: "profile", label: "Profile", admin: false, icon: <UserRound size={16} /> }],
  },
  {
    title: "Organization",
    items: [
      { to: "organization", label: "Organization", admin: true, icon: <Building2 size={16} /> },
      { to: "concepts", label: "Concepts", admin: false, icon: <Shapes size={16} /> },
      {
        to: "dashboards",
        label: "Dashboards",
        admin: false,
        icon: <LayoutDashboard size={16} />,
        fillHeight: true,
      },
      { to: "sidebar", label: "Sidebar", admin: false, icon: <PanelLeft size={16} /> },
      { to: "tasks", label: "Tasks", admin: false, icon: <ListTodo size={16} /> },
      { to: "labels", label: "Labels", admin: false, icon: <Tags size={16} /> },
      // Automations also have a top-level page (their own GLOBAL_NAV slot) — this
      // entry is the settings-side door to the same list, like Concepts. The
      // `external` target keeps ONE implementation rather than a second copy.
      {
        to: "automations",
        label: "Automations",
        admin: false,
        icon: <Workflow size={16} />,
        external: "/automations",
      },
      { to: "integrations", label: "Integrations", admin: false, icon: <Plug size={16} /> },
    ],
  },
]

const ALL_ITEMS = SETTINGS_NAV.flatMap((g) => g.items)

/** Active org + my membership — drives both the role gate and the Org/Members pages. */
export function useFullOrg() {
  return useQuery({
    queryKey: ["fullOrg"],
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization()
      if (error) throw new Error(error.message ?? "Failed to load organization")
      return data
    },
  })
}

export function isAdminRole(role: string | null | undefined) {
  return role === "owner" || role === "admin"
}

/** My admin-ness in the active org — shared by the settings guard and the
 *  settings sidebar nav (which hides admin-only entries). */
export function useIsAdmin() {
  const { data: session } = useSession()
  const org = useFullOrg()
  const myRole = org.data?.members?.find((m) => m.userId === session?.user.id)?.role
  return { admin: isAdminRole(myRole), isPending: org.isPending }
}

export function SettingsLayout() {
  const loc = useLocation()
  const { admin, isPending } = useIsAdmin()

  if (isPending) return <Spinner />

  // Soft-guard direct navigation to an admin section by a non-admin member.
  const parts = loc.pathname.split("/")
  const seg = parts[2] ?? ""
  const item = ALL_ITEMS.find((t) => t.to === seg)
  if (item?.admin && !admin) return <Navigate to="/settings/profile" replace />

  // Detail routes (e.g. /settings/dashboards/:id) are full-page editors that
  // own their chrome + breadcrumb — render the Outlet bare so it can fill the
  // height (the section <h2> wrapper would duplicate the heading and break it).
  if (parts.length > 3 && parts[3]) return <Outlet context={{ admin }} />

  // Full-height sections (e.g. Dashboards, which pins a footer) get a flex column
  // with a fixed heading and a height-filling Outlet instead of normal flow.
  if (item?.fillHeight) {
    return (
      <div className="flex h-full flex-col gap-5">
        <h2 className="shrink-0 text-2xl font-bold tracking-tight text-foreground">{item.label}</h2>
        <div className="min-h-0 flex-1">
          <Outlet context={{ admin }} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {item && <h2 className="text-2xl font-bold tracking-tight text-foreground">{item.label}</h2>}
      <Outlet context={{ admin }} />
    </div>
  )
}
