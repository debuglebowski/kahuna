import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpCircle, Check } from "lucide-react"
import { useEffect, useState } from "react"
import { Badge, Button, Card, CardHeader, Field, Input, Spinner } from "../../components/ui"
import { api } from "../../lib/api"
import { Feedback } from "./parts"
import { useFullOrg } from "./SettingsLayout"

/**
 * Running build, plus an advisory note when the registry has a newer release.
 *
 * Deliberately does NOT print an upgrade command. The server has no idea whether
 * it is under compose, Kubernetes, Nomad or systemd, and the one thing that IS
 * invariant (migrate with the new image before serving) belongs in the release
 * notes, not guessed at here. So: state the fact, link the notes, let the
 * operator use their own deploy path.
 */
function VersionCard() {
  const v = useQuery({ queryKey: ["version"], queryFn: api.getVersion })

  return (
    <Card>
      <CardHeader title="Version" />
      <div className="space-y-3 p-6">
        {v.isPending ? (
          <Spinner />
        ) : v.error ? (
          <p className="text-sm text-muted-foreground">Version unavailable.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Running</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {v.data?.current}
              </code>
              {v.data?.updateAvailable && <Badge tone="amber">Update available</Badge>}
            </div>
            {v.data?.updateAvailable && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
                <ArrowUpCircle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <p className="text-sm">
                  <strong>{v.data.latest}</strong> is available.{" "}
                  <a
                    className="underline underline-offset-2"
                    href="https://github.com/debuglebowski/kahuna/releases"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Release notes
                  </a>
                  {" — "}
                  check them before upgrading.
                </p>
              </div>
            )}
            {v.data?.checkDisabled && (
              <p className="text-xs text-muted-foreground">Update checks are disabled.</p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

export function Organization() {
  const org = useFullOrg()
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [logo, setLogo] = useState("")

  // Seed the form once the org loads.
  useEffect(() => {
    if (org.data) {
      setName(org.data.name ?? "")
      setLogo(org.data.logo ?? "")
    }
  }, [org.data])

  const save = useMutation({
    mutationFn: async () => {
      if (!org.data) return
      // Our route, not `authClient.organization.update` — BetterAuth decides that
      // endpoint from the caller's MEMBERSHIP tier, which an administrator no longer
      // has. `/api/org` gates on `configure` like everything else they do.
      const res = await fetch("/api/org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), logo: logo.trim() || null }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to update organization")
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fullOrg"] }),
  })

  if (org.isPending) return <Spinner />
  if (org.error) return <p className="text-sm text-destructive">{(org.error as Error).message}</p>

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Organization"
          action={
            <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
              <Check size={15} />
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          }
        />
        <div className="max-w-md space-y-4 p-6">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Logo URL">
            <Input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" />
          </Field>
          <Feedback ok={save.isSuccess} okText="Organization saved." error={save.error} />
        </div>
      </Card>

      <VersionCard />

      {/* No "delete organization" danger zone. A deployment holds exactly one org,
          so deleting it does not leave you somewhere else — it leaves every user
          with a 409 NO_ACTIVE_ORG from resolveOrg and no way back, since
          `bun run bootstrap` guards on "no user has EVER existed" and the users
          survive the delete. Tearing down an recordVersion is an operator action
          (drop the database, or scripts/create-admin.ts to re-issue an org). */}
    </div>
  )
}
