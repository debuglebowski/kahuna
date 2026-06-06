import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { signOut, useSession } from "../lib/auth-client"
import { cn } from "../lib/utils"
import { Button } from "./ui"

const NAV: ReadonlyArray<readonly [string, string]> = [
  ["/", "Dashboard"],
  ["/accounts", "Accounts"],
  ["/browse", "Browse"],
]

export function Layout({ children }: { children: ReactNode }) {
  const { data } = useSession()
  const loc = useLocation()
  const isActive = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to))

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-gray-900">Kingsmaker</span>
            <nav className="flex gap-1">
              {NAV.map(([to, label]) => (
                <Link
                  key={to}
                  to={to}
                  className={cn(
                    "rounded px-3 py-1.5 text-sm font-medium",
                    isActive(to) ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100",
                  )}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <span>{data?.user.email}</span>
            <Button variant="ghost" onClick={() => signOut().then(() => location.reload())}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
