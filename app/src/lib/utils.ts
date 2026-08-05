import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/** Render an arbitrary record version field value for display. */
export const showValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

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
