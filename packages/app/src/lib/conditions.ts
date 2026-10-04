import { LABELS_KEY } from "@kahunalabs/contract"
import type { Field, RecordVersion, SidebarCondition } from "./api"
import { isRichTextValue, richTextPlain } from "./richtext"

export { LABELS_KEY }

/**
 * The shared client-side condition evaluator. One matcher for every surface
 * that filters record versions — the concept list filter bar, dashboard widgets and
 * sidebar list/group sources — so the op semantics can't drift apart. Pure
 * (no React / DOM), unit-tested like `widgetAggregations`.
 */

export type ConditionOp = SidebarCondition["op"]
export type ConditionMatch = "all" | "any"

export interface MatchOpts {
  /** Combine mode for the condition set (absent = `all`). */
  readonly match?: ConditionMatch | null
  /** Current user id — resolves the `isMe` op; absent = `isMe` never matches. */
  readonly me?: string | null
  /**
   * The subject's state BEFORE the change being evaluated — supplied only by an
   * automation run (from `getAsOf` at the event just before the trigger). It
   * resolves the two transition ops, `changedTo` / `changedFrom`.
   *
   * Absent on every other surface (filter bars, widgets, sidebar sources), where
   * there is no "before": both ops then evaluate to false rather than throwing,
   * so a transition condition simply never matches outside an automation.
   */
  readonly prev?: Record<string, unknown> | null
}

export const labelsOf = (state: Record<string, unknown>): string[] =>
  Array.isArray(state[LABELS_KEY]) ? (state[LABELS_KEY] as string[]) : []

/** See through stored value shapes: computed values compare by their band
 *  (decay `band` / momentum `label`), money by its amount, rich text by its
 *  plain text. Exported as `unwrapValue` for UIs that aggregate stored values
 *  (e.g. filter counts). */
const unwrap = (v: unknown): unknown => {
  if (isRichTextValue(v)) return richTextPlain(v)
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (o.band != null) return String(o.band) // decay
    if (o.label != null) return String(o.label) // momentum
    if ("amount" in o) return o.amount // money
  }
  return v
}

export const unwrapValue = unwrap

const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)

/** A `multiple` field stores an array — an op holds when ANY element passes. */
const anyOf = (v: unknown, pred: (x: unknown) => boolean): boolean =>
  Array.isArray(v) ? v.some((x) => pred(unwrap(x))) : pred(v)

/** Loose scalar equality: strict first, then string-coerced (a number typed in
 *  the editor must match its JSON round-trip through the URL, and vice versa). */
const sameScalar = (a: unknown, b: unknown): boolean =>
  a === b || (a != null && b != null && String(a) === String(b))

/** Order two scalars: numeric when both coerce, else Date.parse (ISO dates),
 *  else string compare. Null = not comparable (empty on either side). */
const cmp = (a: unknown, b: unknown): number | null => {
  if (isEmptyValue(a) || isEmptyValue(b)) return null
  const an = typeof a === "number" ? a : Number(a)
  const bn = typeof b === "number" ? b : Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  const ad = Date.parse(String(a))
  const bd = Date.parse(String(b))
  if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd
  return String(a).localeCompare(String(b))
}

export const matchCondition = (
  inst: RecordVersion,
  c: SidebarCondition,
  opts?: MatchOpts,
): boolean => {
  if (c.op === "hasLabel") return labelsOf(inst.state).includes(String(c.value))
  if (c.op === "notHasLabel") return !labelsOf(inst.state).includes(String(c.value))

  // Transition ops (automations only). Both require a `prev` state AND that the
  // field actually moved — otherwise re-saving an unrelated field on a record
  // that is ALREADY in the target state would re-fire the rule, which is the
  // exact bug these ops exist to prevent.
  if (c.op === "changedTo" || c.op === "changedFrom") {
    if (opts?.prev == null) return false
    const before = unwrap(opts.prev[c.field])
    const after = unwrap(inst.state[c.field])
    if (sameScalar(before, after)) return false
    const side = c.op === "changedTo" ? after : before
    // An empty `value` means "changed at all, in this direction".
    if (isEmptyValue(c.value)) return c.op === "changedTo" ? !isEmptyValue(after) : true
    return anyOf(side, (x) => sameScalar(x, c.value))
  }

  const v = unwrap(inst.state[c.field])
  switch (c.op) {
    case "empty":
      return isEmptyValue(v)
    case "notEmpty":
      return !isEmptyValue(v)
    case "eq":
      return anyOf(v, (x) => sameScalar(x, c.value))
    case "neq":
      return !anyOf(v, (x) => sameScalar(x, c.value))
    case "isMe":
      return opts?.me != null && anyOf(v, (x) => sameScalar(x, opts.me))
    case "contains": {
      if (isEmptyValue(v)) return false
      const needle = String(c.value).toLowerCase()
      return needle === "" || anyOf(v, (x) => String(x).toLowerCase().includes(needle))
    }
    case "in":
    case "notIn": {
      const set = Array.isArray(c.value) ? c.value : [c.value]
      const hit = set.some((s) => anyOf(v, (x) => sameScalar(x, s)))
      return c.op === "in" ? hit : !hit
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const op = c.op
      return anyOf(v, (x) => {
        const d = cmp(x, c.value)
        if (d == null) return false
        return op === "gt" ? d > 0 : op === "gte" ? d >= 0 : op === "lt" ? d < 0 : d <= 0
      })
    }
    case "between": {
      const [lo, hi] = Array.isArray(c.value) ? c.value : [null, null]
      return anyOf(v, (x) => {
        if (isEmptyValue(x)) return false
        const aboveLo = isEmptyValue(lo) || (cmp(x, lo) ?? -1) >= 0
        const belowHi = isEmptyValue(hi) || (cmp(x, hi) ?? 1) <= 0
        return aboveLo && belowHi
      })
    }
  }
  return false
}

/** Evaluate a condition set against a record version. Absent/`all` match = every
 *  condition must hold; `any` = at least one (an empty set always matches). */
export const matchRecordVersion = (
  inst: RecordVersion,
  conds: readonly SidebarCondition[],
  opts?: MatchOpts,
): boolean =>
  opts?.match === "any" && conds.length > 0
    ? conds.some((c) => matchCondition(inst, c, opts))
    : conds.every((c) => matchCondition(inst, c, opts))

// ── editor metadata (pure data — which ops fit which field kind) ───────────────

export interface OpDef {
  readonly op: ConditionOp
  readonly label: string
}

const EMPTYNESS: OpDef[] = [
  { op: "empty", label: "is empty" },
  { op: "notEmpty", label: "is not empty" },
]

/** The transition ops, offered ONLY where a "before" state exists (an automation
 *  editor). Appending them in a filter bar would offer a condition that can never
 *  match, so they are opt-in via `opsForKind(kind, { transitions: true })`. */
const TRANSITION_OPS: OpDef[] = [
  { op: "changedTo", label: "changed to" },
  { op: "changedFrom", label: "changed from" },
]

/** Ops offered for a field kind (filter editors). Relation/file fields don't
 *  live in record version state and are not filterable client-side.
 *
 *  `transitions` appends `changedTo`/`changedFrom` — pass it only from the
 *  automation editor, where a previous state is available at evaluation time. */
export const opsForKind = (
  kind: Field["kind"],
  opts?: { readonly transitions?: boolean },
): OpDef[] => {
  const base = opsForKindBase(kind)
  return opts?.transitions ? [...base, ...TRANSITION_OPS] : base
}

const opsForKindBase = (kind: Field["kind"]): OpDef[] => {
  switch (kind) {
    case "number":
    case "money":
      return [
        { op: "eq", label: "=" },
        { op: "neq", label: "≠" },
        { op: "gt", label: ">" },
        { op: "gte", label: "≥" },
        { op: "lt", label: "<" },
        { op: "lte", label: "≤" },
        { op: "between", label: "between" },
        ...EMPTYNESS,
      ]
    case "date":
      return [
        { op: "eq", label: "is" },
        { op: "lt", label: "before" },
        { op: "gt", label: "after" },
        { op: "between", label: "between" },
        ...EMPTYNESS,
      ]
    case "bool":
      return [{ op: "eq", label: "is" }]
    case "enum":
      return [
        { op: "eq", label: "is" },
        { op: "neq", label: "is not" },
        { op: "in", label: "is any of" },
        { op: "notIn", label: "is none of" },
        ...EMPTYNESS,
      ]
    case "user":
      return [
        { op: "isMe", label: "is me" },
        { op: "eq", label: "is" },
        { op: "neq", label: "is not" },
        { op: "in", label: "is any of" },
        ...EMPTYNESS,
      ]
    case "computed":
      return [
        { op: "eq", label: "band is" },
        { op: "neq", label: "band is not" },
      ]
    default:
      // text / json / anything future
      return [
        { op: "contains", label: "contains" },
        { op: "eq", label: "is" },
        { op: "neq", label: "is not" },
        ...EMPTYNESS,
      ]
  }
}

/** Ops for the pseudo-field "Label" (`__labels`). */
export const LABEL_OPS: OpDef[] = [
  { op: "hasLabel", label: "has" },
  { op: "notHasLabel", label: "does not have" },
]

/** Ops whose value is irrelevant (no value editor rendered). */
export const needsValue = (op: ConditionOp): boolean =>
  op !== "empty" && op !== "notEmpty" && op !== "isMe"

/** Ops whose value is a list (multi-select editor). */
export const isMultiValue = (op: ConditionOp): boolean => op === "in" || op === "notIn"

/** Decay/momentum band vocabularies (value choices for computed-field ops). */
export const BANDS_FOR: Record<string, readonly string[]> = {
  decay: ["fresh", "warm", "cooling", "cold"],
  momentum: ["heating", "steady", "cooling"],
}
