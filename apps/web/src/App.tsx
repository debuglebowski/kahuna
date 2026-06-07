import { Navigate, Route, Routes } from "react-router-dom"
import { Layout } from "./components/Layout"
import { Spinner } from "./components/ui"
import { useSession } from "./lib/auth-client"
import { AccountDetail } from "./pages/AccountDetail"
import { Accounts } from "./pages/Accounts"
import { AuthPage } from "./pages/AuthPage"
import { ConceptView } from "./pages/ConceptView"
import { Dashboard } from "./pages/Dashboard"
import { Placeholder } from "./pages/Placeholder"

export function App() {
  const { data: session, isPending } = useSession()

  if (isPending) return <Spinner />
  if (!session) return <AuthPage />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/dashboards" element={<Placeholder title="Dashboards" />} />
        <Route path="/automations" element={<Placeholder title="Automations" />} />
        <Route path="/settings" element={<Placeholder title="Settings" />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:id" element={<AccountDetail />} />
        <Route path="/concepts/:name" element={<ConceptView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
