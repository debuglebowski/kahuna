import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { authClient } from "../lib/auth-client"
import { makeOrgSlug } from "../lib/org"
import { Feedback } from "../pages/settings/parts"
import { Button, Field, Input, Modal } from "./ui"

/** Name-only dialog to create an org, then switch to it. The new org's concepts
 *  are seeded server-side by the afterCreateOrganization hook (see auth.ts), so
 *  there's no client-side seeding — we just reload onto the fresh active org. */
export function CreateOrgModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("")

  const create = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim()
      const created = await authClient.organization.create({
        name: trimmed,
        slug: makeOrgSlug(trimmed),
      })
      if (created.error || !created.data)
        throw new Error(created.error?.message ?? "Failed to create organization")
      await authClient.organization.setActive({ organizationId: created.data.id })
      window.location.reload()
    },
  })

  return (
    <Modal title="Create organization" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create.mutate()
        }}
      >
        <Field label="Organization name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Inc."
          />
        </Field>
        <Feedback error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
