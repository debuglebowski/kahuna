import { useQuery } from "@tanstack/react-query"
import { Link, Navigate, Outlet, useLocation } from "react-router-dom"
import { Spinner } from "../../components/ui"
import { authClient, useSession } from "../../lib/auth-client"
import { cn } from "../../lib/utils"

interface Tab {
  readonly to: string
  readonly label: string
  readonly admin: boolean
}

const TABS: ReadonlyArray<Tab> = [
  { to: "profile", label: "Profile", admin: false },
  { to: "organization", label: "Organization", admin: true },
  { to: "members", label: "Members", admin: true },
  { to: "concepts", label: "Concepts", admin: false },
  { to: "labels", label: "Labels", admin: false },
]

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

export function SettingsLayout() {
  const { data: session } = useSession()
  const loc = useLocation()
  const org = useFullOrg()

  if (org.isPending) return <Spinner />

  const myRole = org.data?.members?.find((m) => m.userId === session?.user.id)?.role
  const admin = isAdminRole(myRole)
  const tabs = TABS.filter((t) => !t.admin || admin)

  // Soft-guard direct navigation to an admin section by a non-admin member.
  const seg = loc.pathname.split("/")[2] ?? ""
  const onHiddenTab = TABS.some((t) => t.to === seg && t.admin) && !admin
  if (onHiddenTab) return <Navigate to="/settings/profile" replace />

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold text-gray-900">Settings</h2>
      <nav className="flex gap-1 border-b border-gray-200">
        {tabs.map((t) => {
          const active = seg === t.to
          return (
            <Link
              key={t.to}
              to={t.to}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                active
                  ? "border-gray-900 text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800",
              )}
            >
              {t.label}
            </Link>
          )
        })}
      </nav>
      <Outlet context={{ admin }} />
    </div>
  )
}
