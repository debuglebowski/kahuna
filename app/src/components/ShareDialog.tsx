import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useState } from "react"
import { Badge, Button, Field, Modal, Spinner, ToggleChip } from "@/components/ui"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { type AccessActionName, type AccessResourceType, api } from "@/lib/api"
import { memberLabel, useMembers } from "@/lib/members"
import { Feedback } from "@/pages/settings/parts"

/**
 * Share one resource with a person or a role.
 *
 * A share is an ordinary access rule attached to one actor, so this dialog and the
 * roles editor write the same table — there is no separate sharing mechanism.
 *
 * Requires `share` ON THIS RESOURCE, which is the point: a team lead hands out access
 * to their own deals without an admin in the loop. Reading the grant list needs it too
 * (who a record is shared with is itself sensitive), so a FORBIDDEN here means "you
 * may not manage sharing for this", not "something broke".
 */

/** What a share can grant, in escalating order. Title Cased for display — the wire
 *  values are lowercase engine vocabulary. `configure` and `create` are absent: neither
 *  means anything scoped to a single existing record. */
const GRANTABLE: ReadonlyArray<{ id: AccessActionName; label: string }> = [
  { id: "view", label: "View" },
  { id: "edit", label: "Edit" },
  { id: "archive", label: "Archive" },
  { id: "delete", label: "Delete" },
  { id: "share", label: "Share" },
]

const ACTION_LABEL = new Map(GRANTABLE.map((a) => [a.id, a.label] as const))

/** How a grant's actions read in the list. */
const actionsLabel = (actions: ReadonlyArray<string>): string =>
  actions.includes("*")
    ? "Everything"
    : actions.map((a) => ACTION_LABEL.get(a as AccessActionName) ?? a).join(", ")

export function ShareDialog({
  resourceType,
  resourceId,
  title,
  onClose,
}: {
  resourceType: AccessResourceType
  resourceId: string
  /** What is being shared, for the header (e.g. the record's title). */
  title: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { members } = useMembers()
  const grants = useQuery({
    queryKey: ["grants", resourceType, resourceId],
    queryFn: () => api.listGrants(resourceType, resourceId),
  })
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() })

  const [subject, setSubject] = useState("")
  const [actions, setActions] = useState<ReadonlyArray<AccessActionName>>(["view"])

  const invalidate = () => qc.invalidateQueries({ queryKey: ["grants", resourceType, resourceId] })

  const add = useMutation({
    mutationFn: () => {
      // "user:<id>" / "role:<id>" — one <select>, two subject kinds, exactly one sent.
      const [kind, id] = subject.split(":")
      return api.share({
        resourceType,
        resourceId,
        ...(kind === "role" ? { roleId: id } : { userId: id }),
        actions,
      })
    },
    onSuccess: () => {
      void invalidate()
      setSubject("")
      setActions(["view"])
    },
  })
  const revoke = useMutation({
    mutationFn: (grantId: string) => api.revokeGrant(grantId),
    onSuccess: () => void invalidate(),
  })

  const labelFor = (userId: string) => {
    const m = members.find((x) => x.userId === userId)
    return m ? memberLabel(m, userId) : userId.slice(0, 8)
  }

  const toggle = (a: AccessActionName) =>
    setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]))

  const forbidden = (grants.error as { code?: string } | null)?.code === "FORBIDDEN"

  return (
    <Modal onClose={onClose} title={`Share — ${title}`}>
      <div className="space-y-4">
        {forbidden ? (
          <p className="text-sm text-muted-foreground">
            You don't have permission to manage sharing for this.
          </p>
        ) : grants.isPending ? (
          <Spinner />
        ) : (
          <>
            {grants.data && grants.data.length > 0 ? (
              <div className="divide-y rounded-md border">
                {grants.data.map((g) => (
                  <div key={g.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">
                      {g.roleId ? (g.roleName ?? "a role") : labelFor(g.userId ?? "")}
                    </span>
                    {g.roleId ? <Badge tone="blue">role</Badge> : null}
                    <span className="text-muted-foreground">{actionsLabel(g.actions)}</span>
                    {g.effect === "deny" ? <Badge tone="red">deny</Badge> : null}
                    {/* A plain button, NOT IconButton: that wraps its child in a Radix
                        Tooltip, and when this row unmounts on a successful revoke the
                        tooltip's portal teardown registers as an outside interaction —
                        which closes the surrounding Dialog. Verified in the browser:
                        revoking dismissed the whole dialog instead of just the row. */}
                    <button
                      type="button"
                      aria-label="Revoke"
                      className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      onClick={() => revoke.mutate(g.id)}
                      disabled={revoke.isPending}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not shared with anyone yet. Who can see it comes from its own default visibility.
              </p>
            )}
            <Feedback error={revoke.error ? (revoke.error as Error).message : undefined} />

            <div className="space-y-2 rounded-md border p-3">
              <span className="block text-sm font-medium">Add</span>
              <Field label="Who">
                <Select value={subject} onValueChange={setSubject}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a person or role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* One control, two subject kinds — a share is the same rule row
                        whether it names a person or a role, so the picker shouldn't
                        make them look like different features. */}
                    <SelectGroup>
                      <SelectLabel>People</SelectLabel>
                      {members.map((m) => (
                        <SelectItem key={m.userId} value={`user:${m.userId}`}>
                          {memberLabel(m, m.userId)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>Roles</SelectLabel>
                      {(roles.data ?? []).map((r) => (
                        <SelectItem key={r.id} value={`role:${r.id}`}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Can">
                <div className="flex flex-wrap gap-1.5">
                  {GRANTABLE.map((a) => (
                    <ToggleChip
                      key={a.id}
                      pressed={actions.includes(a.id)}
                      onPressedChange={() => toggle(a.id)}
                    >
                      {a.label}
                    </ToggleChip>
                  ))}
                </div>
              </Field>
              <Button
                size="sm"
                onClick={() => add.mutate()}
                disabled={!subject || actions.length === 0 || add.isPending}
              >
                Share
              </Button>
              {/* The server refuses a grant wider than the sharer's own access — that
                  message is user-facing, so pass it straight through. */}
              <Feedback error={add.error ? (add.error as Error).message : undefined} />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
