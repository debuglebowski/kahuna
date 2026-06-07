import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { Button, Card, CardHeader, Field, Input } from "../../components/ui"
import { authClient, useSession } from "../../lib/auth-client"
import { Feedback } from "./parts"

export function Profile() {
  const { data: session } = useSession()
  const [name, setName] = useState(session?.user.name ?? "")
  const [image, setImage] = useState(session?.user.image ?? "")

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({
        name: name.trim(),
        image: image.trim() || undefined,
      })
      if (error) throw new Error(error.message ?? "Failed to save profile")
    },
  })

  return (
    <Card>
      <CardHeader
        title="Profile"
        action={
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        }
      />
      <div className="max-w-md space-y-4 p-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={session?.user.email ?? ""} disabled />
        </Field>
        <Field label="Avatar URL">
          <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" />
        </Field>
        {image.trim() && (
          <img src={image} alt="Avatar preview" className="h-12 w-12 rounded-full object-cover" />
        )}
        <Feedback ok={save.isSuccess} okText="Profile saved." error={save.error} />
      </div>
    </Card>
  )
}
