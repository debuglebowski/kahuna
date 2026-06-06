import { type FormEvent, useState } from "react"
import { Button, Field, Input, Select } from "./ui"

export interface FieldDef {
  readonly name: string
  readonly label: string
  readonly type?: string
  readonly options?: ReadonlyArray<string>
}

/** A compact horizontal capture form driven by a field spec. */
export function InlineForm({
  fields,
  submitLabel,
  onSubmit,
  pending,
}: {
  fields: ReadonlyArray<FieldDef>
  submitLabel: string
  onSubmit: (values: Record<string, string>) => void
  pending?: boolean
}) {
  const [v, setV] = useState<Record<string, string>>({})
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const eff = { ...v }
    for (const f of fields) {
      if (f.options && !(f.name in eff)) eff[f.name] = f.options[0] ?? ""
    }
    onSubmit(eff)
    setV({})
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      {fields.map((f) => (
        <div key={f.name} className="min-w-28 flex-1">
          <Field label={f.label}>
            {f.options ? (
              <Select
                value={v[f.name] ?? f.options[0] ?? ""}
                onChange={(e) => setV({ ...v, [f.name]: e.target.value })}
              >
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={f.type ?? "text"}
                value={v[f.name] ?? ""}
                onChange={(e) => setV({ ...v, [f.name]: e.target.value })}
              />
            )}
          </Field>
        </div>
      ))}
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  )
}
