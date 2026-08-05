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
import {
  BANDS_FOR,
  type ConditionMatch,
  type ConditionOp,
  isMultiValue,
  LABEL_OPS,
  needsValue,
  type OpDef,
  opsForKind,
} from "@/lib/conditions"
import { useFullOrg } from "@/pages/settings/SettingsLayout"
import { MultiCombobox } from "./MultiCombobox"
import { MemberAvatar, memberLabel } from "./record/AssigneePicker"
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

/** The op a freshly-picked field starts on (first of its op list). */
const defaultOp = (field: Field | undefined): ConditionOp =>
  (field && opsForKind(field.kind)[0]?.op) || "eq"

/** A sensible starting value when the op changes (shape must match the op). */
const defaultValue = (op: ConditionOp, field: Field | undefined): unknown => {
  if (!needsValue(op)) return null
  if (isMultiValue(op)) return []
  if (op === "between") return ["", ""]
  if (field?.kind === "bool") return true
  return ""
}

const NONE = "__none"

/**
 * One condition row: field → op → value, with op/value editors driven by the
 * field's kind (see `opsForKind`). The pseudo-field "Label" matches against
 * `__labels`. `labelOnly` restricts the picker to labels (concept-level rules
 * can't match fields). Shared by the sidebar `SectionEditor`, the dashboard
 * `WidgetEditor` and the concept list `FilterBar` so the authoring UI + the
 * condition model stay in one place. Pass `onMatchChange` to also render the
 * all/any combine toggle.
 */
export function ConditionList({
  conceptId,
  conditions,
  labels,
  onChange,
  labelOnly,
  match,
  onMatchChange,
  transitions,
}: {
  conceptId: string
  conditions: readonly SidebarCondition[]
  labels: readonly Label[]
  onChange: (next: SidebarCondition[]) => void
  labelOnly?: boolean
  match?: ConditionMatch
  onMatchChange?: (m: ConditionMatch) => void
  /** Offer the transition ops (`changed to` / `changed from`). Automations only —
   *  they need a before-state, which no other surface has, so elsewhere they'd be
   *  a condition that can never match. */
  transitions?: boolean
}) {
  const fields = useFields(conceptId)
  const liveFields = useMemo(
    () => (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file"),
    [fields.data],
  )
  const org = useFullOrg()
  const members = org.data?.members ?? []

  const set = (i: number, c: SidebarCondition) =>
    onChange(conditions.map((x, j) => (j === i ? c : x)))
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i))

  const valueEditor = (cond: SidebarCondition, i: number, field: Field | undefined) => {
    if (!needsValue(cond.op)) return null

    // Label pseudo-field: pick a label.
    if (cond.field === "__labels") {
      return (
        <Select value={String(cond.value)} onValueChange={(v) => set(i, { ...cond, value: v })}>
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
      )
    }

    const kind = field?.kind

    if (kind === "enum") {
      const options = field?.config.options ?? []
      if (isMultiValue(cond.op)) {
        const selected = Array.isArray(cond.value) ? cond.value.map(String) : []
        return (
          <div className="flex-1">
            <MultiCombobox
              options={options.map((o) => ({ id: o, label: o }))}
              selectedIds={selected}
              onChange={(ids) => set(i, { ...cond, value: ids })}
              placeholder="Add value"
              searchPlaceholder="Search options…"
              emptyText="No options."
            />
          </div>
        )
      }
      return (
        <Select
          value={cond.value ? String(cond.value) : NONE}
          onValueChange={(v) => set(i, { ...cond, value: v === NONE ? "" : v })}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }

    if (kind === "user") {
      if (isMultiValue(cond.op)) {
        const selected = Array.isArray(cond.value) ? cond.value.map(String) : []
        return (
          <div className="flex-1">
            <MultiCombobox
              options={members.map((m) => ({
                id: m.userId,
                label: memberLabel(m),
                icon: <MemberAvatar member={m} size={16} />,
              }))}
              selectedIds={selected}
              onChange={(ids) => set(i, { ...cond, value: ids })}
              placeholder="Add member"
              searchPlaceholder="Search members…"
              emptyText="No members."
            />
          </div>
        )
      }
      return (
        <Select
          value={cond.value ? String(cond.value) : NONE}
          onValueChange={(v) => set(i, { ...cond, value: v === NONE ? "" : v })}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.userId} value={m.userId}>
                <span className="flex items-center gap-1.5">
                  <MemberAvatar member={m} size={16} />
                  {memberLabel(m)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }

    if (kind === "bool") {
      return (
        <Select
          value={cond.value === false ? "false" : "true"}
          onValueChange={(v) => set(i, { ...cond, value: v === "true" })}
        >
          <SelectTrigger className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
      )
    }

    if (kind === "computed") {
      const bands = BANDS_FOR[field?.config.computedKind ?? "decay"] ?? []
      return (
        <Select
          value={cond.value ? String(cond.value) : NONE}
          onValueChange={(v) => set(i, { ...cond, value: v === NONE ? "" : v })}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {bands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }

    const inputType =
      kind === "date" ? "date" : kind === "number" || kind === "money" ? "number" : "text"
    const parse = (raw: string): unknown =>
      inputType === "number" && raw !== "" ? Number(raw) : raw

    if (cond.op === "between") {
      const [lo, hi] = Array.isArray(cond.value) ? cond.value : ["", ""]
      const setPart = (idx: 0 | 1, raw: string) => {
        const next: unknown[] = [lo ?? "", hi ?? ""]
        next[idx] = parse(raw)
        set(i, { ...cond, value: next })
      }
      return (
        <div className="flex flex-1 items-center gap-1.5">
          <Input
            type={inputType}
            value={String(lo ?? "")}
            placeholder="min"
            onChange={(e) => setPart(0, e.target.value)}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            type={inputType}
            value={String(hi ?? "")}
            placeholder="max"
            onChange={(e) => setPart(1, e.target.value)}
            className="flex-1"
          />
        </div>
      )
    }

    return (
      <Input
        type={inputType}
        value={String(cond.value ?? "")}
        placeholder="value"
        onChange={(e) => set(i, { ...cond, value: parse(e.target.value) })}
        className="flex-1"
      />
    )
  }

  return (
    <div className="space-y-1.5">
      {conditions.map((cond, i) => {
        const isLabel = cond.field === "__labels"
        const field = liveFields.find((f) => f.id === cond.field)
        const ops: readonly OpDef[] = isLabel
          ? LABEL_OPS
          : opsForKind(field?.kind ?? "text", { transitions })
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
          <div key={i} className="flex items-center gap-1.5">
            <Select
              value={isLabel ? "__label" : cond.field}
              onValueChange={(v) => {
                if (v === "__label")
                  set(i, { field: "__labels", op: "hasLabel", value: labels[0]?.id ?? "" })
                else {
                  const f = liveFields.find((x) => x.id === v)
                  const op = defaultOp(f)
                  set(i, { field: v, op, value: defaultValue(op, f) })
                }
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__label">Label</SelectItem>
                {!labelOnly &&
                  liveFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select
              value={cond.op}
              onValueChange={(v) => {
                const op = v as ConditionOp
                // Keep the value when the shape is compatible, else reset it.
                const sameShape =
                  isMultiValue(op) === isMultiValue(cond.op) &&
                  (op === "between") === (cond.op === "between") &&
                  needsValue(op) === needsValue(cond.op)
                set(i, { ...cond, op, value: sameShape ? cond.value : defaultValue(op, field) })
              }}
            >
              <SelectTrigger className="w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ops.map((o) => (
                  <SelectItem key={o.op} value={o.op}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {valueEditor(cond, i, field)}
            <IconButton aria-label="Remove condition" onClick={() => remove(i)}>
              <X size={14} />
            </IconButton>
          </div>
        )
      })}
      <div className="flex items-center justify-between">
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
        {onMatchChange && conditions.length > 1 && (
          <div className="inline-flex overflow-hidden rounded-md border border-input text-xs">
            {(["all", "any"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onMatchChange(m)}
                className={
                  (match ?? "all") === m
                    ? "bg-primary px-2 py-0.5 font-medium text-primary-foreground"
                    : "px-2 py-0.5 text-muted-foreground hover:bg-accent"
                }
              >
                {m === "all" ? "Match all" : "Match any"}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
