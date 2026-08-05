import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GripVertical, Plus, Settings2, X } from "lucide-react"
import { useState } from "react"
import { Badge, Button, Card, CardHeader, Spinner } from "../../components/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { type AccessRole, api } from "../../lib/api"
import { MyAccess } from "./MyAccess"
import { Feedback } from "./parts"
import { RuleEditor } from "./Roles"
import { useIsAdmin } from "./SettingsLayout"

function RoleRow({
  role,
  sortable,
  onRemove,
  removing,
}: {
  role: AccessRole
  sortable: boolean
  onRemove: () => void
  removing: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: role.id,
    disabled: !sortable,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md border bg-background px-3 py-2 ${
        isDragging ? "opacity-60 shadow" : ""
      }`}
    >
      <button
        type="button"
        className={
          sortable
            ? "cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            : "cursor-default text-muted-foreground/40"
        }
        aria-label="Drag to reorder"
        disabled={!sortable}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <span className="flex-1 truncate text-sm font-medium text-foreground">{role.name}</span>
      {role.key === null && <Badge tone="blue">Custom</Badge>}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${role.name}`}
        onClick={onRemove}
        disabled={removing}
      >
        <X size={14} />
      </Button>
    </div>
  )
}

/**
 * Roles held, in the order they resolve. This is the gap P5 exists to close —
 * `assignRole`/`unassignRole` were already fully wired server-side with nothing
 * in the client calling them, and `access_role_actors.position` had no write
 * path anywhere; this section is both.
 *
 * Index 0 wins outright over a later one that disagrees (see `decide` in
 * `engine/domain/access.ts`) — drag reorders, it never grants or removes.
 */
function RolesSection({ userId }: { userId: string }) {
  const qc = useQueryClient()
  const held = useQuery({ queryKey: ["rolesOf", userId], queryFn: () => api.rolesOf(userId) })
  const all = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() })
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const [picking, setPicking] = useState("")

  const invalidate = () => qc.invalidateQueries({ queryKey: ["rolesOf", userId] })

  const assign = useMutation({
    mutationFn: (roleId: string) => api.assignRole(roleId, userId),
    onSuccess: () => {
      setPicking("")
      void invalidate()
    },
  })
  const unassign = useMutation({
    mutationFn: (roleId: string) => api.unassignRole(roleId, userId),
    onSuccess: invalidate,
  })
  const reorder = useMutation({
    mutationFn: (roleIds: ReadonlyArray<string>) => api.reorderMemberRoles(userId, roleIds),
    onSuccess: invalidate,
  })

  const rows = held.data ?? []
  // Only PEOPLE roles, and not one they already hold. `list()`/`listRoles()`
  // already excludes personal roles (Layer 1 has its own section below).
  const holdable = (all.data ?? []).filter(
    (r) => r.kind === "user" && r.active && !rows.some((h) => h.id === r.id),
  )

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = rows.findIndex((r) => r.id === active.id)
    const to = rows.findIndex((r) => r.id === over.id)
    if (from < 0 || to < 0) return
    reorder.mutate(arrayMove([...rows], from, to).map((r) => r.id))
  }

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">Roles</span>
      <p className="text-xs text-muted-foreground">
        Held in this order — the first one wins outright over a later one that disagrees. Drag to
        reorder.
      </p>
      {held.isPending ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No roles held — they see what every member sees.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {rows.map((r) => (
                <RoleRow
                  key={r.id}
                  role={r}
                  sortable={rows.length > 1}
                  onRemove={() => unassign.mutate(r.id)}
                  removing={unassign.isPending && unassign.variables === r.id}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {unassign.error && <Feedback error={unassign.error} />}

      {holdable.length > 0 ? (
        <div className="flex items-center gap-2 pt-1">
          <Select value={picking} onValueChange={setPicking}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Add a role…" />
            </SelectTrigger>
            <SelectContent>
              {holdable.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => picking && assign.mutate(picking)}
            disabled={!picking || assign.isPending}
          >
            <Plus size={15} /> Add
          </Button>
        </div>
      ) : null}
      {assign.error && <Feedback error={assign.error} />}
    </div>
  )
}

/**
 * This member's personal role (Layer 1) — get-or-created the moment this
 * section is viewed (see `AccessRoleService.ensurePersonalRole`'s doc for why
 * that's "on view", not literally "on first edit"), edited via the SAME
 * `RuleEditor` the Roles page uses, just pointed at a different role id. It is
 * entirely role-agnostic, so nothing about it needed to change for reuse here.
 */
function PersonalOverridesSection({ userId }: { userId: string }) {
  const personal = useQuery({
    queryKey: ["personalRole", userId],
    queryFn: () => api.ensurePersonalRole(userId),
  })
  const rules = useQuery({
    queryKey: ["rules", personal.data?.id],
    queryFn: () => api.listRules(personal.data?.id ?? ""),
    enabled: !!personal.data,
  })
  const [editing, setEditing] = useState(false)

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">Personal overrides</span>
      <p className="text-xs text-muted-foreground">
        Rules for this person specifically — resolved above every role they hold. Empty by default.
      </p>
      {personal.isPending ? (
        <Spinner />
      ) : personal.error ? (
        <Feedback error={personal.error} />
      ) : (
        <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {rules.data?.length ? `${rules.data.length} override rule(s)` : "No overrides set"}
          </span>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Settings2 size={14} /> Manage
          </Button>
        </div>
      )}
      {editing && personal.data && (
        <RuleEditor role={personal.data} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}

/**
 * The member access page (P5): roles held (add / remove / reorder), personal
 * overrides (Layer 1), and the explain view (P4, reused wholesale) — the three
 * layers of the cascade, in the order they resolve.
 *
 * Gated on `configure` on `role`: giving someone a role, ordering it, and
 * editing their personal overrides are all "may manage permissions", the same
 * thing the Roles page itself is gated on. Renders nothing for anyone else —
 * a member's own profile looks exactly as it did before this section existed.
 */
export function MemberAccess({ userId }: { userId: string }) {
  const { canConfigureRoles, isPending } = useIsAdmin()
  if (isPending || !canConfigureRoles) return null

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Access" />
        <div className="space-y-6 p-4 pt-0">
          <RolesSection userId={userId} />
          <PersonalOverridesSection userId={userId} />
        </div>
      </Card>
      <MyAccess userId={userId} />
    </div>
  )
}
