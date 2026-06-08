import { Navigate, Route, Routes } from "react-router-dom"
import { Layout } from "./components/Layout"
import { ErrorScreen, Spinner } from "./components/ui"
import { useSession } from "./lib/auth-client"
import { AuthPage } from "./pages/AuthPage"
import { ConceptView } from "./pages/ConceptView"
import { Dashboard } from "./pages/Dashboard"
import { InstanceView } from "./pages/InstanceView"
import { Placeholder } from "./pages/Placeholder"
import { Concepts } from "./pages/settings/Concepts"
import { Labels } from "./pages/settings/Labels"
import { Members } from "./pages/settings/Members"
import { Organization } from "./pages/settings/Organization"
import { Profile } from "./pages/settings/Profile"
import { SettingsLayout } from "./pages/settings/SettingsLayout"

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
        <Route path="/" element={<Dashboard />} />
        <Route path="/dashboards" element={<Placeholder title="Dashboards" />} />
        <Route path="/automations" element={<Placeholder title="Automations" />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<Profile />} />
          <Route path="security" element={<Navigate to="/settings/profile" replace />} />
          <Route path="organization" element={<Organization />} />
          <Route path="members" element={<Members />} />
          <Route path="concepts" element={<Concepts />} />
          <Route path="concepts-graph" element={<Navigate to="/settings/concepts" replace />} />
          <Route path="labels" element={<Labels />} />
        </Route>
        <Route path="/concepts/:id" element={<ConceptView />} />
        <Route path="/instances/:id" element={<InstanceView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
