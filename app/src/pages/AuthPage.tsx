import { type FormEvent, useState } from "react"
import { Button, Card, Field, Input } from "../components/ui"
import { authClient } from "../lib/auth-client"

/**
 * Sign-in only. There is deliberately no sign-up: self-serve registration is
 * closed server-side (`emailAndPassword.disableSignUp`, see server/auth.ts)
 * because this deploys internally. Accounts are provisioned by an operator
 * (`scripts/create-user.ts`) and then added to an org by an admin in
 * Settings → Members — or, when the org has SSO on, by signing in through its
 * identity provider for the first time.
 *
 * BOTH methods are always offered here, regardless of what any org actually
 * accepts. Sign-in methods are per-ORG (Settings → Authentication) and there is
 * no org context before sign-in — resolving one from a typed address would mean
 * answering "does this address exist, and how does its org log in?" to anyone
 * who asks. So: offer both, and let the server's gate reject the wrong one.
 */
export function AuthPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ssoBusy, setSsoBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await authClient.signIn.email({ email, password })
      if (r.error) throw new Error(r.error.message ?? "Sign-in failed")
      location.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Hand off to the org's IdP. The provider is resolved server-side from the
   * address's DOMAIN, so the local part is irrelevant — but asking for a full
   * address is what people expect, and it doubles as the `login_hint`.
   *
   * On success this never returns: better-auth replies with a redirect the
   * client follows to the IdP.
   */
  const ssoSignIn = async () => {
    if (!email.trim()) {
      setError("Enter your email address first.")
      return
    }
    setSsoBusy(true)
    setError(null)
    try {
      const r = await authClient.signIn.sso({ email: email.trim(), callbackURL: "/" })
      if (r.error) throw new Error(r.error.message ?? "SSO is not available for this address")
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSsoBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-foreground">Kingsmaker</h1>
        <p className="mb-4 text-sm text-muted-foreground">Sign in to your org</p>
        <form onSubmit={submit} className="space-y-3">
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || ssoBusy}>
            {busy ? "…" : "Sign in"}
          </Button>
        </form>
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy || ssoBusy}
          onClick={ssoSignIn}
        >
          {ssoBusy ? "…" : "Sign in with SSO"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Need an account? Ask an administrator to create one for you.
        </p>
      </Card>
    </div>
  )
}
