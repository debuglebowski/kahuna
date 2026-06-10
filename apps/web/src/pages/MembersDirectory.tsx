import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, UserCheck, UserX } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Badge,
  Card,
  ConfirmDialog,
  IconButton,
  Spinner,
  ToggleChip,
  Toolbar,
} from "../components/ui"
import { api } from "../lib/api"
import { useSession } from "../lib/auth-client"
import { memberLabel, type OrgMember, purgeMember, useMembers } from "../lib/members"
import { initialsOf } from "../lib/utils"
import { isAdminRole } from "./settings/SettingsLayout"

const roleTone = (role: string) => (role === "owner" ? "blue" : role === "admin" ? "amber" : "gray")

/**
 * The org directory (`/members`): every colleague, one row each, leading to
 * their profile page. Deactivated members hide behind a toggle (the archive
 * pattern); admins can deactivate / reactivate / delete from here. Adding
 * members and changing roles stays in Settings → Members.
 */
export function MembersDirectory() {
  const qc = useQueryClient()
  const { data: session } = useSession()
  const { members, deactivatedSet, isPending, error } = useMembers()
  const [filter, setFilter] = useState("")
  const [showDeactivated, setShowDeactivated] = useState(false)
  // Pending admin action; ConfirmDialog stays mounted while the mutation runs.
  const [confirming, setConfirming] = useState<{
    kind: "deactivate" | "purge"
    member: OrgMember
  } | null>(null)

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["deactivatedMembers"] })
    await qc.invalidateQueries({ queryKey: ["fullOrg"] })
  }

  const deactivate = useMutation({
    mutationFn: (userId: string) => api.deactivateMember(userId),
    onSuccess: async () => {
      setConfirming(null)
      await invalidate()
    },
  })
  const reactivate = useMutation({
    mutationFn: (userId: string) => api.reactivateMember(userId),
    onSuccess: invalidate,
  })
  const purge = useMutation({
    mutationFn: (userId: string) => purgeMember(userId),
    onSuccess: async () => {
      setConfirming(null)
      await invalidate()
    },
  })

  if (isPending) return <Spinner />
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>

  const admin = isAdminRole(members.find((m) => m.userId === session?.user.id)?.role)
  const q = filter.trim().toLowerCase()
  const shown = members.filter((m) => {
    if (!showDeactivated && deactivatedSet.has(m.userId)) return false
    return (
      (m.user?.name ?? "").toLowerCase().includes(q) ||
      (m.user?.email ?? "").toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold tracking-tight text-foreground">Members</h2>
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter members…">
        <ToggleChip pressed={showDeactivated} onPressedChange={setShowDeactivated}>
          Deactivated
        </ToggleChip>
      </Toolbar>

      <Card>
        {shown.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {q ? `No members match "${filter.trim()}".` : "No members yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((m) => {
              const deactivated = deactivatedSet.has(m.userId)
              const isSelf = m.userId === session?.user.id
              const label = memberLabel(m, m.userId)
              return (
                <li key={m.id} className="flex items-center gap-3 px-6 py-3 hover:bg-accent/50">
                  <Link
                    to={`/members/${m.userId}`}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <Avatar className="size-8">
                      <AvatarImage src={m.user?.image ?? undefined} alt="" />
                      <AvatarFallback>
                        {initialsOf(m.user?.name, m.user?.email ?? "")}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {label}
                        {isSelf && (
                          <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{m.user?.email}</div>
                    </div>
                  </Link>
                  {deactivated && <Badge tone="red">deactivated</Badge>}
                  <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                  {admin && !isSelf && m.role !== "owner" && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {deactivated ? (
                        <>
                          <IconButton
                            aria-label={`Reactivate ${label}`}
                            disabled={reactivate.isPending}
                            onClick={() => reactivate.mutate(m.userId)}
                          >
                            <UserCheck size={15} />
                          </IconButton>
                          <IconButton
                            variant="danger"
                            aria-label={`Delete ${label}`}
                            onClick={() => setConfirming({ kind: "purge", member: m })}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </>
                      ) : (
                        <IconButton
                          variant="danger"
                          aria-label={`Deactivate ${label}`}
                          onClick={() => setConfirming({ kind: "deactivate", member: m })}
                        >
                          <UserX size={15} />
                        </IconButton>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {confirming?.kind === "deactivate" && (
        <ConfirmDialog
          title="Deactivate member"
          message={`${memberLabel(confirming.member, "This member")} will be blocked from the org and hidden from pickers. Their data and page are kept — you can reactivate them anytime.`}
          confirmLabel="Deactivate"
          confirmVariant="danger"
          pending={deactivate.isPending}
          error={(deactivate.error as Error | null)?.message}
          onConfirm={() => deactivate.mutate(confirming.member.userId)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming?.kind === "purge" && (
        <ConfirmDialog
          title="Delete member"
          message={`Permanently remove ${memberLabel(confirming.member, "this member")} from the org. Their profile page is deleted; values referencing them stay in the history. This can't be undone.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={purge.isPending}
          error={(purge.error as Error | null)?.message}
          onConfirm={() => purge.mutate(confirming.member.userId)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}
