import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Copy, ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Button, Card, CardHeader, Field, InfoHint, Input, Spinner } from "../../components/ui"
import { api } from "../../lib/api"
import { Feedback } from "./parts"

/**
 * Settings → Authentication. How members of THIS org sign in: an OIDC identity
 * provider, and which methods the org accepts.
 *
 * Owner-only to change (the server enforces it; `canEdit` mirrors that here so a
 * non-owner sees the configuration read-only instead of controls that 403). The
 * settings-nav entry is marked `admin`, which is the coarser gate — an admin
 * reaching this page gets the read-only view.
 *
 * SAML is not offered. OIDC covers every mainstream IdP (Google Workspace,
 * Entra, Okta, Keycloak, Authentik) and SAML would add certificate rotation and
 * metadata parsing for no additional reach.
 */

/** Read-only text + a copy button — for the redirect URI the operator has to
 *  paste into the IdP. Typing it by hand is the single easiest way to get an
 *  SSO setup subtly wrong, so it is never presented as an editable field. */
function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

export function Authentication() {
  const qc = useQueryClient()
  const cfg = useQuery({ queryKey: ["authConfig"], queryFn: api.getAuthConfig })
  const invalidate = () => qc.invalidateQueries({ queryKey: ["authConfig"] })

  const [passwordEnabled, setPasswordEnabled] = useState(true)
  const [ssoEnabled, setSsoEnabled] = useState(false)
  const [issuer, setIssuer] = useState("")
  const [domain, setDomain] = useState("")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")

  // Seed the forms once the config lands. The secret is deliberately NOT seeded
  // — the server never sends it back, so an edit always re-enters it.
  useEffect(() => {
    if (!cfg.data) return
    setPasswordEnabled(cfg.data.methods.passwordEnabled)
    setSsoEnabled(cfg.data.methods.ssoEnabled)
    setIssuer(cfg.data.provider?.issuer ?? "")
    setDomain(cfg.data.provider?.domain ?? "")
    setClientId(cfg.data.provider?.clientId ?? "")
  }, [cfg.data])

  const saveMethods = useMutation({
    mutationFn: () => api.updateAuthMethods({ passwordEnabled, ssoEnabled }),
    onSuccess: invalidate,
  })
  const saveProvider = useMutation({
    mutationFn: () => api.saveSsoProvider({ issuer, domain, clientId, clientSecret }),
    onSuccess: () => {
      setClientSecret("")
      invalidate()
    },
  })
  const removeProvider = useMutation({
    mutationFn: api.deleteSsoProvider,
    onSuccess: () => {
      setClientSecret("")
      invalidate()
    },
  })

  if (cfg.isPending) return <Spinner />
  if (cfg.error) return <p className="text-sm text-destructive">{(cfg.error as Error).message}</p>

  const canEdit = cfg.data?.canEdit ?? false
  const provider = cfg.data?.provider ?? null
  const methodsDirty =
    passwordEnabled !== cfg.data?.methods.passwordEnabled ||
    ssoEnabled !== cfg.data?.methods.ssoEnabled
  // Both off is rejected server-side too; blocking it here keeps the user from
  // submitting the one combination that has no valid outcome.
  const methodsValid = passwordEnabled || ssoEnabled
  const providerComplete = Boolean(
    issuer.trim() && domain.trim() && clientId.trim() && clientSecret,
  )

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Sign-in methods"
          action={
            canEdit ? (
              <Button
                onClick={() => saveMethods.mutate()}
                disabled={saveMethods.isPending || !methodsDirty || !methodsValid}
              >
                <Check size={15} />
                {saveMethods.isPending ? "Saving…" : "Save"}
              </Button>
            ) : undefined
          }
        />
        <div className="space-y-4 p-6">
          <Label className="flex items-start gap-3 font-normal">
            <Checkbox
              className="mt-0.5"
              checked={passwordEnabled}
              disabled={!canEdit}
              onCheckedChange={(c) => setPasswordEnabled(c === true)}
            />
            <span className="space-y-1">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                Email and password
                <InfoHint text="Organization owners can always sign in with a password, even when this is off — otherwise a broken identity provider would lock everyone out with no way back in." />
              </span>
              <span className="block text-sm text-muted-foreground">
                Accounts created by an operator sign in directly.
              </span>
            </span>
          </Label>

          <Label className="flex items-start gap-3 font-normal">
            <Checkbox
              className="mt-0.5"
              checked={ssoEnabled}
              disabled={!canEdit || !provider}
              onCheckedChange={(c) => setSsoEnabled(c === true)}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">Single sign-on</span>
              <span className="block text-sm text-muted-foreground">
                {provider
                  ? "Members sign in through your identity provider. New people are added to this organization automatically, as members."
                  : "Configure an identity provider below first."}
              </span>
            </span>
          </Label>

          {!methodsValid && (
            <p className="text-sm text-destructive">
              At least one sign-in method must stay enabled.
            </p>
          )}
          <Feedback
            ok={saveMethods.isSuccess}
            okText="Sign-in methods saved."
            error={saveMethods.error}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Identity provider"
          action={
            canEdit ? (
              <Button
                onClick={() => saveProvider.mutate()}
                disabled={saveProvider.isPending || !providerComplete}
              >
                <ShieldCheck size={15} />
                {saveProvider.isPending ? "Saving…" : provider ? "Update" : "Connect"}
              </Button>
            ) : undefined
          }
        />
        <div className="max-w-xl space-y-4 p-6">
          <p className="text-sm text-muted-foreground">
            OpenID Connect. The sign-in, token and user-info endpoints are discovered from the
            issuer, so only these four values are needed.
          </p>

          <Field label="Issuer URL">
            <Input
              value={issuer}
              disabled={!canEdit}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="https://acme.okta.com"
            />
          </Field>
          <Field label="Email domains">
            <Input
              value={domain}
              disabled={!canEdit}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.com, acme.co.uk"
            />
          </Field>
          <p className="-mt-2 text-xs text-muted-foreground">
            Only identities with an email address at one of these domains may sign in through this
            provider. Comma-separate several.
          </p>
          <Field label="Client ID">
            <Input
              value={clientId}
              disabled={!canEdit}
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          {canEdit && (
            <>
              <Field label="Client secret">
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={provider?.hasSecret ? "Re-enter to save changes" : ""}
                />
              </Field>
              {provider?.hasSecret && (
                <p className="-mt-2 text-xs text-muted-foreground">
                  A secret is stored but never shown again. Any change to this provider needs it
                  re-entered.
                </p>
              )}
            </>
          )}

          {cfg.data?.callbackUrl && (
            <div className="space-y-1.5 pt-1">
              <span className="block text-sm font-medium text-foreground">Redirect URI</span>
              <p className="text-xs text-muted-foreground">
                Register this exact URL with your identity provider.
              </p>
              <CopyableValue value={cfg.data.callbackUrl} />
            </div>
          )}

          <Feedback
            ok={saveProvider.isSuccess}
            okText="Identity provider saved."
            error={saveProvider.error}
          />
        </div>
      </Card>

      {canEdit && provider && (
        <Card className="border-destructive/40">
          <CardHeader title={<span className="text-destructive">Danger zone</span>} />
          <div className="max-w-xl space-y-3 p-6">
            <p className="text-sm text-muted-foreground">
              Remove the identity provider. Single sign-on is turned off and password sign-in is
              turned back on, so nobody is left without a way in. Members who joined through SSO
              keep their accounts and membership.
            </p>
            <Button
              variant="destructive"
              disabled={removeProvider.isPending}
              onClick={() => removeProvider.mutate()}
            >
              {removeProvider.isPending ? "Removing…" : "Remove provider"}
            </Button>
            <Feedback error={removeProvider.error} />
          </div>
        </Card>
      )}
    </div>
  )
}
