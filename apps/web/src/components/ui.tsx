import { Crown, ServerCrash, X } from "lucide-react"
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
} from "react"
import { cn } from "../lib/utils"

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-gray-900 text-white hover:bg-gray-700",
    ghost: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
    danger: "bg-red-600 text-white hover:bg-red-500",
  }[variant]
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50",
        styles,
        className,
      )}
      {...props}
    />
  )
}

/**
 * Square, icon-only button. Requires an `aria-label` (also used as the hover
 * tooltip) so the icon stays accessible. Use for repeated row actions where a
 * full text Button would crowd the layout.
 */
export function IconButton({
  className,
  variant = "default",
  title,
  "aria-label": ariaLabel,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "danger"
  "aria-label": string
}) {
  const styles = {
    default: "text-gray-400 hover:bg-gray-100 hover:text-gray-700",
    danger: "text-gray-400 hover:bg-red-50 hover:text-red-600",
  }[variant]
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1.5 transition disabled:opacity-50",
        styles,
        className,
      )}
      {...props}
    />
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-lg border border-gray-200 bg-white shadow-sm", className)}>
      {children}
    </div>
  )
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {action}
    </div>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-gray-500",
        className,
      )}
      {...props}
    />
  )
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-500",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block space-y-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </div>
  )
}

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  )
}

type Tone = "gray" | "green" | "amber" | "red" | "blue"
const TONES: Record<Tone, string> = {
  gray: "bg-gray-100 text-gray-700",
  green: "bg-green-100 text-green-700",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-700",
  blue: "bg-blue-100 text-blue-700",
}

export const decayTone = (band?: string): Tone =>
  band === "fresh" ? "green" : band === "warm" ? "blue" : band === "cooling" ? "amber" : "red"

export const momentumTone = (label?: string): Tone =>
  label === "heating" ? "green" : label === "cooling" ? "red" : "gray"

/** Parse a #rgb / #rrggbb hex into [r,g,b] (0-255), or null if unparseable. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  const raw = m?.[1]
  if (!raw) return null
  // Expand shorthand "abc" → "aabbcc" without per-char indexing.
  const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Pick black or white text for legibility on a solid hex background. */
export function readableOn(hex: string): string {
  const rgb = parseHex(hex)
  if (!rgb) return "#111827"
  const [r, g, b] = rgb
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? "#111827" : "#ffffff"
}

/**
 * A colored label pill drawn from the org label vocabulary. `color` is a free
 * hex (null → neutral gray). Pass `onRemove` to render a × affordance (editable
 * chips); omit it for read-only / locked (inherited) labels.
 */
export function LabelChip({
  color,
  children,
  onRemove,
  title,
  primary,
}: {
  color: string | null
  children: ReactNode
  onRemove?: () => void
  title?: string
  /** Primary labels render a leading crown (see `Label.primary`). */
  primary?: boolean
}) {
  const style =
    color && parseHex(color) ? { backgroundColor: color, color: readableOn(color) } : undefined
  return (
    <span
      title={title}
      style={style}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        style ? "" : "bg-gray-100 text-gray-700",
      )}
    >
      {primary && <Crown className="h-3 w-3 shrink-0" aria-label="Primary" />}
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove label"
          className="-mr-0.5 ml-0.5 inline-flex rounded-full opacity-70 hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

export function Spinner() {
  return <div className="p-8 text-sm text-gray-400">Loading…</div>
}

/** Full-screen "can't reach the server" state with an optional retry. */
export function ErrorScreen({
  title = "Can't reach the server",
  message = "We couldn't connect to the server. Check your connection and try again.",
  onRetry,
  retrying = false,
}: {
  title?: string
  message?: string
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
          <ServerCrash size={22} />
        </div>
        <h1 className="mb-1 text-lg font-semibold text-gray-900">{title}</h1>
        <p className="mb-5 text-sm text-gray-500">{message}</p>
        {onRetry && (
          <Button onClick={onRetry} disabled={retrying} className="w-full">
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        )}
      </Card>
    </div>
  )
}

/** A centered modal over a dimmed backdrop. Closes on Escape or backdrop click. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-20">
      {/* Backdrop as a real button → click-to-close stays keyboard-accessible. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg rounded-lg border border-gray-200 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
          <IconButton onClick={onClose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

/** Right-anchored slide-over panel. Floats over the page; Esc or backdrop closes it. */
export function Drawer({
  title,
  onClose,
  headerAction,
  children,
}: {
  title: ReactNode
  onClose: () => void
  headerAction?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop as a real button → click-to-close stays keyboard-accessible. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute inset-y-0 right-0 flex w-[640px] max-w-[95vw] flex-col border-l border-gray-200 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-gray-700">{title}</h3>
          <div className="flex shrink-0 items-center gap-2">
            {headerAction}
            <IconButton onClick={onClose} aria-label="Close">
              <X size={16} />
            </IconButton>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}
