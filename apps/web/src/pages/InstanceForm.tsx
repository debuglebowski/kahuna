import { useQuery } from "@tanstack/react-query"
import { Check, Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { LABELS_KEY } from "../../rpc/contract"
import { LabelMultiSelect } from "../components/LabelMultiSelect"
import { Button, Field, Input } from "../components/ui"
import { api, type Field as FieldDef } from "../lib/api"
import { memberLabel, useMembers } from "../lib/members"

/**
 * Kinds a user can set when creating an instance. Mirrors the engine's
 * `validateValue` — relation/file/computed are derived or set elsewhere
 * (RelationService / attachments / computed) and are excluded from the form.
 */
const EDITABLE = new Set(["text", "number", "date", "bool", "enum", "user", "json", "money"])

/** Map a text `format` to a friendlier native input type. */
const FORMAT_INPUT_TYPE: Record<string, string> = { email: "email", url: "url", phone: "tel" }

/** Mirrors the engine's `isMissing` (requirement checks). */
const isMissing = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)

/** Convert a stored state value (wire shape) into the form's raw input shape. */
const toRaw = (f: FieldDef, v: unknown): unknown => {
  if (v === undefined || v === null) return undefined
  switch (f.kind) {
    case "bool":
      return v === true
    case "user":
    case "enum":
      return v
    case "money": {
      const m = v as { amount?: unknown; currency?: unknown }
      return { amount: String(m.amount ?? ""), currency: String(m.currency ?? "") }
    }
    case "json":
      return typeof v === "string" ? v : JSON.stringify(v, null, 2)
    case "date":
      // Stored as ISO — the native date input wants bare YYYY-MM-DD.
      return Array.isArray(v) ? v.map((x) => String(x).slice(0, 10)) : String(v).slice(0, 10)
    default:
      // text / number
      return Array.isArray(v) ? v.map(String) : String(v)
  }
}

/** Picks org member(s) for a `user` field, fed by the BetterAuth org.
 *  Deactivated members are not assignable (hidden here), but an already-stored
 *  deactivated value stays visible so the field doesn't silently blank out. */
function MemberPicker({
  value,
  multiple,
  onChange,
}: {
  value: unknown
  multiple: boolean
  onChange: (v: unknown) => void
}) {
  const { members: allMembers, deactivatedSet } = useMembers()
  const members = allMembers.filter((m) => !deactivatedSet.has(m.userId))

  if (multiple) {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : [])
    return (
      <div className="space-y-1">
        {members.map((m) => (
          <Label
            key={m.userId}
            className="flex items-center gap-2 text-sm font-normal text-foreground"
          >
            <Checkbox
              checked={selected.has(m.userId)}
              onCheckedChange={(c) => {
                const next = new Set(selected)
                if (c === true) next.add(m.userId)
                else next.delete(m.userId)
                onChange([...next])
              }}
            />
            {m.user?.name?.trim() || m.user?.email || m.userId}
          </Label>
        ))}
        {members.length === 0 && <p className="text-xs text-muted-foreground">No members.</p>}
      </div>
    )
  }
  // A stored value pointing at a deactivated/former member still needs an item
  // so the Radix trigger can render it (it's not in the assignable list).
  const current = typeof value === "string" && value ? value : null
  const stale = current && !members.some((m) => m.userId === current)
  return (
    // Radix Select reserves "" — use a sentinel for the "none" choice.
    <Select
      value={current ?? "__none"}
      onValueChange={(v) => onChange(v === "__none" ? undefined : v)}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">—</SelectItem>
        {stale && (
          <SelectItem value={current} disabled>
            {memberLabel(
              allMembers.find((m) => m.userId === current),
              "former member",
            )}
          </SelectItem>
        )}
        {members.map((m) => (
          <SelectItem key={m.userId} value={m.userId}>
            {m.user?.name?.trim() || m.user?.email || m.userId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A dynamic create/edit form driven by a concept's field defs. */
export function InstanceForm({
  fields,
  defaultLabelIds = [],
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  fields: ReadonlyArray<FieldDef>
  /** The concept's default label ids — pre-selected for the new item. */
  defaultLabelIds?: ReadonlyArray<string>
  /** Edit mode: the instance's current state (keyed by field id). Blank inputs
   *  are omitted from the patch (the engine can't clear typed fields), and the
   *  labels section is hidden — labels are edited on the item page itself. */
  initial?: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => void
  onCancel: () => void
  pending?: boolean
}) {
  const editing = initial !== undefined
  const editable = useMemo(() => fields.filter((f) => EDITABLE.has(f.kind)), [fields])
  const omitted = fields.length - editable.length
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (!initial) return {}
    const seeded: Record<string, unknown> = {}
    for (const f of editable) {
      const raw = toRaw(f, initial[f.id])
      if (raw !== undefined) seeded[f.name] = raw
    }
    return seeded
  })
  const [missing, setMissing] = useState<string[]>([])
  const labelVocab = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const [labelIds, setLabelIds] = useState<string[]>(() => [...defaultLabelIds])

  const set = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }))

  // Coerce raw inputs into the wire shape, omitting blanks (the engine rejects
  // wrong types, so we only send fields the user actually filled). Form-local
  // state is keyed by field name (unique within a concept); the wire payload is
  // keyed by field id.
  const build = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const f of editable) {
      const raw = values[f.name]
      const multiple = !!f.config.multiple
      if (f.kind === "bool") {
        out[f.id] = raw === true
        continue
      }
      if (f.kind === "user") {
        if (multiple) {
          const arr = (Array.isArray(raw) ? raw : []).filter((x): x is string => !!x)
          if (arr.length) out[f.id] = arr
        } else if (typeof raw === "string" && raw) {
          out[f.id] = raw
        }
        continue
      }
      if (f.kind === "money") {
        const m = (raw ?? {}) as { amount?: string; currency?: string }
        const amount = Number(m.amount)
        if (m.amount !== undefined && m.amount !== "" && Number.isFinite(amount)) {
          out[f.id] = { amount, currency: (m.currency || "USD").toUpperCase() }
        }
        continue
      }
      if (f.kind === "json") {
        const s = typeof raw === "string" ? raw.trim() : ""
        if (!s) continue
        try {
          out[f.id] = JSON.parse(s)
        } catch {
          out[f.id] = s
        }
        continue
      }
      // text / number / date (+ optional multiple)
      if (multiple) {
        const parts = (typeof raw === "string" ? raw.split("\n") : Array.isArray(raw) ? raw : [])
          .map((x) => String(x).trim())
          .filter(Boolean)
        const vals = f.kind === "number" ? parts.map(Number).filter(Number.isFinite) : parts
        if (vals.length) out[f.id] = vals
        continue
      }
      const s = typeof raw === "string" ? raw.trim() : ""
      if (!s) continue
      if (f.kind === "number") {
        const n = Number(s)
        if (Number.isFinite(n)) out[f.id] = n
      } else {
        out[f.id] = s
      }
    }
    // Per-item labels: send the (live-filtered) selection so a since-deleted
    // default id never reaches the server. While the vocab is still loading we
    // omit __labels, letting the server snapshot the concept's defaults.
    // Edits never touch labels — the item page's labels card owns them.
    if (!editing && labelVocab.data) {
      const live = new Set(labelVocab.data.map((l) => l.id))
      out[LABELS_KEY] = labelIds.filter((id) => live.has(id))
    }
    return out
  }

  const renderInput = (f: FieldDef) => {
    const multiple = !!f.config.multiple
    switch (f.kind) {
      case "bool":
        return (
          <Label className="flex items-center gap-2 text-sm font-normal text-foreground">
            <Checkbox
              checked={values[f.name] === true}
              onCheckedChange={(c) => set(f.name, c === true)}
            />
            {f.name}
          </Label>
        )
      case "enum":
        if (multiple) {
          const selected = new Set(
            Array.isArray(values[f.name]) ? (values[f.name] as string[]) : [],
          )
          return (
            <div className="space-y-1">
              {(f.config.options ?? []).map((o) => (
                <Label
                  key={o}
                  className="flex items-center gap-2 text-sm font-normal text-foreground"
                >
                  <Checkbox
                    checked={selected.has(o)}
                    onCheckedChange={(c) => {
                      const next = new Set(selected)
                      if (c === true) next.add(o)
                      else next.delete(o)
                      set(f.name, [...next])
                    }}
                  />
                  {o}
                </Label>
              ))}
            </div>
          )
        }
        return (
          <Select
            value={
              values[f.name] != null && values[f.name] !== "" ? String(values[f.name]) : "__none"
            }
            onValueChange={(v) => set(f.name, v === "__none" ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">—</SelectItem>
              {(f.config.options ?? []).map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      case "user":
        return (
          <MemberPicker
            value={values[f.name]}
            multiple={multiple}
            onChange={(v) => set(f.name, v)}
          />
        )
      case "money": {
        const m = (values[f.name] ?? {}) as { amount?: string; currency?: string }
        return (
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="0.00"
              value={m.amount ?? ""}
              onChange={(e) => set(f.name, { ...m, amount: e.target.value })}
            />
            <Input
              className="w-20"
              placeholder="USD"
              value={m.currency ?? ""}
              onChange={(e) => set(f.name, { ...m, currency: e.target.value })}
            />
          </div>
        )
      }
      case "json":
        return (
          <Textarea
            rows={3}
            className="font-mono text-xs"
            placeholder='{ "key": "value" }'
            value={typeof values[f.name] === "string" ? (values[f.name] as string) : ""}
            onChange={(e) => set(f.name, e.target.value)}
          />
        )
      default:
        // text / number / date
        if (multiple) {
          return (
            <Textarea
              rows={3}
              placeholder="one value per line"
              value={
                Array.isArray(values[f.name])
                  ? (values[f.name] as string[]).join("\n")
                  : typeof values[f.name] === "string"
                    ? (values[f.name] as string)
                    : ""
              }
              onChange={(e) => set(f.name, e.target.value)}
            />
          )
        }
        return (
          <Input
            type={
              f.kind === "number"
                ? "number"
                : f.kind === "date"
                  ? "date"
                  : (FORMAT_INPUT_TYPE[f.config.format ?? ""] ?? "text")
            }
            value={String(values[f.name] ?? "")}
            onChange={(e) => set(f.name, e.target.value)}
          />
        )
    }
  }

  return (
    <div className="space-y-4">
      {editable.length === 0 ? (
        <p className="text-sm text-muted-foreground">This concept has no editable fields.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {editable.map((f) =>
            f.kind === "bool" ? (
              <div key={f.id} className="flex items-end">
                {renderInput(f)}
              </div>
            ) : (
              <Field
                key={f.id}
                label={f.config.requirement === "required" ? `${f.name} *` : f.name}
              >
                {renderInput(f)}
              </Field>
            ),
          )}
        </div>
      )}

      {omitted > 0 && (
        <p className="text-xs text-muted-foreground">
          {omitted} relation/file/computed field{omitted > 1 ? "s" : ""}{" "}
          {editing ? "are managed outside this form." : "are set after creating."}
        </p>
      )}

      {!editing && (labelVocab.data?.length ?? 0) > 0 && (
        <Field label="Labels">
          <LabelMultiSelect
            all={labelVocab.data ?? []}
            selectedIds={labelIds}
            onChange={setLabelIds}
          />
        </Field>
      )}

      {missing.length > 0 && (
        <p className="text-sm text-destructive">Required: {missing.join(", ")}</p>
      )}

      <div className="flex gap-2">
        <Button
          disabled={pending}
          onClick={() => {
            // Pre-check required values (the engine enforces this too) so the
            // user gets field names instead of a generic validation error.
            const out = build()
            const miss = editable
              .filter((f) => f.config.requirement === "required" && isMissing(out[f.id]))
              .map((f) => f.name)
            setMissing(miss)
            if (miss.length === 0) onSubmit(out)
          }}
        >
          {editing ? <Check size={15} /> : <Plus size={15} />}
          {pending ? (editing ? "Saving…" : "Creating…") : editing ? "Save" : "Create"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          <X size={15} />
          Cancel
        </Button>
      </div>
    </div>
  )
}
