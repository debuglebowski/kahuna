import { type FormEvent, useState } from "react"
import { Button, Card, Field, Input } from "../components/ui"
import { authClient } from "../lib/auth-client"
import { makeOrgSlug } from "../lib/org"

export function AuthPage() {
  const [mode, setMode] = useState<"in" | "up">("in")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [org, setOrg] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === "in") {
        const r = await authClient.signIn.email({ email, password })
        if (r.error) throw new Error(r.error.message ?? "Sign-in failed")
      } else {
        const r = await authClient.signUp.email({ email, password, name })
        if (r.error) throw new Error(r.error.message ?? "Sign-up failed")
        const created = await authClient.organization.create({
          name: org || "My Org",
          slug: makeOrgSlug(org || "My Org"),
        })
        if (created.error || !created.data)
          throw new Error(created.error?.message ?? "Org create failed")
        await authClient.organization.setActive({ organizationId: created.data.id })
        // Concepts are seeded server-side by the org-creation hook (see auth.ts).
      }
      location.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-lg font-semibold text-gray-900">Kingsmaker</h1>
        <p className="mb-4 text-sm text-gray-500">
          {mode === "in" ? "Sign in to your org" : "Create your account and org"}
        </p>
        <form onSubmit={submit} className="space-y-3">
          {mode === "up" && (
            <Field label="Your name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
          )}
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </Field>
          {mode === "up" && (
            <Field label="Organization name">
              <Input value={org} onChange={(e) => setOrg(e.target.value)} required />
            </Field>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <button
          type="button"
          className="mt-3 text-sm text-gray-500 underline"
          onClick={() => setMode(mode === "in" ? "up" : "in")}
        >
          {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </Card>
    </div>
  )
}
