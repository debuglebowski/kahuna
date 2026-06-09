import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Badge,
  Button,
  Card,
  Field,
  IconButton,
  Input,
  Modal,
  Spinner,
  Toolbar,
} from "../../components/ui"
import { authClient, useSession } from "../../lib/auth-client"
import { Feedback } from "./parts"
import { useFullOrg } from "./SettingsLayout"

const ROLE_ERRORS: Record<string, string> = {
  NO_SUCH_USER: "No user with that email — they must sign up first.",
  ALREADY_MEMBER: "That user is already a member.",
  FORBIDDEN: "Admins only.",
  EMAIL_REQUIRED: "Enter an email.",
}

async function addMemberByEmail(email: string, role: string) {
  const res = await fetch("/api/org/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(ROLE_ERRORS[body.error ?? ""] ?? body.error ?? "Failed to add member")
  }
  return res.json()
}

const roleTone = (role: string) => (role === "owner" ? "blue" : role === "admin" ? "amber" : "gray")

export function Members() {
  const org = useFullOrg()
  const qc = useQueryClient()
  const { data: session } = useSession()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("member")
  const [filter, setFilter] = useState("")
  // Adding happens in a modal; false = closed.
  const [adding, setAdding] = useState(false)
  // Role changes happen in a modal; null = closed.
  const [editing, setEditing] = useState<{ id: string; label: string; role: string } | null>(null)
  const [draftRole, setDraftRole] = useState("member")

  const invalidate = () => qc.invalidateQueries({ queryKey: ["fullOrg"] })

  const add = useMutation({
    mutationFn: () => addMemberByEmail(email.trim(), role),
    onSuccess: () => {
      setAdding(false)
      invalidate()
    },
  })

  const changeRole = useMutation({
    mutationFn: async (vars: { memberId: string; role: string }) => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId: vars.memberId,
        role: vars.role,
      })
      if (error) throw new Error(error.message ?? "Failed to update role")
    },
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await authClient.organization.removeMember({ memberIdOrEmail: memberId })
      if (error) throw new Error(error.message ?? "Failed to remove member")
    },
    onSuccess: invalidate,
  })

  if (org.isPending) return <Spinner />
  if (org.error) return <p className="text-sm text-destructive">{(org.error as Error).message}</p>

  const members = org.data?.members ?? []
  const ownerCount = members.filter((m) => m.role === "owner").length
  const q = filter.trim().toLowerCase()
  const shown = members.filter(
    (m) =>
      (m.user?.name ?? "").toLowerCase().includes(q) ||
      (m.user?.email ?? "").toLowerCase().includes(q),
  )

  return (
    <div className="space-y-3">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter members…">
        <Button
          size="sm"
          onClick={() => {
            add.reset()
            setEmail("")
            setRole("member")
            setAdding(true)
          }}
        >
          <Plus size={15} />
          Add member
        </Button>
      </Toolbar>

      <Card>
        {shown.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {q ? `No members match "${filter.trim()}".` : "No members yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((m) => {
              const isSelf = m.userId === session?.user.id
              const lockOwner = m.role === "owner" && ownerCount <= 1
              return (
                <li key={m.id} className="flex items-center gap-3 px-6 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {m.user?.name?.trim() || m.user?.email}
                      {isSelf && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{m.user?.email}</div>
                  </div>
                  <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                  <IconButton
                    aria-label={`Change role for ${m.user?.email ?? "member"}`}
                    disabled={lockOwner}
                    onClick={() => {
                      const label = m.user?.name?.trim() || m.user?.email || "this member"
                      setEditing({ id: m.id, label, role: m.role })
                      setDraftRole(m.role)
                    }}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    variant="danger"
                    aria-label={`Remove ${m.user?.email ?? "member"}`}
                    disabled={lockOwner || remove.isPending}
                    onClick={() => {
                      if (confirm(`Remove ${m.user?.email ?? "this member"} from the org?`))
                        remove.mutate(m.id)
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}
        <div className="px-6 pb-4">
          <Feedback error={remove.error} />
        </div>
      </Card>

      {adding && (
        <Modal title="Add member" onClose={() => setAdding(false)}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add an existing user by email — they must already have an account.
            </p>
            <div className="flex gap-2">
              <Input
                autoFocus
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && email.includes("@")) add.mutate()
                }}
                placeholder="teammate@example.com"
                className="flex-1"
              />
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => add.mutate()} disabled={add.isPending || !email.includes("@")}>
                <Plus size={15} />
                {add.isPending ? "Adding…" : "Add"}
              </Button>
              <Button variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            <Feedback error={add.error} />
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="Change role" onClose={() => setEditing(null)}>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Update the role for{" "}
              <span className="font-medium text-foreground">{editing.label}</span>.
            </p>
            <Field label="Role">
              <Select value={draftRole} onValueChange={setDraftRole}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="owner">owner</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex gap-2">
              <Button
                onClick={() => changeRole.mutate({ memberId: editing.id, role: draftRole })}
                disabled={changeRole.isPending || draftRole === editing.role}
              >
                {changeRole.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
            <Feedback error={changeRole.error} />
          </div>
        </Modal>
      )}
    </div>
  )
}
