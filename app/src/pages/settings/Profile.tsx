import { useMutation } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Button, Card, CardHeader, Field, Input } from "../../components/ui"
import { authClient, useSession } from "../../lib/auth-client"
import { MyAccess } from "./MyAccess"
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
      <div className="max-w-md space-y-4 p-6">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Avatar URL">
          <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" />
        </Field>
        {image.trim() && (
          <Avatar className="size-12">
            <AvatarImage src={image} alt="Avatar preview" />
            <AvatarFallback>{(name.trim()[0] ?? "?").toUpperCase()}</AvatarFallback>
          </Avatar>
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
      <div className="max-w-md space-y-4 p-6">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password (min 8 chars)">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Label className="flex items-center gap-2 text-sm font-normal text-foreground">
          <Checkbox checked={revokeOthers} onCheckedChange={(c) => setRevokeOthers(c === true)} />
          Sign out other sessions
        </Label>
        <Feedback ok={save.isSuccess} okText="Password changed." error={save.error} />
      </div>
    </Card>
  )
}

/**
 * Read-only email. Self-serve change is disabled server-side (see `auth.ts`):
 * email is what grants org membership and is never verified here, so the address
 * an operator provisioned is the one that stands. Shown rather than hidden so
 * people can see which account they're signed in as, and know who to ask.
 */
function AccountEmail() {
  const { data: session } = useSession()
  return (
    <Card>
      <CardHeader title="Email" />
      <div className="max-w-md space-y-2 p-6">
        <p className="text-sm text-foreground">{session?.user.email}</p>
        <p className="text-xs text-muted-foreground">
          Ask an administrator to change the email on your account.
        </p>
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
    <Card className="border-destructive/40">
      <CardHeader title={<span className="text-destructive">Danger zone</span>} />
      <div className="max-w-md space-y-4 p-6">
        <p className="text-sm text-muted-foreground">
          Permanently deletes your account, sessions, and memberships. This cannot be undone.
        </p>
        <Field label="Confirm with your password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button
          variant="destructive"
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
      {/* Self-serve: answers "why can't I see X?" without an admin in the loop. */}
      <MyAccess />
      <AccountEmail />
      <ChangePassword />
      <DeleteAccount />
    </div>
  )
}
