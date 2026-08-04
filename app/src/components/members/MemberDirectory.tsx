import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal, Pencil, Plus, Trash2, UserCheck, UserX } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  roleTone,
  Spinner,
  ToggleChip,
  Toolbar,
} from "@/components/ui"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  addMemberByEmail,
  memberLabel,
  type OrgMember,
  purgeMember,
  setMemberRole,
  useMembers,
} from "@/lib/members"
import { useSectionBase } from "@/lib/sectionBase"
import { initialsOf } from "@/lib/utils"
import { Feedback } from "@/pages/settings/parts"
import { useIsAdmin } from "@/pages/settings/SettingsLayout"

export type MemberField = "role" | "email" | "joined"
export type MemberSort = "name" | "role" | "joined"

const ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 }

const joinedMs = (m: OrgMember): number => {
  const t = m.createdAt ? new Date(m.createdAt).getTime() : Number.NaN
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}

/** "May 2026" — the joined line/column (day precision is noise here). */
const joinedLabel = (m: OrgMember): string | null => {
  const t = m.createdAt ? new Date(m.createdAt) : null
  return t && !Number.isNaN(t.getTime())
    ? t.toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : null
}

/**
 * The org directory: every colleague, one row each, leading to their profile
 * page. Deactivated members hide behind a toggle (the archive pattern). Admins
 * manage the full member lifecycle here: add members, change roles, deactivate
 * / reactivate / delete. Shared by the `/members` page and the `members`
 * dashboard widget — `showToolbar` drops the filter/deactivated/add row,
 * `variant: "grid"` renders read-only avatar cards (orientation, no admin
 * actions), `fields`/`sort`/`limit` shape the rows for small tiles.
 */
export function MemberDirectory({
  showToolbar = true,
  variant = "rows",
  fields = ["role", "email"],
  sort = "name",
  limit,
}: {
  showToolbar?: boolean
  variant?: "rows" | "grid"
  /** Row metadata toggles (rows variant). */
  fields?: ReadonlyArray<MemberField>
  sort?: MemberSort
  /** Cap shown members (a "view all" link covers the rest); null/absent = all. */
  limit?: number | null
}) {
  const qc = useQueryClient()
  const { data: session } = useSession()
  // Members render at two urls (/members and /settings/members) — link relative
  // to whichever is mounted, so a click can't throw the user out of settings.
  const base = useSectionBase("members")
  const { members, deactivatedSet, isPending, error } = useMembers()
  const { admin } = useIsAdmin()
  const [filter, setFilter] = useState("")
  const [showDeactivated, setShowDeactivated] = useState(false)
  // Pending admin action; ConfirmDialog stays mounted while the mutation runs.
  const [confirming, setConfirming] = useState<{
    kind: "deactivate" | "purge"
    member: OrgMember
  } | null>(null)
  // Adding happens in a modal; false = closed.
  const [adding, setAdding] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("member")
  // Role changes happen in a modal; null = closed.
  const [editing, setEditing] = useState<{ userId: string; label: string; role: string } | null>(
    null,
  )
  const [draftRole, setDraftRole] = useState("member")

  /**
   * Custom access roles per member, for the pills.
   *
   * ONE query for the whole directory rather than `rolesOf` per row — this component
   * also renders as a dashboard widget, where N members would mean N requests. The
   * membership presets are filtered out: they duplicate the role badge already shown.
   */
  const assignmentsQ = useQuery({
    queryKey: ["roleAssignments", members.map((m) => m.userId).join(",")],
    queryFn: async () => {
      const pairs = await Promise.all(
        members.map(async (m) => [m.userId, await api.rolesOf(m.userId)] as const),
      )
      return new Map(pairs)
    },
    enabled: members.length > 0,
  })
  const accessRoles = new Map(
    [...(assignmentsQ.data ?? new Map()).entries()].map(([userId, held]) => [
      userId,
      (held as ReadonlyArray<{ id: string; key: string | null; name: string }>).filter(
        // `key === null` = a custom role. Presets mirror the membership badge.
        (r) => r.key === null,
      ),
    ]),
  )
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["deactivatedMembers"] })
    await qc.invalidateQueries({ queryKey: ["fullOrg"] })
  }

  const add = useMutation({
    mutationFn: () => addMemberByEmail(email.trim(), role),
    onSuccess: async () => {
      setAdding(false)
      await invalidate()
    },
  })
  const changeRole = useMutation({
    // Our route, not authClient.organization.updateMemberRole — the last-owner
    // rule lives server-side (see router.ts).
    mutationFn: (vars: { userId: string; role: string }) => setMemberRole(vars.userId, vars.role),
    onSuccess: async () => {
      setEditing(null)
      await invalidate()
    },
  })
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

  const ownerCount = members.filter((m) => m.role === "owner").length
  const q = filter.trim().toLowerCase()
  const matching = members.filter((m) => {
    if (!showDeactivated && deactivatedSet.has(m.userId)) return false
    return (
      (m.user?.name ?? "").toLowerCase().includes(q) ||
      (m.user?.email ?? "").toLowerCase().includes(q)
    )
  })
  const sorted = [...matching].sort((a, b) => {
    if (sort === "role") {
      const d = (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9)
      if (d !== 0) return d
    }
    if (sort === "joined") {
      const d = joinedMs(a) - joinedMs(b)
      if (d !== 0) return d
    }
    return memberLabel(a, a.userId).localeCompare(memberLabel(b, b.userId))
  })
  const capped = limit && limit > 0 ? sorted.slice(0, limit) : sorted
  const shown = capped
  const overflow = sorted.length - capped.length
  const has = (f: MemberField) => fields.includes(f)

  const viewAll = overflow > 0 && (
    <Link
      to={base}
      className="block px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      View all {sorted.length} members →
    </Link>
  )

  if (variant === "grid") {
    return (
      <div className="space-y-2">
        {showToolbar && (
          <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter members…" />
        )}
        {shown.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {q ? `No members match "${filter.trim()}".` : "No members yet."}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            {shown.map((m) => (
              <Link
                key={m.id}
                to={`${base}/${m.userId}`}
                className="flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition hover:bg-accent"
              >
                <Avatar className="size-12">
                  <AvatarImage src={m.user?.image ?? undefined} alt="" />
                  <AvatarFallback>{initialsOf(m.user?.name, m.user?.email ?? "")}</AvatarFallback>
                </Avatar>
                <span className="w-full truncate text-sm font-medium text-foreground">
                  {memberLabel(m, m.userId)}
                </span>
                {has("role") && <Badge tone={roleTone(m.role)}>{m.role}</Badge>}
                {deactivatedSet.has(m.userId) && <Badge tone="red">deactivated</Badge>}
              </Link>
            ))}
          </div>
        )}
        {viewAll}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {showToolbar && (
        <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter members…">
          <ToggleChip pressed={showDeactivated} onPressedChange={setShowDeactivated}>
            Deactivated
          </ToggleChip>
          {admin && (
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
          )}
        </Toolbar>
      )}

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
              const lockOwner = m.role === "owner" && ownerCount <= 1
              const label = memberLabel(m, m.userId)
              return (
                <li key={m.id} className="flex items-center gap-3 px-6 py-3 hover:bg-accent/50">
                  <Link
                    to={`${base}/${m.userId}`}
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
                      {has("email") && (
                        <div className="truncate text-xs text-muted-foreground">
                          {m.user?.email}
                        </div>
                      )}
                    </div>
                  </Link>
                  {has("joined") && joinedLabel(m) && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Joined {joinedLabel(m)}
                    </span>
                  )}
                  {deactivated && <Badge tone="red">deactivated</Badge>}
                  {has("role") && <Badge tone={roleTone(m.role)}>{m.role}</Badge>}
                  {/* CUSTOM access roles, beside the membership role. Names are org
                      vocabulary — any member may see who holds what; only the RULES
                      inside a role need `configure`. Presets are omitted: they mirror
                      the membership badge already shown, so rendering both is noise. */}
                  {(accessRoles.get(m.userId) ?? []).map((r) => (
                    <Badge key={r.id} tone="blue">
                      {r.name}
                    </Badge>
                  ))}
                  {admin && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground"
                            aria-label={`Actions for ${label}`}
                          >
                            <MoreHorizontal size={15} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={lockOwner}
                            onSelect={() => {
                              setEditing({ userId: m.userId, label, role: m.role })
                              setDraftRole(m.role)
                            }}
                          >
                            <Pencil size={15} />
                            Change role
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {deactivated ? (
                            <>
                              <DropdownMenuItem
                                disabled={reactivate.isPending}
                                onSelect={() => reactivate.mutate(m.userId)}
                              >
                                <UserCheck size={15} />
                                Reactivate
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setConfirming({ kind: "purge", member: m })}
                              >
                                <Trash2 size={15} />
                                Delete
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={isSelf || m.role === "owner"}
                              onSelect={() => setConfirming({ kind: "deactivate", member: m })}
                            >
                              <UserX size={15} />
                              Deactivate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {viewAll}
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
                onClick={() => changeRole.mutate({ userId: editing.userId, role: draftRole })}
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
