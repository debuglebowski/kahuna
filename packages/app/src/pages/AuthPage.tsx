import { type FormEvent, useEffect, useState } from "react"
import { Button, Card, Field, Input, Spinner } from "../components/ui"
import type { AuthMethods } from "../lib/api"
import { api } from "../lib/api"
import { authClient } from "../lib/auth-client"

/**
 * Sign-in only. There is deliberately no sign-up: self-serve registration is
 * closed server-side (`emailAndPassword.disableSignUp`, see server/auth.ts)
 * because this deploys internally. Accounts are provisioned by an operator
 * (`scripts/create-user.ts`) and then added to an org by an admin in
 * Settings → Members — or, when the org has SSO on, by signing in through its
 * identity provider for the first time.
 *
 * The page renders only the methods the deployment actually accepts, fetched
 * anonymously from `/api/auth-config/public`. That is safe because there is one
 * org per deployment (`createOrgDirect`), so the answer is a property of the
 * whole install and is not keyed on the address typed here — asking cannot
 * reveal whether a given account exists.
 *
 * THE PASSWORD FORM IS ALWAYS REACHABLE, even when password sign-in is off: org
 * owners keep password access unconditionally (see `passwordSignInAllowed`), and
 * that break-glass is worthless if a broken IdP also removes the only UI that
 * can use it. So when SSO is the only advertised method the form is collapsed
 * behind a link rather than removed.
 */
export function AuthPage() {
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ssoBusy, setSsoBusy] = useState(false)
  const [showPasswordForm, setShowPasswordForm] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.getPublicAuthMethods().then((m) => {
      if (!cancelled) setMethods(m)
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  // Wait for the answer rather than flashing the wrong form and swapping it.
  if (!methods) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40">
        <Spinner />
      </div>
    )
  }

  const ssoOnly = methods.ssoEnabled && !methods.passwordEnabled
  const passwordVisible = methods.passwordEnabled || showPasswordForm

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-foreground">Kingsmaker</h1>
        <p className="mb-4 text-sm text-muted-foreground">Sign in to your org</p>

        <form onSubmit={submit} className="space-y-3">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          {passwordVisible && (
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </Field>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {passwordVisible && (
            <Button type="submit" className="w-full" disabled={busy || ssoBusy}>
              {busy ? "…" : "Sign in"}
            </Button>
          )}
        </form>

        {methods.ssoEnabled && (
          <>
            {passwordVisible && (
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <Button
              type="button"
              // The only advertised method leads; alongside a password form it
              // is the alternative.
              variant={ssoOnly && !showPasswordForm ? "default" : "outline"}
              className={passwordVisible ? "w-full" : "mt-3 w-full"}
              disabled={busy || ssoBusy}
              onClick={ssoSignIn}
            >
              {ssoBusy ? "…" : "Sign in with SSO"}
            </Button>
          </>
        )}

        {ssoOnly && !showPasswordForm && (
          <button
            type="button"
            className="mt-3 w-full text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowPasswordForm(true)}
          >
            Sign in with a password instead
          </button>
        )}
        {ssoOnly && showPasswordForm && (
          <p className="mt-3 text-xs text-muted-foreground">
            This organization signs in with SSO. Password sign-in is available to organization
            owners only.
          </p>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          Need an account? Ask an administrator to create one for you.
        </p>
      </Card>
    </div>
  )
}
