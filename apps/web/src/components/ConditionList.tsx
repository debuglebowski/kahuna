import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useMemo } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Field, type Label, type SidebarCondition } from "@/lib/api"
import { IconButton, Input } from "./ui"

/** Live field defs for a concept (shared by the sidebar + dashboard editors). */
export const useFields = (conceptId: string) =>
  useQuery({
    queryKey: ["fields", conceptId],
    queryFn: () => api.listFields(conceptId),
    enabled: !!conceptId,
  })

/** Coerce a free-text equality value to match the field's stored JSON type. */
export const coerce = (raw: string, field: Field | undefined): unknown => {
  if (field?.kind === "number" || field?.kind === "money") return Number(raw)
  if (field?.kind === "bool") return raw === "true"
  return raw
}

/**
 * One condition row: a label (has-label) or a field (equals). `labelOnly`
 * restricts the picker to labels (concept-level rules can't match fields).
 * Shared by the sidebar `SectionEditor` and the dashboard `WidgetEditor` so the
 * authoring UI + the `eq`/`hasLabel` model stay in one place.
 */
export function ConditionList({
  conceptId,
  conditions,
  labels,
  onChange,
  labelOnly,
}: {
  conceptId: string
  conditions: readonly SidebarCondition[]
  labels: readonly Label[]
  onChange: (next: SidebarCondition[]) => void
  labelOnly?: boolean
}) {
  const fields = useFields(conceptId)
  const liveFields = useMemo(
    () => (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file"),
    [fields.data],
  )
  const set = (i: number, c: SidebarCondition) =>
    onChange(conditions.map((x, j) => (j === i ? c : x)))
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i))

  return (
    <div className="space-y-1.5">
      {conditions.map((cond, i) => {
        const field = liveFields.find((f) => f.id === cond.field)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={cond.op === "hasLabel" ? "__label" : cond.field}
              onValueChange={(v) =>
                set(
                  i,
                  v === "__label"
                    ? { field: "__labels", op: "hasLabel", value: labels[0]?.id ?? "" }
                    : { field: v, op: "eq", value: "" },
                )
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__label">Has label</SelectItem>
                {!labelOnly &&
                  liveFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name} =
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {cond.op === "hasLabel" ? (
              <Select
                value={String(cond.value)}
                onValueChange={(v) => set(i, { ...cond, value: v })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {labels.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field?.kind === "enum" ? (
              <Select
                value={cond.value ? String(cond.value) : "__none"}
                onValueChange={(v) => set(i, { ...cond, value: v === "__none" ? "" : v })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">—</SelectItem>
                  {(field.config.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={String(cond.value ?? "")}
                placeholder="value"
                onChange={(e) => set(i, { ...cond, value: coerce(e.target.value, field) })}
                className="flex-1"
              />
            )}
            <IconButton aria-label="Remove condition" onClick={() => remove(i)}>
              <X size={14} />
            </IconButton>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...conditions,
            { field: "__labels", op: "hasLabel", value: labels[0]?.id ?? "" },
          ])
        }
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        + Condition
      </button>
    </div>
  )
}
