import { format, parseISO } from "date-fns"

/**
 * `date`-kind values are stored as bare `YYYY-MM-DD` strings. These helpers
 * parse/format them as LOCAL calendar days (no timezone shift) so the picker and
 * the read display agree.
 */

/** Parse a `YYYY-MM-DD` (or ISO) value to a local Date; undefined if unparseable. */
export const parseDateValue = (v?: string): Date | undefined => {
  if (!v) return undefined
  const d = parseISO(v.slice(0, 10))
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** Serialize a Date back to the stored `YYYY-MM-DD` shape. */
export const toISODate = (d: Date): string => format(d, "yyyy-MM-dd")

/** Friendly display for a stored date value (e.g. "Dec 31, 2026"); raw on failure. */
export const formatDateValue = (v: unknown): string => {
  if (typeof v !== "string" || !v) return String(v ?? "")
  const d = parseDateValue(v)
  return d ? format(d, "MMM d, yyyy") : v
}
