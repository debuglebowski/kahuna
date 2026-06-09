import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { useEffect, useState } from "react"
import { Button, Card, CardHeader, Field, Input, Spinner } from "../../components/ui"
import { authClient, signOut, useSession } from "../../lib/auth-client"
import { Feedback } from "./parts"
import { useFullOrg } from "./SettingsLayout"

export function Organization() {
  const org = useFullOrg()
  const qc = useQueryClient()
  const { data: session } = useSession()
  const [name, setName] = useState("")
  const [logo, setLogo] = useState("")
  const [confirm, setConfirm] = useState("")

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
      const { error } = await authClient.organization.update({
        organizationId: org.data.id,
        data: { name: name.trim(), logo: logo.trim() || undefined },
      })
      if (error) throw new Error(error.message ?? "Failed to update organization")
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fullOrg"] }),
  })

  // Deleting an org purges its engine data server-side (beforeDeleteOrganization
  // hook) and BetterAuth clears the active org. Afterwards switch to another
  // membership if one exists, else sign out (the user is now org-less).
  const del = useMutation({
    mutationFn: async () => {
      if (!org.data) return
      const { error } = await authClient.organization.delete({ organizationId: org.data.id })
      if (error) throw new Error(error.message ?? "Failed to delete organization")
    },
    onSuccess: async () => {
      const { data: orgs } = await authClient.organization.list()
      const next = orgs?.find((o) => o.id !== org.data?.id)
      if (next) await authClient.organization.setActive({ organizationId: next.id })
      else await signOut()
      location.reload()
    },
  })

  if (org.isPending) return <Spinner />
  if (org.error) return <p className="text-sm text-destructive">{(org.error as Error).message}</p>

  const myRole = org.data?.members?.find((m) => m.userId === session?.user.id)?.role
  const isOwner = myRole === "owner"

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

      {isOwner && (
        <Card className="border-destructive/40">
          <CardHeader title={<span className="text-destructive">Danger zone</span>} />
          <div className="max-w-md space-y-3 p-6">
            <p className="text-sm text-muted-foreground">
              Permanently delete <strong>{org.data?.name}</strong> and all of its data — concepts,
              records, history, and members. This cannot be undone.
            </p>
            <Field label={`Type the name "${org.data?.name}" to confirm`}>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <Button
              variant="destructive"
              disabled={del.isPending || confirm !== org.data?.name}
              onClick={() => del.mutate()}
            >
              {del.isPending ? "Deleting…" : "Delete organization"}
            </Button>
            <Feedback error={del.error} />
          </div>
        </Card>
      )}
    </div>
  )
}
