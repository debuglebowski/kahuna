import { useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { LABELS_KEY } from "../../rpc/contract"
import { LabelMultiSelect } from "../components/LabelMultiSelect"
import { Button, Field, Input, Select } from "../components/ui"
import { api, type Field as FieldDef } from "../lib/api"
import { useFullOrg } from "./settings/SettingsLayout"

/**
 * Kinds a user can set when creating an instance. Mirrors the engine's
 * `validateValue` — relation/file/computed are derived or set elsewhere
 * (RelationService / attachments / computed) and are excluded from the form.
 */
const EDITABLE = new Set(["text", "number", "date", "bool", "enum", "user", "json", "money"])

/** Map a text `format` to a friendlier native input type. */
const FORMAT_INPUT_TYPE: Record<string, string> = { email: "email", url: "url", phone: "tel" }

/** Picks org member(s) for a `user` field, fed by the BetterAuth org. */
function MemberPicker({
  value,
  multiple,
  onChange,
}: {
  value: unknown
  multiple: boolean
  onChange: (v: unknown) => void
}) {
  const org = useFullOrg()
  const members = org.data?.members ?? []

  if (multiple) {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : [])
    return (
      <div className="space-y-1">
        {members.map((m) => (
          <label key={m.userId} className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={selected.has(m.userId)}
              onChange={(e) => {
                const next = new Set(selected)
                if (e.target.checked) next.add(m.userId)
                else next.delete(m.userId)
                onChange([...next])
              }}
            />
            {m.user?.name?.trim() || m.user?.email || m.userId}
          </label>
        ))}
        {members.length === 0 && <p className="text-xs text-gray-400">No members.</p>}
      </div>
    )
  }
  return (
    <Select
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">—</option>
      {members.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.user?.name?.trim() || m.user?.email || m.userId}
        </option>
      ))}
    </Select>
  )
}

/** A dynamic create form driven by a concept's field defs. */
export function InstanceForm({
  fields,
  defaultLabelIds = [],
  onSubmit,
  onCancel,
  pending,
}: {
  fields: ReadonlyArray<FieldDef>
  /** The concept's default label ids — pre-selected for the new item. */
  defaultLabelIds?: ReadonlyArray<string>
  onSubmit: (values: Record<string, unknown>) => void
  onCancel: () => void
  pending?: boolean
}) {
  const editable = useMemo(() => fields.filter((f) => EDITABLE.has(f.kind)), [fields])
  const omitted = fields.length - editable.length
  const [values, setValues] = useState<Record<string, unknown>>({})
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
          if (arr.length) out[f.name] = arr
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
        if (vals.length) out[f.name] = vals
        continue
      }
      const s = typeof raw === "string" ? raw.trim() : ""
      if (!s) continue
      if (f.kind === "number") {
        const n = Number(s)
        if (Number.isFinite(n)) out[f.name] = n
      } else {
        out[f.id] = s
      }
    }
    // Per-item labels: send the (live-filtered) selection so a since-deleted
    // default id never reaches the server. While the vocab is still loading we
    // omit __labels, letting the server snapshot the concept's defaults.
    if (labelVocab.data) {
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
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={values[f.name] === true}
              onChange={(e) => set(f.name, e.target.checked)}
            />
            {f.name}
          </label>
        )
      case "enum":
        if (multiple) {
          const selected = new Set(
            Array.isArray(values[f.name]) ? (values[f.name] as string[]) : [],
          )
          return (
            <div className="space-y-1">
              {(f.config.options ?? []).map((o) => (
                <label key={o} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={selected.has(o)}
                    onChange={(e) => {
                      const next = new Set(selected)
                      if (e.target.checked) next.add(o)
                      else next.delete(o)
                      set(f.name, [...next])
                    }}
                  />
                  {o}
                </label>
              ))}
            </div>
          )
        }
        return (
          <Select
            value={String(values[f.name] ?? "")}
            onChange={(e) => set(f.name, e.target.value)}
          >
            <option value="">—</option>
            {(f.config.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
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
          <textarea
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs outline-none focus:border-gray-500"
            placeholder='{ "key": "value" }'
            value={typeof values[f.name] === "string" ? (values[f.name] as string) : ""}
            onChange={(e) => set(f.name, e.target.value)}
          />
        )
      default:
        // text / number / date
        if (multiple) {
          return (
            <textarea
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-gray-500"
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
        <p className="text-sm text-gray-500">This concept has no editable fields.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {editable.map((f) =>
            f.kind === "bool" ? (
              <div key={f.id} className="flex items-end">
                {renderInput(f)}
              </div>
            ) : (
              <Field key={f.id} label={f.name}>
                {renderInput(f)}
              </Field>
            ),
          )}
        </div>
      )}

      {omitted > 0 && (
        <p className="text-xs text-gray-400">
          {omitted} relation/file/computed field{omitted > 1 ? "s" : ""} are set after creating.
        </p>
      )}

      {(labelVocab.data?.length ?? 0) > 0 && (
        <Field label="Labels">
          <LabelMultiSelect
            all={labelVocab.data ?? []}
            selectedIds={labelIds}
            onChange={setLabelIds}
          />
        </Field>
      )}

      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => onSubmit(build())}>
          <Plus size={15} />
          {pending ? "Creating…" : "Create"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X size={15} />
          Cancel
        </Button>
      </div>
    </div>
  )
}
