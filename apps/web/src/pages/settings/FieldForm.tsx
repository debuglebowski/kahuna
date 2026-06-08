import { Check, Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Button, Field, Input, Select } from "../../components/ui"
import type { Concept, FieldConfig, Field as FieldDef, FieldKind } from "../../lib/api"

const KINDS: ReadonlyArray<FieldKind> = [
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "relation",
  "file",
  "computed",
  "user",
  "json",
  "money",
]

/** Scalar kinds that can carry `config.multiple`, and the formats per kind. */
const MULTIPLE_KINDS = new Set<FieldKind>(["text", "number", "date", "enum", "user"])
const FORMATS: Partial<Record<FieldKind, ReadonlyArray<string>>> = {
  text: ["email", "url", "phone", "slug", "color"],
  number: ["percent"],
}

export interface FieldFormValue {
  readonly name: string
  readonly kind: FieldKind
  readonly config: FieldConfig
}

/** Add or edit a field def. Name is a freely-editable label; only kind is locked. */
export function FieldForm({
  concepts,
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  concepts: ReadonlyArray<Concept>
  initial?: FieldDef
  onSubmit: (value: FieldFormValue) => void
  onCancel: () => void
  pending?: boolean
}) {
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? "")
  const [kind, setKind] = useState<FieldKind>(initial?.kind ?? "text")
  const [optionsText, setOptionsText] = useState((initial?.config.options ?? []).join(", "))
  const [transitions, setTransitions] = useState<Record<string, string[]>>(() => {
    const t = initial?.config.transitions ?? {}
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v]]))
  })
  const [target, setTarget] = useState(initial?.config.target ?? "")
  const [cardinality, setCardinality] = useState<"one" | "many">(
    initial?.config.cardinality ?? "many",
  )
  const [computedKind, setComputedKind] = useState<"decay" | "momentum">(
    initial?.config.computedKind ?? "decay",
  )
  const [params, setParams] = useState<Record<string, string>>(() => {
    const p = initial?.config.params ?? {}
    return {
      forRelation: String(p.forRelation ?? ""),
      onRelation: String(p.onRelation ?? ""),
      dateField: String(p.dateField ?? ""),
    }
  })
  const [multiple, setMultiple] = useState(initial?.config.multiple ?? false)
  const [format, setFormat] = useState(initial?.config.format ?? "")

  const options = useMemo(
    () =>
      optionsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [optionsText],
  )

  const baseConfig = (): FieldConfig => {
    switch (kind) {
      case "enum": {
        const t: Record<string, string[]> = {}
        for (const from of options) {
          const allowed = (transitions[from] ?? []).filter((to) => options.includes(to))
          if (allowed.length) t[from] = allowed
        }
        return { options, ...(Object.keys(t).length ? { transitions: t } : {}) }
      }
      case "relation":
        return { target, cardinality }
      case "computed":
        return {
          computedKind,
          params: Object.fromEntries(Object.entries(params).filter(([, v]) => v.trim())),
        }
      default:
        return {}
    }
  }

  // Merge the orthogonal modifiers (multiple/format) onto the per-kind base.
  const buildConfig = (): FieldConfig => ({
    ...baseConfig(),
    ...(MULTIPLE_KINDS.has(kind) && multiple ? { multiple: true } : {}),
    ...((kind === "text" || kind === "number") && format ? { format } : {}),
  })

  const valid =
    (editing || name.trim().length > 0) &&
    (kind !== "enum" || options.length > 0) &&
    (kind !== "relation" || !!target) &&
    (kind !== "computed" || !!computedKind)

  const toggleTransition = (from: string, to: string) =>
    setTransitions((prev) => {
      const cur = new Set(prev[from] ?? [])
      if (cur.has(to)) cur.delete(to)
      else cur.add(to)
      return { ...prev, [from]: [...cur] }
    })

  return (
    <div className="space-y-4 rounded-md border border-gray-200 bg-gray-50 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Kind">
          <Select
            value={kind}
            disabled={editing}
            onChange={(e) => setKind(e.target.value as FieldKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {kind === "enum" && (
        <div className="space-y-3">
          <Field label="Options (comma-separated)">
            <Input
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder="lead, qualified, won"
            />
          </Field>
          {options.length > 1 && (
            <div>
              <span className="text-xs font-medium text-gray-500">
                Transitions (optional) — allowed next states per state
              </span>
              <div className="mt-2 space-y-1.5">
                {options.map((from) => (
                  <div key={from} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 font-medium text-gray-700">{from} →</span>
                    {options
                      .filter((to) => to !== from)
                      .map((to) => (
                        <label key={to} className="flex items-center gap-1 text-gray-600">
                          <input
                            type="checkbox"
                            checked={(transitions[from] ?? []).includes(to)}
                            onChange={() => toggleTransition(from, to)}
                          />
                          {to}
                        </label>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {kind === "relation" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target concept">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">—</option>
              {concepts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cardinality">
            <Select
              value={cardinality}
              onChange={(e) => setCardinality(e.target.value as "one" | "many")}
            >
              <option value="many">many</option>
              <option value="one">one</option>
            </Select>
          </Field>
        </div>
      )}

      {kind === "computed" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Computed kind">
            <Select
              value={computedKind}
              onChange={(e) => setComputedKind(e.target.value as "decay" | "momentum")}
            >
              <option value="decay">decay</option>
              <option value="momentum">momentum</option>
            </Select>
          </Field>
          {(["forRelation", "onRelation", "dateField"] as const).map((key) => (
            <Field key={key} label={key}>
              <Input
                value={params[key] ?? ""}
                onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      )}

      {MULTIPLE_KINDS.has(kind) && (
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={multiple}
            onChange={(e) => setMultiple(e.target.checked)}
          />
          Allow multiple values
        </label>
      )}

      {FORMATS[kind] && (
        <Field label="Format (optional)">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">none</option>
            {FORMATS[kind]?.map((fmt) => (
              <option key={fmt} value={fmt}>
                {fmt}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className="flex gap-2">
        <Button
          disabled={!valid || pending}
          onClick={() => onSubmit({ name: name.trim(), kind, config: buildConfig() })}
        >
          {editing ? <Check size={15} /> : <Plus size={15} />}
          {pending ? "Saving…" : editing ? "Save field" : "Add field"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X size={15} />
          Cancel
        </Button>
      </div>
    </div>
  )
}
