import { useMemo, useState } from "react"
import { Button, Field, Input, Select } from "../components/ui"
import type { Field as FieldDef } from "../lib/api"

/**
 * Kinds a user can set when creating an instance. Mirrors the engine's
 * `validateValue` — relation/file/computed are derived or set elsewhere
 * (RelationService / attachments / computed) and are excluded from the form.
 */
const EDITABLE = new Set(["text", "number", "date", "bool", "enum"])

/** A dynamic create form driven by a concept's field defs. */
export function InstanceForm({
  fields,
  onSubmit,
  onCancel,
  pending,
}: {
  fields: ReadonlyArray<FieldDef>
  onSubmit: (values: Record<string, unknown>) => void
  onCancel: () => void
  pending?: boolean
}) {
  const editable = useMemo(() => fields.filter((f) => EDITABLE.has(f.kind)), [fields])
  const omitted = fields.length - editable.length
  const [values, setValues] = useState<Record<string, string | boolean>>({})

  const set = (name: string, v: string | boolean) =>
    setValues((prev) => ({ ...prev, [name]: v }))

  // Coerce raw inputs into the wire shape, omitting blanks (the engine rejects
  // wrong types, so we only send fields the user actually filled).
  const build = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const f of editable) {
      const raw = values[f.name]
      if (f.kind === "bool") {
        out[f.name] = raw === true
        continue
      }
      const s = typeof raw === "string" ? raw.trim() : ""
      if (!s) continue
      if (f.kind === "number") {
        const n = Number(s)
        if (Number.isFinite(n)) out[f.name] = n
      } else {
        out[f.name] = s
      }
    }
    return out
  }

  const renderInput = (f: FieldDef) => {
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
      default:
        return (
          <Input
            type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
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
              <div key={f.id} className="flex items-end">{renderInput(f)}</div>
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

      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => onSubmit(build())}>
          {pending ? "Creating…" : "Create"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
