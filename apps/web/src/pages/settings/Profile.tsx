import { useMutation } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { useState } from "react"
import { Button, Card, CardHeader, Field, Input } from "../../components/ui"
import { authClient, useSession } from "../../lib/auth-client"
import { Feedback } from "./parts"

function ProfileInfo() {
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
            <Check size={15} />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        }
      />
      <div className="max-w-md space-y-4 p-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
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

function ChangePassword() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [revokeOthers, setRevokeOthers] = useState(false)

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      })
      if (error) throw new Error(error.message ?? "Failed to change password")
    },
    onSuccess: () => {
      setCurrent("")
      setNext("")
    },
  })

  return (
    <Card>
      <CardHeader
        title="Password"
        action={
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !current || next.length < 8}
          >
            <Check size={15} />
            {save.isPending ? "Saving…" : "Change password"}
          </Button>
        }
      />
      <div className="max-w-md space-y-4 p-4">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password (min 8 chars)">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(e) => setRevokeOthers(e.target.checked)}
          />
          Sign out other sessions
        </label>
        <Feedback ok={save.isSuccess} okText="Password changed." error={save.error} />
      </div>
    </Card>
  )
}

function ChangeEmail() {
  const { data: session } = useSession()
  const [email, setEmail] = useState("")

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.changeEmail({ newEmail: email.trim() })
      if (error) throw new Error(error.message ?? "Failed to change email")
    },
    onSuccess: () => setEmail(""),
  })

  return (
    <Card>
      <CardHeader
        title="Email"
        action={
          <Button onClick={() => save.mutate()} disabled={save.isPending || !email.includes("@")}>
            <Check size={15} />
            {save.isPending ? "Saving…" : "Change email"}
          </Button>
        }
      />
      <div className="max-w-md space-y-4 p-4">
        <p className="text-xs text-gray-500">Current: {session?.user.email}</p>
        <Field label="New email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Feedback ok={save.isSuccess} okText="Email updated." error={save.error} />
      </div>
    </Card>
  )
}

function DeleteAccount() {
  const [password, setPassword] = useState("")

  const del = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.deleteUser({ password })
      if (error) throw new Error(error.message ?? "Failed to delete account")
    },
    onSuccess: () => {
      location.reload()
    },
  })

  return (
    <Card className="border-red-200">
      <CardHeader title="Delete account" />
      <div className="max-w-md space-y-4 p-4">
        <p className="text-sm text-gray-600">
          Permanently deletes your account, sessions, and memberships. This cannot be undone.
        </p>
        <Field label="Confirm with your password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button
          variant="danger"
          disabled={del.isPending || !password}
          onClick={() => {
            if (confirm("Permanently delete your account? This cannot be undone.")) del.mutate()
          }}
        >
          {del.isPending ? "Deleting…" : "Delete my account"}
        </Button>
        <Feedback error={del.error} />
      </div>
    </Card>
  )
}

export function Profile() {
  return (
    <div className="space-y-5">
      <ProfileInfo />
      <ChangeEmail />
      <ChangePassword />
      <DeleteAccount />
    </div>
  )
}
