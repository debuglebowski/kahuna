import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { initialsOf } from "@/lib/utils"

/** A member as returned by `useFullOrg().data.members`. */
export interface OrgMember {
  readonly userId: string
  readonly user?: {
    readonly name?: string | null
    readonly email?: string | null
    readonly image?: string | null
  } | null
}

/** Sentinel for "unassigned" (Radix Select can't hold an empty value). */
const NONE = "__none"

export function memberLabel(m: OrgMember | undefined): string {
  return m?.user?.name || m?.user?.email || "Unknown"
}

/** A small avatar for a member (image with initials fallback). */
export function MemberAvatar({
  member,
  size = 20,
}: {
  member: OrgMember | undefined
  size?: number
}) {
  const name = member?.user?.name ?? null
  const email = member?.user?.email ?? ""
  return (
    <Avatar style={{ width: size, height: size }} className="shrink-0">
      {member?.user?.image ? (
        <AvatarImage src={member.user.image} alt={memberLabel(member)} />
      ) : null}
      <AvatarFallback className="text-[0.6rem]">{initialsOf(name, email)}</AvatarFallback>
    </Avatar>
  )
}

/**
 * Single-select assignee picker (org members), generalised from InstanceForm's
 * MemberPicker. `value` is a userId or null (unassigned). Renders the selected
 * member as an avatar + name in the trigger.
 */
export function AssigneePicker({
  value,
  members,
  onChange,
  disabled,
}: {
  value: string | null
  members: ReadonlyArray<OrgMember>
  onChange: (userId: string | null) => void
  disabled?: boolean
}) {
  const selected = members.find((m) => m.userId === value)
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-full">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            {selected ? (
              <>
                <MemberAvatar member={selected} size={18} />
                <span className="truncate">{memberLabel(selected)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Unassigned</SelectItem>
        {members.map((m) => (
          <SelectItem key={m.userId} value={m.userId}>
            <span className="flex items-center gap-1.5">
              <MemberAvatar member={m} size={18} />
              {memberLabel(m)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
