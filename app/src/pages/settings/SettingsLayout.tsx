import { useQuery } from "@tanstack/react-query"
import {
  Building2,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  PanelLeft,
  Plug,
  Shapes,
  ShieldCheck,
  Tags,
  UserRound,
  Users,
  Workflow,
} from "lucide-react"
import type { ReactNode } from "react"
import { Navigate, Outlet, useLocation } from "react-router-dom"
import { Spinner } from "../../components/ui"
import { api } from "../../lib/api"
import { authClient } from "../../lib/auth-client"

interface SettingsItem {
  readonly to: string
  readonly label: string
  readonly admin: boolean
  readonly icon: ReactNode
  /** Render this section as a full-height flex column (heading fixed, Outlet
   *  fills) so the page can pin a footer or own its scroll. The page must also
   *  request `usePageChrome({ fillHeight: true })`. Default: normal flow. */
  readonly fillHeight?: boolean
  /** This section also renders at a top-level url (`/members`, `/automations`)
   *  from the same implementation. It owns its own heading and, for a detail
   *  route, its own chrome — so the layout renders it bare rather than wrapping
   *  it in the section `<h2>`. See `useSectionBase`. */
  readonly dual?: boolean
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
  // Who gets into the org, what they may do, and what it is wired to.
  {
    title: "Organization",
    items: [
      { to: "organization", label: "Organization", admin: true, icon: <Building2 size={16} /> },
      // `admin` is the coarse route gate; the page itself narrows writes to the
      // OWNER, because this decides who can get into the org at all.
      { to: "authentication", label: "Authentication", admin: true, icon: <KeyRound size={16} /> },
      // Members renders at TWO urls from one implementation: here, and at its own
      // top-level GLOBAL_NAV slot. Both are real routes (see App.tsx) — not links
      // out — so entering through settings keeps the settings sidebar. `dual`
      // marks them for the route guard below. Automations is the other one.
      { to: "members", label: "Members", admin: false, icon: <Users size={16} />, dual: true },
      // The rules inside a role are the sensitive half of the access model, so this
      // tab is admin-only — unlike Members, where role NAMES are org vocabulary.
      { to: "roles", label: "Roles", admin: true, icon: <ShieldCheck size={16} /> },
      { to: "integrations", label: "Integrations", admin: false, icon: <Plug size={16} /> },
    ],
  },
  // What the org's data, views and behaviour look like.
  {
    title: "Workspace",
    items: [
      { to: "concepts", label: "Concepts", admin: false, icon: <Shapes size={16} /> },
      { to: "labels", label: "Labels", admin: false, icon: <Tags size={16} /> },
      { to: "tasks", label: "Tasks", admin: false, icon: <ListTodo size={16} /> },
      {
        to: "dashboards",
        label: "Dashboards",
        admin: false,
        icon: <LayoutDashboard size={16} />,
        fillHeight: true,
      },
      { to: "sidebar", label: "Sidebar", admin: false, icon: <PanelLeft size={16} /> },
      {
        to: "automations",
        label: "Automations",
        admin: false,
        icon: <Workflow size={16} />,
        dual: true,
      },
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

/**
 * My admin-ness in the active org — the settings guard, the settings sidebar nav,
 * and the two directories that hide admin-only affordances.
 *
 * ── WHY THIS IS A SERVER ANSWER NOW ──────────────────────────────────────────
 *
 * It used to be `role === "owner" || role === "admin"`, computed here from the
 * membership list. Admin is an ordinary access role: an org can grant org
 * configuration to a role of its own making, and membership will not carry `admin`
 * at all after the collapse — so the client cannot work it out. It also must not
 * try: the rules that decide it are `configure`-gated, which is the very question
 * being asked.
 *
 * The server answers about the CALLER only, so this leaks nothing.
 */
export function useIsAdmin() {
  const q = useQuery({ queryKey: ["myAccess"], queryFn: () => api.myAccess() })
  return { admin: q.data?.canConfigure ?? false, isPending: q.isPending }
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

  // A `dual` section is a whole page in its own right (it also renders at a
  // top-level url), so it brings its own heading — wrapping it in the section
  // <h2> would show the title twice.
  if (item?.dual) return <Outlet context={{ admin }} />

  return (
    <div className="space-y-5">
      {item && <h2 className="text-2xl font-bold tracking-tight text-foreground">{item.label}</h2>}
      <Outlet context={{ admin }} />
    </div>
  )
}
