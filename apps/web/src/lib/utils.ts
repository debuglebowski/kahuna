import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/** Render an arbitrary instance field value for display. */
export const showValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}
