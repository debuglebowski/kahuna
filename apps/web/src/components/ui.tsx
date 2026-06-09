import { Crown, ServerCrash, X } from "lucide-react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge as BadgePrimitive } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// The plain form primitives are 1:1 shadcn — re-export so existing
// `import { Button, Input } from "../ui"` call sites keep resolving.
export { Button } from "@/components/ui/button"
export { Input } from "@/components/ui/input"

/**
 * Square, icon-only button. Requires an `aria-label` (also the tooltip label)
 * so the icon stays accessible. Use for repeated row actions where a full text
 * Button would crowd the layout. Built on the shadcn ghost {@link Button} and
 * wrapped in a shadcn {@link Tooltip} (needs a `TooltipProvider` at the root).
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={ariaLabel}
          className={cn(
            "text-muted-foreground",
            variant === "danger"
              ? "hover:bg-destructive/10 hover:text-destructive"
              : "hover:text-foreground",
            className,
          )}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent>{title ?? ariaLabel}</TooltipContent>
    </Tooltip>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl border bg-card text-card-foreground shadow-sm", className)}>
      {children}
    </div>
  )
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-2 border-b px-6 py-2.5">
      <h3 className="text-sm leading-none font-semibold text-card-foreground">{title}</h3>
      {action}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block space-y-2">
      <span className="block text-sm leading-none font-medium text-foreground">{label}</span>
      {children}
    </div>
  )
}

/** Tonal status badge over the shadcn {@link BadgePrimitive}, colored via the
 *  theme's status tokens (success/warning/info/destructive) as soft tints. */
export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: Tone }) {
  return (
    <BadgePrimitive variant="secondary" className={TONES[tone]}>
      {children}
    </BadgePrimitive>
  )
}

type Tone = "gray" | "green" | "amber" | "red" | "blue"
const TONES: Record<Tone, string | undefined> = {
  gray: undefined,
  green: "bg-success/15 text-success",
  amber: "bg-warning/15 text-warning",
  red: "bg-destructive/15 text-destructive",
  blue: "bg-info/15 text-info",
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
        style ? "" : "bg-muted text-muted-foreground",
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

/** Content-shaped loading placeholder (shadcn Skeleton rows). */
export function Spinner() {
  return (
    <div className="space-y-3 p-6">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  )
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
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ServerCrash size={22} />
        </div>
        <h1 className="mb-1 text-lg font-semibold text-foreground">{title}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{message}</p>
        {onRetry && (
          <Button onClick={onRetry} disabled={retrying} className="w-full">
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        )}
      </Card>
    </div>
  )
}

/**
 * A centered modal dialog. Mount it to open; it calls `onClose` on Escape,
 * backdrop click, or the close button. Built on the shadcn {@link Dialog}
 * (Radix), so focus trapping and layered Escape handling come for free.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A focused confirm dialog over the shadcn {@link AlertDialog}. Used for
 * destructive actions: an "Archive" confirm (single primary action), or a
 * "Delete" confirm with a red CTA plus an optional secondary ("Archive
 * instead") escape hatch. The parent owns open/close — it keeps this mounted
 * while a mutation runs (`pending`) and unmounts it on success; pass `error`
 * to surface a failure. Buttons stay plain (not AlertDialogAction) so a click
 * never auto-dismisses mid-mutation.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmVariant = "primary",
  onConfirm,
  onCancel,
  secondaryLabel,
  onSecondary,
  pending = false,
  error,
}: {
  title: ReactNode
  message: ReactNode
  confirmLabel: string
  confirmVariant?: "primary" | "danger"
  onConfirm: () => void
  onCancel: () => void
  /** Optional middle action (e.g. "Archive instead" on a delete dialog). */
  secondaryLabel?: string
  onSecondary?: () => void
  pending?: boolean
  error?: ReactNode
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground">{message}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          {secondaryLabel && onSecondary && (
            <Button variant="outline" onClick={onSecondary} disabled={pending}>
              {secondaryLabel}
            </Button>
          )}
          <Button
            variant={confirmVariant === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Right-anchored slide-over panel. Built on the shadcn {@link Sheet}; Esc or
 *  backdrop closes it. The header carries an optional action plus a close X. */
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
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-[640px] max-w-[95vw] gap-0 p-0 sm:max-w-[640px]"
      >
        <div className="flex items-center justify-between gap-2 border-b px-6 py-4">
          <SheetTitle className="min-w-0 truncate">{title}</SheetTitle>
          <div className="flex shrink-0 items-center gap-2">
            {headerAction}
            <IconButton onClick={onClose} aria-label="Close">
              <X size={16} />
            </IconButton>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
