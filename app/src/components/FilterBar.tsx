import { Check, ChevronRight, ListFilter, X } from "lucide-react"
import { type ReactNode, useMemo, useRef, useState } from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Field, Label, RecordVersion, SidebarCondition } from "@/lib/api"
import {
  BANDS_FOR,
  type ConditionMatch,
  type ConditionOp,
  isMultiValue,
  LABEL_OPS,
  needsValue,
  opsForKind,
  unwrapValue,
} from "@/lib/conditions"
import { ConceptIcon } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { useFullOrg } from "@/pages/settings/SettingsLayout"
import { MemberAvatar, memberLabel, type OrgMember } from "./record/AssigneePicker"
import { Button, IconButton, Input, Modal } from "./ui"

/**
 * Linear-style filtering for the concept list. `FilterTrigger` (header icon)
 * opens a command menu: pick a field, then check values directly (with live
 * per-value counts). `FilterChips` renders each active condition as a
 * segmented chip whose op and value segments are themselves editable. Both
 * are stateless over conditions/match — ConceptView owns them in the URL.
 * The row-based `ConditionList` editor remains for the widget/sidebar modals.
 */

export interface FilterProps {
  conceptId: string
  fields: readonly Field[]
  labels: readonly Label[]
  recordVersions: readonly RecordVersion[]
  conditions: readonly SidebarCondition[]
  match: ConditionMatch
  onChange: (conditions: SidebarCondition[], match: ConditionMatch) => void
}

/** What a condition can target: a real field, or the Label pseudo-field. */
interface Target {
  readonly key: string
  readonly name: string
  readonly kind: Field["kind"] | "label"
  readonly field?: Field
}

const LABEL_TARGET: Target = { key: "__labels", name: "Label", kind: "label" }

const targetsOf = (fields: readonly Field[]): Target[] => [
  LABEL_TARGET,
  ...fields.map((f) => ({ key: f.id, name: f.name, kind: f.kind, field: f })),
]

/** Kinds whose values come from a closed set (picked from a checklist). */
const isChecklistKind = (kind: Target["kind"]): boolean =>
  kind === "enum" || kind === "user" || kind === "bool" || kind === "computed" || kind === "label"

interface ValueOption {
  readonly id: string
  readonly label: string
  readonly icon?: ReactNode
  readonly raw: unknown
}

const optionsFor = (
  target: Target,
  labels: readonly Label[],
  members: readonly OrgMember[],
): ValueOption[] => {
  switch (target.kind) {
    case "label":
      return labels.map((l) => ({ id: l.id, label: l.name, raw: l.id }))
    case "enum":
      return (target.field?.config.options ?? []).map((o) => ({ id: o, label: o, raw: o }))
    case "user":
      return members.map((m) => ({
        id: m.userId,
        label: memberLabel(m),
        icon: <MemberAvatar member={m} size={16} />,
        raw: m.userId,
      }))
    case "bool":
      return [
        { id: "true", label: "true", raw: true },
        { id: "false", label: "false", raw: false },
      ]
    case "computed":
      return (BANDS_FOR[target.field?.config.computedKind ?? "decay"] ?? []).map((b) => ({
        id: b,
        label: b,
        raw: b,
      }))
    default:
      return []
  }
}

/** Ops offered on a chip's op segment. */
const opChoicesFor = (target: Target): ReadonlyArray<{ op: ConditionOp; label: string }> =>
  target.kind === "label"
    ? [...LABEL_OPS, { op: "in", label: "has any of" }, { op: "notIn", label: "has none of" }]
    : opsForKind(target.kind)

/** Display label for a chip's op (array-size aware for in/notIn). */
const opDisplay = (c: SidebarCondition, target: Target | undefined): string => {
  const len = Array.isArray(c.value) ? c.value.length : 1
  if (c.op === "in")
    return len > 1
      ? target?.kind === "label"
        ? "has any of"
        : "is any of"
      : target?.kind === "label"
        ? "has"
        : "is"
  if (c.op === "notIn")
    return len > 1
      ? target?.kind === "label"
        ? "has none of"
        : "is none of"
      : target?.kind === "label"
        ? "does not have"
        : "is not"
  if (target?.kind === "label") return LABEL_OPS.find((o) => o.op === c.op)?.label ?? c.op
  return opsForKind(target?.kind ?? "text").find((o) => o.op === c.op)?.label ?? c.op
}

/** cmdk filter that matches on display keywords, never on the item `value`
 *  (values are stable ids — uuids would garbage-match searches). */
const keywordFilter = (value: string, search: string, keywords?: string[]): number =>
  (keywords?.length ? keywords.join(" ") : value).toLowerCase().includes(search.toLowerCase())
    ? 1
    : 0

/** Reshape a condition's value when its op changes. */
const coerceValueForOp = (op: ConditionOp, prev: unknown): unknown => {
  if (!needsValue(op)) return null
  if (op === "between") return Array.isArray(prev) && prev.length === 2 ? prev : ["", ""]
  if (isMultiValue(op))
    return Array.isArray(prev) ? prev : prev != null && prev !== "" ? [prev] : []
  return Array.isArray(prev) ? (prev[0] ?? "") : (prev ?? "")
}

// ── value editors ───────────────────────────────────────────────────────────--

/** Searchable checklist with live per-value counts; multi-ops toggle, single
 *  ops replace. `onValue` receives the next raw value (array or scalar). */
function ValueChecklist({
  target,
  op,
  value,
  options,
  recordVersions,
  onValue,
}: {
  target: Target
  op: ConditionOp
  value: unknown
  options: ValueOption[]
  recordVersions: readonly RecordVersion[]
  onValue: (next: unknown) => void
}) {
  const multi = isMultiValue(op)
  const selected = new Set(
    (Array.isArray(value) ? value : value != null && value !== "" ? [value] : []).map(String),
  )
  // One pass over the record versions per (record versions, field) — not per option, and
  // unaffected by toggling values (which re-renders with the same record versions).
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of recordVersions) {
      const v = i.state[target.key]
      for (const x of Array.isArray(v) ? v : [v]) {
        const k = String(unwrapValue(x))
        m.set(k, (m.get(k) ?? 0) + 1)
      }
    }
    return m
  }, [recordVersions, target.key])
  return (
    <Command filter={keywordFilter}>
      <CommandInput placeholder="Filter…" />
      <CommandList>
        <CommandEmpty>No values.</CommandEmpty>
        <CommandGroup>
          {options.map((o) => {
            const on = selected.has(o.id)
            return (
              <CommandItem
                key={o.id}
                value={o.id}
                keywords={[o.label]}
                onSelect={() => {
                  if (multi) {
                    const next = new Set(selected)
                    if (on) next.delete(o.id)
                    else next.add(o.id)
                    const ids = options.filter((x) => next.has(x.id)).map((x) => x.raw)
                    onValue(ids)
                  } else {
                    onValue(o.raw)
                  }
                }}
              >
                <Check size={14} className={cn("shrink-0", on ? "opacity-100" : "opacity-0")} />
                {o.icon}
                <span className="truncate">{o.label}</span>
                <span className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">
                  {counts.get(String(o.raw)) ?? 0}
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/** Free-form value editor (text/number/money/date/json) as a centered dialog:
 *  "Filter by <field>…" with input(s) + Cancel/Apply (Linear-style). */
function ValueDialog({
  target,
  op,
  value,
  onApply,
  onClose,
}: {
  target: Target
  op: ConditionOp
  value: unknown
  onApply: (next: unknown) => void
  onClose: () => void
}) {
  const inputType =
    target.kind === "date"
      ? "date"
      : target.kind === "number" || target.kind === "money"
        ? "number"
        : "text"
  const parse = (raw: string): unknown => (inputType === "number" && raw !== "" ? Number(raw) : raw)
  const initial = Array.isArray(value) ? value : [value ?? "", ""]
  const [lo, setLo] = useState(String(initial[0] ?? ""))
  const [hi, setHi] = useState(String(initial[1] ?? ""))
  const apply = () => onApply(op === "between" ? [parse(lo), parse(hi)] : parse(lo))
  return (
    <Modal title={`Filter by ${target.name.toLowerCase()}…`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            type={inputType}
            value={lo}
            placeholder={op === "between" ? "min" : undefined}
            onChange={(e) => setLo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            className="flex-1"
          />
          {op === "between" && (
            <>
              <span className="text-xs text-muted-foreground">–</span>
              <Input
                type={inputType}
                value={hi}
                placeholder="max"
                onChange={(e) => setHi(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                className="flex-1"
              />
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply}>Apply</Button>
        </div>
      </div>
    </Modal>
  )
}

// ── trigger: add a filter (field menu → value step) ─────────────────────────--

export function FilterTrigger({
  fields,
  labels,
  recordVersions,
  conditions,
  match,
  onChange,
}: FilterProps) {
  const org = useFullOrg()
  const members = org.data?.members ?? []
  const [open, setOpen] = useState(false)
  /** The hovered/selected field whose flyout submenu is showing, and the
   *  flyout's vertical offset within the popover (aligned to its menu item). */
  const [sub, setSub] = useState<{ target: Target; top: number } | null>(null)
  /** cmdk highlight, controlled — uncontrolled cmdk never calls the root
   *  onValueChange, and we need it to move the flyout with keyboard nav. */
  const [highlighted, setHighlighted] = useState("")
  /** cmdk auto-selects the first item on mount; don't flyout for that one. */
  const skipFirstSync = useRef(true)
  /** Free-form fields are filled in a centered dialog, not the popover. */
  const [dialogTarget, setDialogTarget] = useState<Target | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLElement>())
  const targets = targetsOf(fields)

  const close = () => {
    setOpen(false)
    setSub(null)
    setHighlighted("")
    skipFirstSync.current = true
  }

  const defaultFreeOp = (t: Target): ConditionOp =>
    t.kind === "text" || t.kind === "json" ? "contains" : "eq"

  const openSub = (t: Target) => {
    // Measure on the next frame so the flyout aligns even when the list just
    // re-rendered (typing in the search moves items around).
    requestAnimationFrame(() => {
      const el = itemRefs.current.get(t.key)
      const wrap = wrapperRef.current
      const top = el && wrap ? el.getBoundingClientRect().top - wrap.getBoundingClientRect().top : 0
      setSub({ target: t, top })
    })
  }

  // The condition the submenu checklist edits: the existing `in` condition on
  // its target, else a fresh one appended on the first check.
  const subIdx = sub ? conditions.findIndex((c) => c.field === sub.target.key && c.op === "in") : -1
  const setSubValue = (next: unknown) => {
    if (!sub) return
    const empty = Array.isArray(next) && next.length === 0
    if (subIdx >= 0) {
      onChange(
        empty
          ? conditions.filter((_, j) => j !== subIdx)
          : conditions.map((c, j) => (j === subIdx ? { ...c, value: next } : c)),
        match,
      )
    } else if (!empty) {
      onChange([...conditions, { field: sub.target.key, op: "in", value: next }], match)
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <PopoverTrigger asChild>
          <IconButton aria-label="Filter" className="relative">
            <ListFilter size={15} />
            {conditions.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[0.6rem] font-semibold text-primary-foreground">
                {conditions.length}
              </span>
            )}
          </IconButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <div ref={wrapperRef} className="relative">
            <Command
              filter={keywordFilter}
              // Controlled highlight: cmdk only reports value changes in
              // controlled mode, and we follow them with the flyout (Linear-
              // style keyboard nav). Items are valued by field id (names can
              // collide); the first sync is cmdk auto-selecting the top item
              // on open — no flyout for that.
              value={highlighted}
              onValueChange={(v) => {
                setHighlighted(v)
                if (skipFirstSync.current) {
                  skipFirstSync.current = false
                  return
                }
                const t = targets.find((x) => x.key === v)
                if (t) openSub(t)
                else setSub(null)
              }}
            >
              <CommandInput placeholder="Add filter…" />
              <CommandList>
                <CommandEmpty>No fields.</CommandEmpty>
                <CommandGroup>
                  {targets.map((t) => (
                    <CommandItem
                      key={t.key}
                      value={t.key}
                      keywords={[t.name]}
                      ref={(el) => {
                        if (el) itemRefs.current.set(t.key, el)
                        else itemRefs.current.delete(t.key)
                      }}
                      onMouseEnter={() => openSub(t)}
                      onSelect={() => {
                        if (isChecklistKind(t.kind)) openSub(t)
                        else {
                          close()
                          setDialogTarget(t)
                        }
                      }}
                    >
                      {t.field?.icon ? <ConceptIcon value={t.field.icon} size={14} /> : null}
                      <span className="truncate">{t.name}</span>
                      <ChevronRight size={13} className="ml-auto text-muted-foreground" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>

            {sub && (
              <div
                className="absolute right-full z-50 mr-1.5 w-60 overflow-hidden rounded-md border border-border bg-popover shadow-md"
                style={{ top: Math.max(0, sub.top) }}
              >
                {isChecklistKind(sub.target.kind) ? (
                  <ValueChecklist
                    target={sub.target}
                    op="in"
                    value={subIdx >= 0 ? conditions[subIdx]?.value : []}
                    options={optionsFor(sub.target, labels, members)}
                    recordVersions={recordVersions}
                    onValue={setSubValue}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const t = sub.target
                      close()
                      setDialogTarget(t)
                    }}
                    className="w-full px-3 py-2.5 text-left text-sm text-foreground hover:bg-accent"
                  >
                    Filter by {sub.target.name.toLowerCase()}…
                  </button>
                )}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {dialogTarget && (
        <ValueDialog
          target={dialogTarget}
          op={defaultFreeOp(dialogTarget)}
          value=""
          onApply={(v) => {
            onChange(
              [
                ...conditions,
                { field: dialogTarget.key, op: defaultFreeOp(dialogTarget), value: v },
              ],
              match,
            )
            setDialogTarget(null)
          }}
          onClose={() => setDialogTarget(null)}
        />
      )}
    </>
  )
}

// ── chips: each condition as an editable segmented control ──────────────────--

const SEG = "px-2 py-1"

/** One condition as a segmented chip: [field] [op ▾] [value ▾] [×]. The op
 *  menu closes on pick; the value popover closes on apply for free-form
 *  values and stays open for checklists (multi-select). */
function ConditionChip({
  cond,
  target,
  labels,
  members,
  recordVersions,
  onSet,
  onRemove,
}: {
  cond: SidebarCondition
  target: Target | undefined
  labels: readonly Label[]
  members: readonly OrgMember[]
  recordVersions: readonly RecordVersion[]
  onSet: (next: SidebarCondition) => void
  onRemove: () => void
}) {
  const [opOpen, setOpOpen] = useState(false)
  const [valueOpen, setValueOpen] = useState(false)

  const valueDisplay = (): string => {
    const one = (v: unknown): string => {
      if (target?.kind === "label") return labels.find((l) => l.id === String(v))?.name ?? String(v)
      if (target?.kind === "user") {
        const m = members.find((x) => x.userId === String(v))
        return m ? memberLabel(m) : String(v)
      }
      return String(v)
    }
    if (cond.op === "between" && Array.isArray(cond.value))
      return `${cond.value[0] ?? ""} – ${cond.value[1] ?? ""}`
    if (Array.isArray(cond.value))
      return cond.value.length === 0 ? "—" : cond.value.map(one).join(", ")
    return cond.value === "" || cond.value == null ? "—" : one(cond.value)
  }

  return (
    <span className="inline-flex items-stretch overflow-hidden rounded-md border border-input text-xs">
      <span className={cn(SEG, "bg-accent/50 font-medium text-foreground")}>
        {target?.name ?? cond.field}
      </span>

      <Popover open={opOpen} onOpenChange={setOpOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(SEG, "border-l border-input text-muted-foreground hover:bg-accent")}
          >
            {opDisplay(cond, target)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-44 p-1">
          {(target ? opChoicesFor(target) : []).map((o) => (
            <button
              key={o.op}
              type="button"
              onClick={() => {
                onSet({ ...cond, op: o.op, value: coerceValueForOp(o.op, cond.value) })
                setOpOpen(false)
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                o.op === cond.op ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <Check size={13} className={o.op === cond.op ? "opacity-100" : "opacity-0"} />
              {o.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {needsValue(cond.op) &&
        target &&
        (isChecklistKind(target.kind) ? (
          <Popover open={valueOpen} onOpenChange={setValueOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  SEG,
                  "max-w-56 truncate border-l border-input font-medium text-foreground hover:bg-accent",
                )}
              >
                {valueDisplay()}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <ValueChecklist
                target={target}
                op={cond.op}
                value={cond.value}
                options={optionsFor(target, labels, members)}
                recordVersions={recordVersions}
                onValue={(next) => {
                  onSet({ ...cond, value: next })
                  if (!isMultiValue(cond.op)) setValueOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setValueOpen(true)}
              className={cn(
                SEG,
                "max-w-56 truncate border-l border-input font-medium text-foreground hover:bg-accent",
              )}
            >
              {valueDisplay()}
            </button>
            {valueOpen && (
              <ValueDialog
                target={target}
                op={cond.op}
                value={cond.value}
                onApply={(next) => {
                  onSet({ ...cond, value: next })
                  setValueOpen(false)
                }}
                onClose={() => setValueOpen(false)}
              />
            )}
          </>
        ))}

      <button
        type="button"
        aria-label={`Remove ${target?.name ?? cond.field} filter`}
        onClick={onRemove}
        className={cn(
          SEG,
          "border-l border-input text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <X size={12} />
      </button>
    </span>
  )
}

export function FilterChips({
  fields,
  labels,
  recordVersions,
  conditions,
  match,
  onChange,
}: FilterProps) {
  const org = useFullOrg()
  const members = org.data?.members ?? []
  const targets = targetsOf(fields)

  const setAt = (i: number, c: SidebarCondition) =>
    onChange(
      conditions.map((x, j) => (j === i ? c : x)),
      match,
    )
  const removeAt = (i: number) =>
    onChange(
      conditions.filter((_, j) => j !== i),
      match,
    )

  if (conditions.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {conditions.map((c, i) => (
        <ConditionChip
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
          key={i}
          cond={c}
          target={targets.find((t) => t.key === c.field)}
          labels={labels}
          members={members}
          recordVersions={recordVersions}
          onSet={(next) => setAt(i, next)}
          onRemove={() => removeAt(i)}
        />
      ))}
      {conditions.length > 1 && (
        <button
          type="button"
          onClick={() => onChange([...conditions], match === "all" ? "any" : "all")}
          className="rounded-md border border-dashed border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Toggle how conditions combine"
        >
          match {match}
        </button>
      )}
      <button
        type="button"
        onClick={() => onChange([], "all")}
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Clear
      </button>
    </div>
  )
}
