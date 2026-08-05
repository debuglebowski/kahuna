import { type ReactNode, useRef, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import type { Field, RecordVersion } from "../../lib/api"
import { capitalize, FieldValueCell, formatMoney } from "../../lib/fieldDisplay"
import { memberLabel, useMembers } from "../../lib/members"
import { cn } from "../../lib/utils"
import { EditableCell, isInlineEditable, type SaveCell } from "../InlineCellEditor"
import { LabelChip } from "../ui"

/**
 * Inline editor for one field on the record version detail page. The six single
 * scalars reuse the list quick-edit cell; the kinds the list excludes —
 * `money`, `json`, and `multiple` text/number/date/enum/user — get their own
 * editors here, since the detail page is where they're meant to be edited.
 * Relation/file/computed/richtext stay read-only: they're owned by other
 * surfaces (Connected tile, attachments, derived values, Document tile).
 */
export function DetailFieldEditor({
  field,
  recordVersion,
  onSave,
}: {
  field: Field
  recordVersion: RecordVersion
  onSave: SaveCell
}) {
  const multiple = !!field.config.multiple
  if (isInlineEditable(field))
    return (
      <EditableCell
        field={field}
        recordVersion={recordVersion}
        onSave={onSave}
        align="right"
        allowClear={canClear(field)}
      />
    )
  if (field.kind === "money" && !multiple)
    return <MoneyCell field={field} recordVersion={recordVersion} onSave={onSave} />
  if (field.kind === "json" && !multiple)
    return <JsonCell field={field} recordVersion={recordVersion} onSave={onSave} />
  if (multiple && field.kind === "enum")
    return <MultiEnumCell field={field} recordVersion={recordVersion} onSave={onSave} />
  if (multiple && field.kind === "user")
    return <MultiUserCell field={field} recordVersion={recordVersion} onSave={onSave} />
  if (multiple && (field.kind === "text" || field.kind === "number" || field.kind === "date"))
    return <ListCell field={field} recordVersion={recordVersion} onSave={onSave} />
  return <FieldValueCell field={field} value={recordVersion.state[field.id]} />
}

/** A required value can't be blanked (engine rule), and a transition-ruled enum
 *  can't escape its state machine by clearing — no clear affordance for either. */
const canClear = (f: Field): boolean =>
  f.config.requirement !== "required" && !(f.kind === "enum" && f.config.transitions)

type CellProps = { field: Field; recordVersion: RecordVersion; onSave: SaveCell }

/** Per-cell autosave state, mirroring EditableCell's commit/err/saving shape.
 *  Returns whether the save succeeded so callers can close their editor. */
function useCellSave({ recordVersion, field, onSave }: CellProps) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const commit = async (value: unknown): Promise<boolean> => {
    setSaving(true)
    setErr(null)
    try {
      await onSave(recordVersion, field.id, value)
      return true
    } catch (e) {
      setErr((e as { message?: string })?.message ?? "Couldn't save")
      return false
    } finally {
      setSaving(false)
    }
  }
  return { saving, err, commit }
}

function Shell({
  saving,
  err,
  children,
}: {
  saving: boolean
  err: string | null
  children: ReactNode
}) {
  return (
    <span
      title={err ?? undefined}
      className={cn(
        "inline-flex w-full items-center justify-end",
        saving && "opacity-50",
        err && "rounded ring-1 ring-destructive",
      )}
    >
      {children}
    </span>
  )
}

// Same borderless in-place styling as the quick-edit cells — no hover/focus
// tint; the editors are visually identical to the read cells.
const TRIGGER_BTN = "-mx-1 block w-full truncate rounded px-1 text-right leading-5"
const INPUT_CLS =
  "rounded border-0 bg-transparent px-1 py-0 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"

/** Accepts "4500", "4,500.50 EUR", "-12 sek" — an amount with an optional
 *  trailing 3-letter currency code. */
const MONEY_RE = /^(-?[\d,\s]*\d(?:\.\d+)?)\s*([A-Za-z]{3})?$/

/** `money` — one always-rendered input: shows the Intl-formatted value at
 *  rest ("$4,500.00"), focusing reveals the raw "4500 USD" for editing.
 *  Enter/blur commit, Esc reverts, blanking clears (when the field allows). */
function MoneyCell(props: CellProps) {
  const { field, recordVersion } = props
  const stored = recordVersion.state[field.id]
  const { saving, err, commit } = useCellSave(props)
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState("")
  const cancelled = useRef(false)

  const m = (stored ?? {}) as { amount?: unknown; currency?: unknown }
  const display = formatMoney(stored) ?? ""
  const raw =
    typeof m.amount === "number"
      ? `${m.amount}${typeof m.currency === "string" && m.currency ? ` ${m.currency}` : ""}`
      : ""

  const finish = (input: string) => {
    const s = input.trim()
    if (s === raw) return
    if (s === "") {
      if (canClear(field) && stored != null) commit(null)
      return
    }
    const match = s.match(MONEY_RE)
    if (!match) return // unparseable → revert to the stored value
    const n = Number(match[1]!.replace(/[,\s]/g, ""))
    if (!Number.isFinite(n)) return
    const cur = (
      match[2] ?? (typeof m.currency === "string" && m.currency ? m.currency : "USD")
    ).toUpperCase()
    if (m.amount === n && m.currency === cur) return
    commit({ amount: n, currency: cur })
  }

  return (
    <Shell saving={saving} err={err}>
      <input
        aria-label={field.name}
        inputMode="decimal"
        value={focused ? draft : display}
        placeholder="—"
        disabled={saving}
        onFocus={() => {
          setDraft(raw)
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
        className={cn(INPUT_CLS, "-mx-1 block w-full px-1 text-right")}
      />
    </Shell>
  )
}

/** `json` — click to edit the raw blob in a textarea; ⌘/Ctrl+Enter or blur
 *  commits (parsed when valid JSON, kept as a string otherwise), Esc cancels. */
function JsonCell(props: CellProps) {
  const { field, recordVersion } = props
  const stored = recordVersion.state[field.id]
  const { saving, err, commit } = useCellSave(props)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")

  if (!editing) {
    return (
      <Shell saving={saving} err={err}>
        <button
          type="button"
          className={TRIGGER_BTN}
          onClick={() => {
            setDraft(
              stored == null
                ? ""
                : typeof stored === "string"
                  ? stored
                  : JSON.stringify(stored, null, 2),
            )
            setEditing(true)
          }}
        >
          <FieldValueCell field={field} value={stored} />
        </button>
      </Shell>
    )
  }

  const finish = async () => {
    const s = draft.trim()
    if (s === "") {
      if (canClear(field) && stored != null) {
        if (await commit(null)) setEditing(false)
      } else setEditing(false)
      return
    }
    let wire: unknown = s
    try {
      wire = JSON.parse(s)
    } catch {
      // not JSON — store the raw string (mirrors InstanceForm)
    }
    if (JSON.stringify(wire) === JSON.stringify(stored)) {
      setEditing(false)
      return
    }
    if (await commit(wire)) setEditing(false)
  }

  return (
    <Shell saving={saving} err={err}>
      <Textarea
        autoFocus
        rows={4}
        placeholder='{ "key": "value" }'
        className="font-mono text-xs"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            finish()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setEditing(false)
          }
        }}
      />
    </Shell>
  )
}

/** `multiple` text/number/date — click to edit one value per line; blur or
 *  ⌘/Ctrl+Enter commits, Esc cancels. Emptying the list clears the value. */
function ListCell(props: CellProps) {
  const { field, recordVersion } = props
  const stored = recordVersion.state[field.id]
  const list = Array.isArray(stored) ? stored : []
  const { saving, err, commit } = useCellSave(props)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")

  if (!editing) {
    return (
      <Shell saving={saving} err={err}>
        <button
          type="button"
          className={TRIGGER_BTN}
          onClick={() => {
            setDraft(
              list
                .map((v) => (field.kind === "date" ? String(v).slice(0, 10) : String(v)))
                .join("\n"),
            )
            setEditing(true)
          }}
        >
          <FieldValueCell field={field} value={stored} />
        </button>
      </Shell>
    )
  }

  const finish = async () => {
    const parts = draft
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
    const vals: unknown[] =
      field.kind === "number" ? parts.map(Number).filter(Number.isFinite) : parts
    if (vals.length === 0) {
      if (canClear(field) && list.length > 0) {
        if (await commit(null)) setEditing(false)
      } else setEditing(false)
      return
    }
    if (JSON.stringify(vals) === JSON.stringify(list)) {
      setEditing(false)
      return
    }
    if (await commit(vals)) setEditing(false)
  }

  return (
    <Shell saving={saving} err={err}>
      <Textarea
        autoFocus
        rows={Math.min(8, Math.max(3, list.length + 1))}
        placeholder="one value per line"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            finish()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setEditing(false)
          }
        }}
      />
    </Shell>
  )
}

/** Generic multi-pick: the read render opens a checkbox popover; closing it
 *  commits the changed selection (ordered by the option list). */
function MultiPick({
  props,
  options,
}: {
  props: CellProps
  options: ReadonlyArray<{ value: string; label: ReactNode }>
}) {
  const { field, recordVersion } = props
  const stored = recordVersion.state[field.id]
  const current = Array.isArray(stored) ? (stored as unknown[]).map(String) : []
  const { saving, err, commit } = useCellSave(props)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])

  const close = () => {
    const dirty = draft.length !== current.length || draft.some((x) => !current.includes(x))
    if (!dirty) return
    const picked = new Set(draft)
    const ordered = options.map((o) => o.value).filter((v) => picked.has(v))
    if (ordered.length === 0) {
      // Emptying clears (engine blocks it on required fields, so don't try).
      if (canClear(field)) commit(null)
    } else commit(ordered)
  }

  return (
    <Shell saving={saving} err={err}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          if (o) setDraft(current)
          else close()
          setOpen(o)
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className={TRIGGER_BTN} disabled={saving}>
            <FieldValueCell field={field} value={stored} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-2">
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {options.length === 0 && (
              <p className="px-1 py-1 text-xs text-muted-foreground">No options.</p>
            )}
            {options.map((o) => (
              <Label
                key={o.value}
                className="flex items-center gap-2 rounded px-1 py-1 text-sm font-normal text-foreground hover:bg-accent/40"
              >
                <Checkbox
                  checked={draft.includes(o.value)}
                  onCheckedChange={(c) =>
                    setDraft((d) => (c === true ? [...d, o.value] : d.filter((x) => x !== o.value)))
                  }
                />
                {o.label}
              </Label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </Shell>
  )
}

function MultiEnumCell(props: CellProps) {
  const { field } = props
  const options = (field.config.options ?? []).map((o) => ({
    value: o,
    label: <LabelChip color={field.config.optionColors?.[o] ?? null}>{capitalize(o)}</LabelChip>,
  }))
  return <MultiPick props={props} options={options} />
}

function MultiUserCell(props: CellProps) {
  const { field, recordVersion } = props
  const { members, deactivatedSet } = useMembers()
  const assignable = members.filter((m) => !deactivatedSet.has(m.userId))
  const stored = recordVersion.state[field.id]
  const current = Array.isArray(stored) ? (stored as unknown[]).map(String) : []
  // Stored ids no longer assignable stay listed so they can be unchecked.
  const stale = current.filter((id) => !assignable.some((m) => m.userId === id))
  const options = [
    ...stale.map((id) => ({
      value: id,
      label: memberLabel(
        members.find((m) => m.userId === id),
        "former member",
      ),
    })),
    ...assignable.map((m) => ({
      value: m.userId,
      label: m.user?.name?.trim() || m.user?.email || m.userId,
    })),
  ]
  return <MultiPick props={props} options={options} />
}
