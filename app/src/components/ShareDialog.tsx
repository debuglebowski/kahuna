import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useState } from "react"
import { Badge, Button, Modal, Spinner } from "@/components/ui"
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

const GRANTABLE: ReadonlyArray<AccessActionName> = ["view", "edit", "archive", "delete", "share"]

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
                    <span className="text-muted-foreground">{g.actions.join(", ")}</span>
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
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">Choose a person or role…</option>
                <optgroup label="People">
                  {members.map((m) => (
                    <option key={m.userId} value={`user:${m.userId}`}>
                      {memberLabel(m, m.userId)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Roles">
                  {(roles.data ?? []).map((r) => (
                    <option key={r.id} value={`role:${r.id}`}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <div className="flex flex-wrap gap-1.5">
                {GRANTABLE.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => toggle(a)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      actions.includes(a)
                        ? "border-primary bg-primary/10 text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
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
