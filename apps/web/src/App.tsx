import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { Layout } from "./components/Layout"
import { ErrorScreen, Spinner } from "./components/ui"
import { useSession } from "./lib/auth-client"
import { AuthPage } from "./pages/AuthPage"
import { Dashboards } from "./pages/Dashboards"
import { InstanceView } from "./pages/InstanceView"
import { MemberProfile } from "./pages/MemberProfile"
import { MembersDirectory } from "./pages/MembersDirectory"
import { Overview } from "./pages/Overview"
import { Placeholder } from "./pages/Placeholder"
import { Concepts } from "./pages/settings/Concepts"
import { Dashboards as DashboardsSettings } from "./pages/settings/Dashboards"
import { Labels } from "./pages/settings/Labels"
import { Organization } from "./pages/settings/Organization"
import { Profile } from "./pages/settings/Profile"
import { SettingsLayout } from "./pages/settings/SettingsLayout"
import { Views } from "./pages/settings/Views"
import { Tasks } from "./pages/Tasks"

// Dev playground — code-split so the lab page and its intro animations cost
// the main bundle nothing; each intro is itself lazy-loaded on first play.
const IntroLab = lazy(() => import("./pages/IntroLab").then((m) => ({ default: m.IntroLab })))

export function App() {
  const { data: session, isPending, error, isRefetching, refetch } = useSession()

  if (isPending) return <Spinner />
  // A populated `error` means the session request failed (server unreachable) —
  // distinct from an unauthenticated 200 (no error, no data → AuthPage).
  if (error) return <ErrorScreen onRetry={() => void refetch()} retrying={isRefetching} />
  if (!session) return <AuthPage />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/dashboards" element={<Dashboards />} />
        <Route path="/dashboards/:id" element={<Dashboards />} />
        <Route path="/members" element={<MembersDirectory />} />
        <Route path="/members/:userId" element={<MemberProfile />} />
        <Route path="/automations" element={<Placeholder title="Automations" />} />
        <Route
          path="/intro-lab"
          element={
            <Suspense fallback={null}>
              <IntroLab />
            </Suspense>
          }
        />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<Profile />} />
          <Route path="security" element={<Navigate to="/settings/profile" replace />} />
          <Route path="organization" element={<Organization />} />
          <Route path="members" element={<Navigate to="/members" replace />} />
          <Route path="concepts" element={<Concepts />} />
          <Route path="concepts-graph" element={<Navigate to="/settings/concepts" replace />} />
          <Route path="labels" element={<Labels />} />
          <Route path="sidebar" element={<Views />} />
          <Route path="dashboards" element={<DashboardsSettings />} />
        </Route>
        <Route path="/instances/:id" element={<InstanceView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
