import { Navigate, Route, Routes } from "react-router-dom"
import { Layout } from "./components/Layout"
import { Spinner } from "./components/ui"
import { useSession } from "./lib/auth-client"
import { AccountDetail } from "./pages/AccountDetail"
import { Accounts } from "./pages/Accounts"
import { AuthPage } from "./pages/AuthPage"
import { Browse } from "./pages/Browse"
import { Dashboard } from "./pages/Dashboard"

export function App() {
  const { data: session, isPending } = useSession()

  if (isPending) return <Spinner />
  if (!session) return <AuthPage />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:id" element={<AccountDetail />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
