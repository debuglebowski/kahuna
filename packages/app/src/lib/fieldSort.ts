import type { Field, RecordVersion } from "./api"
import { richTextPlain } from "./richtext"
import { showValue } from "./utils"

/**
 * Type-aware ordering of field values — the ONE comparator behind every
 * "sort by field" surface (list widget, record table headers, kanban cards).
 * Sorting by the display string put "1 000 kr" before "200 kr" and "Mar 3"
 * before "Jan 9"; this compares numbers/money/dates by value and enums by their
 * configured option order. Pure, no React.
 */

export type SortDir = "asc" | "desc"

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const text = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** A comparable key for one value: a number (numeric kinds, dates, enum rank,
 *  bools) or a string (collated). `null` = empty — always sorts last. A
 *  `multiple` field sorts by its first value. */
export const sortKeyOf = (field: Field | undefined, raw: unknown): number | string | null => {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (isEmpty(v)) return null
  switch (field?.kind) {
    case "number":
      return num(v)
    case "money":
      return v && typeof v === "object" ? num((v as { amount?: unknown }).amount) : num(v)
    case "date": {
      const t = Date.parse(String(v))
      return Number.isNaN(t) ? null : t
    }
    case "bool":
      return v === true ? 1 : 0
    case "enum": {
      // Option order is the workflow order (lead → won); unknown values after.
      const i = (field.config.options ?? []).indexOf(String(v))
      return i >= 0 ? i : 1e9
    }
    case "computed": {
      // decay {band, days} sorts by days quiet; momentum {label} by its label.
      if (v && typeof v === "object") {
        const o = v as { days?: unknown; label?: unknown; band?: unknown }
        if (typeof o.days === "number") return o.days
        if (o.label != null) return String(o.label)
        if (o.band != null) return String(o.band)
      }
      return showValue(v)
    }
    case "richtext":
      return richTextPlain(v) || null
    default:
      return showValue(v)
  }
}

const compareKeys = (a: number | string, b: number | string): number =>
  typeof a === "number" && typeof b === "number"
    ? a - b
    : typeof a === "number"
      ? -1 // mixed (rare: an enum's unknown value is still numeric) — numbers first
      : typeof b === "number"
        ? 1
        : text.compare(a, b)

/** Compare two raw values of `field`. Empties sort last in BOTH directions. */
export const compareFieldValues = (
  field: Field | undefined,
  a: unknown,
  b: unknown,
  dir: SortDir = "asc",
): number => {
  const ka = sortKeyOf(field, a)
  const kb = sortKeyOf(field, b)
  if (ka == null || kb == null) return ka == null ? (kb == null ? 0 : 1) : -1
  const c = compareKeys(ka, kb)
  return dir === "desc" ? -c : c
}

/** Sorted copy of record versions by one field (stable for ties). */
export const sortRecordsByField = <R extends Pick<RecordVersion, "state">>(
  rows: readonly R[],
  field: Field | undefined,
  fieldId: string,
  dir: SortDir = "asc",
): R[] =>
  [...rows].sort((x, y) => compareFieldValues(field, x.state[fieldId], y.state[fieldId], dir))
