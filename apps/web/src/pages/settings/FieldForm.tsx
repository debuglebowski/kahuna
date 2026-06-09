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
import { IconPicker } from "../../components/IconPicker"
import { Button, Field, Input } from "../../components/ui"
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
  /** Display glyph: literal emoji or `lucide:Name`; null = none. */
  readonly icon: string | null
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
  const [icon, setIcon] = useState<string | null>(initial?.icon ?? null)
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
    <div className="space-y-4">
      <Field label="Name">
        <div className="flex items-center gap-2">
          <IconPicker value={icon} onChange={setIcon} />
          <Input value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind">
          <Select value={kind} disabled={editing} onValueChange={(v) => setKind(v as FieldKind)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {FORMATS[kind] && (
          <Field label="Format (optional)">
            <Select
              value={format || "__none"}
              onValueChange={(v) => setFormat(v === "__none" ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">none</SelectItem>
                {FORMATS[kind]?.map((fmt) => (
                  <SelectItem key={fmt} value={fmt}>
                    {fmt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      {MULTIPLE_KINDS.has(kind) && (
        <Label className="flex items-center gap-2 text-sm font-normal text-foreground">
          <Checkbox checked={multiple} onCheckedChange={(c) => setMultiple(c === true)} />
          Allow multiple values
        </Label>
      )}

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
              <span className="text-xs font-medium text-muted-foreground">
                Transitions (optional) — allowed next states per state
              </span>
              <div className="mt-2 space-y-1.5">
                {options.map((from) => (
                  <div key={from} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 font-medium text-foreground">{from} →</span>
                    {options
                      .filter((to) => to !== from)
                      .map((to) => (
                        <Label
                          key={to}
                          className="flex items-center gap-1 text-xs font-normal text-muted-foreground"
                        >
                          <Checkbox
                            className="size-3.5"
                            checked={(transitions[from] ?? []).includes(to)}
                            onCheckedChange={() => toggleTransition(from, to)}
                          />
                          {to}
                        </Label>
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
            <Select
              value={target || "__none"}
              onValueChange={(v) => setTarget(v === "__none" ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">—</SelectItem>
                {concepts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Cardinality">
            <Select value={cardinality} onValueChange={(v) => setCardinality(v as "one" | "many")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="many">many</SelectItem>
                <SelectItem value="one">one</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}

      {kind === "computed" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Computed kind">
            <Select
              value={computedKind}
              onValueChange={(v) => setComputedKind(v as "decay" | "momentum")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="decay">decay</SelectItem>
                <SelectItem value="momentum">momentum</SelectItem>
              </SelectContent>
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

      <div className="flex gap-2">
        <Button
          disabled={!valid || pending}
          onClick={() => onSubmit({ name: name.trim(), kind, config: buildConfig(), icon })}
        >
          {editing ? <Check size={15} /> : <Plus size={15} />}
          {pending ? "Saving…" : editing ? "Save field" : "Add field"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          <X size={15} />
          Cancel
        </Button>
      </div>
    </div>
  )
}
