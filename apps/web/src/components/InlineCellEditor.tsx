import { type ReactNode, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LabelChip } from "../components/ui"
import type { Field, Instance } from "../lib/api"
import { capitalize, FieldValueCell } from "../lib/fieldDisplay"
import { type OrgMember, useMembers } from "../lib/members"
import { cn, initialsOf, showValue } from "../lib/utils"
import { DatePicker } from "./DatePicker"

/**
 * Field kinds editable directly in a list cell (quick-edit mode). Single-value
 * scalars only — `money`/`json`/`computed`/`relation`/`file` and any `multiple`
 * field stay read-only here and are edited on the detail page.
 */
const INLINE_KINDS = new Set(["text", "number", "date", "bool", "enum", "user"])
export const isInlineEditable = (f: Field): boolean =>
  INLINE_KINDS.has(f.kind) && !f.config.multiple

/** Map a text `format` to a friendlier native input type (mirrors InstanceForm). */
const FORMAT_INPUT_TYPE: Record<string, string> = { email: "email", url: "url", phone: "tel" }

// Borderless editors sized to sit in a cell without shifting its box: same
// padding as the read display, transparent until focused, inset focus ring.
const INPUT_CLS =
  "-mx-1 block w-full rounded border-0 bg-transparent px-1 py-0 text-sm leading-5 text-foreground outline-none focus:bg-accent/40 focus:ring-1 focus:ring-inset focus:ring-ring"
// Invisible dropdown trigger: no border/bg/padding/margin — just the value + a
// chevron; options appear on click. Subtle inset ring on keyboard focus only.
const TRIGGER_CLS =
  "h-auto gap-1 border-0 bg-transparent p-0 shadow-none data-[size=default]:h-auto focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50"

export type SaveCell = (instance: Instance, fieldId: string, value: unknown) => Promise<void>

/** Avatar + name (no link), matching the read `user` pill. Rendered in each
 *  option; Radix mirrors the selected one into the trigger. */
function MemberTag({ member }: { member: OrgMember }) {
  const email = member.user?.email ?? undefined
  const name = member.user?.name?.trim() || email || member.userId
  return (
    <span className="inline-flex items-center gap-1.5">
      <Avatar className="size-4">
        <AvatarImage src={member.user?.image ?? undefined} alt="" />
        <AvatarFallback className="text-[9px]">
          {initialsOf(member.user?.name, email ?? member.userId)}
        </AvatarFallback>
      </Avatar>
      <span className="max-w-40 truncate">{name}</span>
    </span>
  )
}

/** `user` editor: a select of avatar + name rows; the trigger mirrors the picked
 *  member (via SelectValue, like enum). Picking commits (no clearing). */
function UserCellEditor({
  value,
  saving,
  onPick,
}: {
  value: unknown
  saving: boolean
  onPick: (userId: string) => void
}) {
  const { members, deactivatedSet, isPending } = useMembers()
  const current = typeof value === "string" && value ? value : undefined
  const assignable = members.filter((m) => !deactivatedSet.has(m.userId))
  // Keep a since-deactivated current value selectable so the trigger can show it.
  const options =
    current && !assignable.some((m) => m.userId === current)
      ? [...members.filter((m) => m.userId === current), ...assignable]
      : assignable
  return (
    <Select
      value={current}
      disabled={saving}
      onValueChange={(v) => {
        if (v && v !== current) onPick(v)
      }}
    >
      <SelectTrigger className={TRIGGER_CLS} onClick={(e) => e.stopPropagation()}>
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {isPending ? "Loading…" : "No members"}
          </div>
        ) : (
          options.map((m) => (
            <SelectItem key={m.userId} value={m.userId}>
              <MemberTag member={m} />
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  )
}

/**
 * One editable list cell, rendered to look like the read cell: `enum` shows the
 * colored chip, `bool` the ✓/✕ icon, `user` the avatar pill, `date` a calendar
 * popover — each interactive. `text`/`number` are click-to-edit (Enter or blur
 * commits, Esc cancels). A blank/invalid input is treated as "no change" — the
 * engine can't clear a typed field, so quick-edit can change but not empty a
 * value (clear it on the detail page instead).
 */
export function EditableCell({
  field,
  instance,
  onSave,
}: {
  field: Field
  instance: Instance
  onSave: SaveCell
}) {
  const stored = instance.state[field.id]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const commit = async (value: unknown) => {
    setSaving(true)
    setErr(null)
    try {
      await onSave(instance, field.id, value)
      setEditing(false)
    } catch (e) {
      setErr((e as { message?: string })?.message ?? "Couldn't save")
    } finally {
      setSaving(false)
    }
  }

  const shell = (children: ReactNode) => (
    <span
      title={err ?? undefined}
      className={cn(
        "inline-flex w-full items-center",
        saving && "opacity-50",
        err && "rounded ring-1 ring-destructive",
      )}
    >
      {children}
    </span>
  )

  // bool — the same ✓/✕ as the read cell, clickable to toggle.
  if (field.kind === "bool") {
    return shell(
      <button
        type="button"
        disabled={saving}
        aria-label={`Toggle ${field.name}`}
        className="-mx-1 flex items-center rounded px-1 hover:bg-accent/40"
        onClick={(e) => {
          e.stopPropagation()
          commit(stored !== true)
        }}
      >
        <FieldValueCell field={field} value={stored} />
      </button>,
    )
  }

  // user — avatar pill in the trigger, avatar rows in the dropdown.
  if (field.kind === "user") {
    return shell(<UserCellEditor value={stored} saving={saving} onPick={commit} />)
  }

  // enum — the colored chip in the trigger and the dropdown options (value stays
  // the raw stored option). No "clear" (change-only).
  if (field.kind === "enum") {
    const cur = stored != null && stored !== "" ? String(stored) : undefined
    return shell(
      <Select
        value={cur}
        disabled={saving}
        onValueChange={(v) => {
          if (v !== cur) commit(v)
        }}
      >
        <SelectTrigger className={TRIGGER_CLS} onClick={(e) => e.stopPropagation()}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {(field.config.options ?? []).map((o) => (
            <SelectItem key={o} value={o}>
              <LabelChip color={field.config.optionColors?.[o] ?? null}>{capitalize(o)}</LabelChip>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    )
  }

  // date — popover calendar; the trigger shows the formatted date (matches read).
  if (field.kind === "date") {
    return shell(
      <DatePicker
        value={typeof stored === "string" ? stored : undefined}
        onChange={(v) => commit(v)}
        triggerClassName="-mx-1 rounded px-1 leading-5 hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />,
    )
  }

  // text / number — click to edit; Enter/blur commit, Esc cancels.
  if (!editing) {
    const blank = stored === null || stored === undefined || stored === ""
    return (
      <button
        type="button"
        className="-mx-1 block w-full truncate rounded px-1 text-left leading-5 hover:bg-accent/40"
        onClick={(e) => {
          e.stopPropagation()
          setErr(null)
          setDraft(stored == null ? "" : String(stored))
          setEditing(true)
        }}
      >
        {blank ? <span className="text-muted-foreground">—</span> : showValue(stored)}
      </button>
    )
  }

  const finish = () => {
    const s = draft.trim()
    // Blank or non-numeric → no change (quick-edit can't clear a typed field).
    if (s === "" || (field.kind === "number" && !Number.isFinite(Number(s)))) {
      setEditing(false)
      return
    }
    const wire: unknown = field.kind === "number" ? Number(s) : s
    if (wire === stored) {
      setEditing(false)
      return
    }
    commit(wire)
  }

  return shell(
    <input
      // biome-ignore lint/a11y/noAutofocus: cell enters edit mode on click — focus is expected
      autoFocus
      type={
        field.kind === "number"
          ? "number"
          : (FORMAT_INPUT_TYPE[field.config.format ?? ""] ?? "text")
      }
      value={draft}
      disabled={saving}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          finish()
        } else if (e.key === "Escape") {
          e.preventDefault()
          setEditing(false)
        }
      }}
      className={INPUT_CLS}
    />,
  )
}
