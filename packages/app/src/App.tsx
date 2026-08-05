import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { Layout } from "./components/Layout"
import { ErrorScreen, Spinner } from "./components/ui"
import { useSession } from "./lib/auth-client"
import { AuthPage } from "./pages/AuthPage"
import { Automations } from "./pages/Automations"
import { ConceptRecordView } from "./pages/ConceptRecordView"
import { Dashboards } from "./pages/Dashboards"
import { MemberProfile } from "./pages/MemberProfile"
import { MembersDirectory } from "./pages/MembersDirectory"
import { Overview } from "./pages/Overview"
import { RecordView } from "./pages/RecordView"
import { Appearance } from "./pages/settings/Appearance"
import { Authentication } from "./pages/settings/Authentication"
import { Concepts } from "./pages/settings/Concepts"
import { Dashboards as DashboardsSettings } from "./pages/settings/Dashboards"
import { Integrations } from "./pages/settings/Integrations"
import { Labels } from "./pages/settings/Labels"
import { Organization } from "./pages/settings/Organization"
import { Permissions } from "./pages/settings/Permissions"
import { Profile } from "./pages/settings/Profile"
import { Roles } from "./pages/settings/Roles"
import { SettingsLayout } from "./pages/settings/SettingsLayout"
import { Tasks as TasksSettings } from "./pages/settings/Tasks"
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
        <Route path="/automations" element={<Automations />} />
        <Route path="/automations/:id" element={<Automations />} />
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
          <Route path="appearance" element={<Appearance />} />
          <Route path="permissions" element={<Permissions />} />
          <Route path="security" element={<Navigate to="/settings/profile" replace />} />
          <Route path="organization" element={<Organization />} />
          <Route path="authentication" element={<Authentication />} />
          {/* Members and Automations render at TWO urls each — here and at the
              top level — from one implementation. Self-links inside them follow
              the mounted base (see `useSectionBase`), so entering through
              settings keeps you in settings. */}
          <Route path="members" element={<MembersDirectory />} />
          <Route path="members/:userId" element={<MemberProfile />} />
          <Route path="concepts" element={<Concepts />} />
          <Route path="concepts/:id" element={<Concepts />} />
          <Route path="concepts-graph" element={<Navigate to="/settings/concepts" replace />} />
          <Route path="labels" element={<Labels />} />
          <Route path="roles" element={<Roles />} />
          <Route path="tasks" element={<TasksSettings />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="sidebar" element={<Views />} />
          <Route path="sidebar/:id" element={<Views />} />
          <Route path="dashboards" element={<DashboardsSettings />} />
          <Route path="dashboards/:id" element={<DashboardsSettings />} />
          <Route path="automations" element={<Automations />} />
          <Route path="automations/:id" element={<Automations />} />
        </Route>
        <Route path="/records/:id" element={<RecordView />} />
        {/* A single-record concept's one record, addressed by slug — no recordVersion
            id, because there's only ever one. Renders the same record page. */}
        <Route path="/c/:slug" element={<ConceptRecordView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
