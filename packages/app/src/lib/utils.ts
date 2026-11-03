import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/** Render an arbitrary record version field value for display. */
export const showValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—"
  // A file property's value (one FileRef or a list): its filenames, so a title
  // column or a sort reads "contract.pdf", not a JSON blob of ids.
  const refs = Array.isArray(v) ? v : [v]
  if (refs.length > 0 && refs.every(isFileRefLike))
    return refs.map((r) => (r as { filename: string }).filename).join(", ")
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

const isFileRefLike = (r: unknown): boolean =>
  !!r &&
  typeof r === "object" &&
  typeof (r as { id?: unknown }).id === "string" &&
  typeof (r as { filename?: unknown }).filename === "string" &&
  "sizeBytes" in r

/** Up to two initials from a name, falling back to the email's first letter. */
export const initialsOf = (name: string | null | undefined, email: string): string => {
  const source = name?.trim() || email
  const letters = source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
  return (letters || email[0] || "?").toUpperCase()
}
