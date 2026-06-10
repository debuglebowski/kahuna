import { type ReactNode, useRef, useState } from "react"
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
import { cn, initialsOf } from "../lib/utils"
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
// box metrics as the read display, fully transparent at rest, on hover AND
// focused — no ring, no tint; the caret is the only sign of focus.
// (focus-visible is no escape hatch here: browsers match it on click for
// text-entry elements.)
const INPUT_CLS =
  "-mx-1 block w-full rounded border-0 bg-transparent px-1 py-0 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
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
 *  member (via SelectValue, like enum). Picking commits; with `allowClear` a
 *  "—" row commits `null` (the engine drops the value). */
function UserCellEditor({
  value,
  saving,
  allowClear,
  onPick,
}: {
  value: unknown
  saving: boolean
  allowClear?: boolean
  onPick: (userId: string | null) => void
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
        if (v === "__none") {
          if (current) onPick(null)
        } else if (v && v !== current) onPick(v)
      }}
    >
      <SelectTrigger className={TRIGGER_CLS} onClick={(e) => e.stopPropagation()}>
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent>
        {allowClear && current && <SelectItem value="__none">—</SelectItem>}
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
 * One editable cell, rendered to look like the read cell: `enum` shows the
 * colored chip, `bool` the ✓/✕ icon, `user` the avatar pill, `date` a calendar
 * popover — each interactive. `text`/`number` are click-to-edit (Enter or blur
 * commits, Esc cancels). Without `allowClear` a blank input is "no change"
 * (list quick-edit); with it, blanking commits an explicit `null` — the
 * engine's clear — and enum/user/date grow a "—"/Clear affordance. `align`
 * matches the host: left in list cells, right on the detail page.
 */
export function EditableCell({
  field,
  instance,
  onSave,
  align = "left",
  allowClear = false,
}: {
  field: Field
  instance: Instance
  onSave: SaveCell
  align?: "left" | "right"
  allowClear?: boolean
}) {
  const stored = instance.state[field.id]
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const cancelled = useRef(false)

  const commit = async (value: unknown) => {
    setSaving(true)
    setErr(null)
    try {
      await onSave(instance, field.id, value)
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
        align === "right" && "justify-end",
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
        className="-mx-1 flex items-center rounded px-1"
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
    return shell(
      <UserCellEditor value={stored} saving={saving} allowClear={allowClear} onPick={commit} />,
    )
  }

  // enum — the colored chip in the trigger and the dropdown options (value stays
  // the raw stored option). Clearing (when allowed) commits `null`.
  if (field.kind === "enum") {
    const cur = stored != null && stored !== "" ? String(stored) : undefined
    return shell(
      <Select
        value={cur}
        disabled={saving}
        onValueChange={(v) => {
          if (v === "__none") {
            if (cur != null) commit(null)
          } else if (v !== cur) commit(v)
        }}
      >
        <SelectTrigger className={TRIGGER_CLS} onClick={(e) => e.stopPropagation()}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {allowClear && cur && <SelectItem value="__none">—</SelectItem>}
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
        onClear={allowClear && stored != null ? () => commit(null) : undefined}
        triggerClassName="-mx-1 rounded px-1 leading-5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />,
    )
  }

  // text / number — an always-rendered transparent input, indistinguishable
  // from the read cell: no element swap on focus, so clicking puts the caret
  // exactly where you aimed and nothing shifts. While unfocused it mirrors the
  // stored value (placeholder "—" when blank); focus seeds a draft, blur or
  // Enter commits it, Esc reverts. `number` is a text input with a decimal
  // inputMode — native spinners would be a UI change on hover/focus.
  const display = stored == null ? "" : String(stored)
  const finish = (raw: string) => {
    const s = raw.trim()
    if (s === display.trim()) return
    if (s === "") {
      // Blank: with allowClear an explicit null clears the value; otherwise
      // (list quick-edit) a blank is "no change".
      if (allowClear && !(stored === null || stored === undefined || stored === "")) commit(null)
      return
    }
    if (field.kind === "number") {
      const n = Number(s)
      if (Number.isFinite(n) && n !== stored) commit(n)
      return
    }
    commit(s)
  }

  return shell(
    <input
      aria-label={field.name}
      type={
        field.kind === "number" ? "text" : (FORMAT_INPUT_TYPE[field.config.format ?? ""] ?? "text")
      }
      inputMode={field.kind === "number" ? "decimal" : undefined}
      value={focused ? draft : display}
      placeholder="—"
      disabled={saving}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => {
        setErr(null)
        setDraft(display)
        setFocused(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false)
        if (!cancelled.current) finish(draft)
        cancelled.current = false
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === "Escape") {
          e.preventDefault()
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
      className={cn(INPUT_CLS, align === "right" && "text-right")}
    />,
  )
}
