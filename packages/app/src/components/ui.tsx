import { Crown, Info, Search, ServerCrash, X } from "lucide-react"
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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

export function CardHeader({
  title,
  action,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center justify-between gap-2 border-b px-6 py-2.5",
        className,
      )}
    >
      <h3 className="text-sm leading-none font-semibold text-card-foreground">{title}</h3>
      {action}
    </div>
  )
}

/**
 * The search-icon + input pair every list page filters with. Its own component
 * so a page that puts the filter somewhere other than a {@link Toolbar} — on the
 * page heading line, say — gets the same control rather than a second one that
 * drifts.
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  /** Sizing only; the control's own look is fixed. */
  className?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <Search
        size={14}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8"
      />
    </div>
  )
}

/**
 * Functional toolbar for list pages that can create things: a filter input
 * on the left, toggles + the create action on the right. Replaces descriptive
 * header prose — explanations belong in empty states (or an info tooltip).
 */
export function Toolbar({
  filter,
  onFilter,
  placeholder,
  children,
}: {
  filter: string
  onFilter: (v: string) => void
  placeholder: string
  children?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <FilterInput
        value={filter}
        onChange={onFilter}
        placeholder={placeholder}
        className="w-full max-w-xs"
      />
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** Outline toggle chip for {@link Toolbar} filters (e.g. "Archived"); pressed
 *  renders as an accent fill. */
export function ToggleChip({
  pressed,
  onPressedChange,
  disabled,
  children,
}: {
  pressed: boolean
  onPressedChange: (v: boolean) => void
  /** Renders and behaves as unavailable — the chip keeps its pressed state, so it
   *  still reads as "on, but not yours to change right now". */
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onPressedChange(!pressed)}
      className={pressed ? "bg-accent text-accent-foreground" : "text-muted-foreground"}
    >
      {children}
    </Button>
  )
}

/**
 * Small info icon that reveals `text` in a tooltip on hover/focus. Use next to a
 * setting's label in place of an always-visible helper paragraph. `label` names
 * the trigger for screen readers (defaults to "More info").
 */
export function InfoHint({ text, label }: { text: ReactNode; label?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label ?? "More info"}
            className="text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          >
            <Info size={13} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Structured body for an {@link InfoHint} on a multi-choice setting: an optional
 * lead sentence, then one row per option (its name + what it does). Styled for
 * the tooltip's inverted surface, so it belongs inside a hint — not on a page.
 */
export function HintList({
  lead,
  items,
}: {
  lead?: string
  items: { term: string; desc: string }[]
}) {
  return (
    <div className="w-60 py-0.5 text-left">
      {lead && <p className="text-background/70">{lead}</p>}
      <dl className={cn("space-y-2", lead && "mt-2 border-t border-background/15 pt-2")}>
        {items.map((i) => (
          <div key={i.term}>
            <dt className="font-medium text-background">{i.term}</dt>
            <dd className="mt-0.5 leading-snug text-background/70">{i.desc}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("block space-y-2", className)}>
      <span className="flex items-center gap-1.5 text-sm leading-none font-medium text-foreground">
        {label}
        {hint && <InfoHint text={hint} label={`${label} — more info`} />}
      </span>
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

/**
 * An inline notice the reader must not be able to miss.
 *
 * Distinct from {@link InfoHint}, which is a hover-only tooltip: a warning about
 * something that will break at run time has to be visible without interaction.
 * Tinted from the same status tokens as {@link Badge}, so it flips with the theme
 * — the one hand-rolled strip in the app that hardcodes `amber-500` is the
 * outlier, not the pattern.
 */
export function Callout({
  tone = "amber",
  icon,
  title,
  children,
  action,
}: {
  tone?: Extract<Tone, "amber" | "red" | "blue">
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  /** A fix, rendered inline — a warning you can act on beats one you can't. */
  action?: ReactNode
}) {
  return (
    <div className={`flex items-start gap-2.5 rounded-md border px-3 py-2 ${CALLOUT_TONES[tone]}`}>
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs leading-snug font-medium text-foreground">{title}</p>
        {children && <div className="text-xs leading-snug text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

const CALLOUT_TONES: Record<"amber" | "red" | "blue", string> = {
  amber: "border-warning/40 bg-warning/5 [&_svg]:text-warning",
  red: "border-destructive/40 bg-destructive/5 [&_svg]:text-destructive",
  blue: "border-info/40 bg-info/5 [&_svg]:text-info",
}

export const decayTone = (band?: string): Tone =>
  band === "fresh" ? "green" : band === "warm" ? "blue" : band === "cooling" ? "amber" : "red"

export const momentumTone = (label?: string): Tone =>
  label === "heating" ? "green" : label === "cooling" ? "red" : "gray"

/** Badge tone for an org membership role. */
export const roleTone = (role: string): Tone =>
  role === "owner" ? "blue" : role === "admin" ? "amber" : "gray"

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

/**
 * The curated pill palette — the colors offered for labels and enum options.
 * A pill renders its hue as a soft tint + deep same-hue text (the `.km-pill`
 * scheme in index.css), so foreground and background always match and clear
 * WCAG AA (≥ 5:1) in both themes — for any hue, including legacy free hexes.
 */
export const PILL_COLORS: ReadonlyArray<{ name: string; hex: string }> = [
  // 20 hue families × { regular (tailwind 500), deep (tailwind 800) } in
  // spectral order, deep right after its regular — the picker renders each
  // pair as a stacked column, so the top row reads as one rainbow run with
  // its darker echo aligned beneath.
  { name: "Red", hex: "#ef4444" },
  { name: "Deep Red", hex: "#991b1b" },
  { name: "Orange", hex: "#f97316" },
  { name: "Deep Orange", hex: "#9a3412" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Deep Amber", hex: "#92400e" },
  { name: "Yellow", hex: "#eab308" },
  { name: "Deep Yellow", hex: "#854d0e" },
  { name: "Lime", hex: "#84cc16" },
  { name: "Deep Lime", hex: "#3f6212" },
  { name: "Green", hex: "#22c55e" },
  { name: "Deep Green", hex: "#166534" },
  { name: "Emerald", hex: "#10b981" },
  { name: "Deep Emerald", hex: "#065f46" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Deep Teal", hex: "#115e59" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Deep Cyan", hex: "#155e75" },
  { name: "Sky", hex: "#0ea5e9" },
  { name: "Deep Sky", hex: "#075985" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Deep Blue", hex: "#1e40af" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Deep Indigo", hex: "#3730a3" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Deep Violet", hex: "#5b21b6" },
  { name: "Purple", hex: "#a855f7" },
  { name: "Deep Purple", hex: "#6b21a8" },
  { name: "Fuchsia", hex: "#d946ef" },
  { name: "Deep Fuchsia", hex: "#86198f" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Deep Pink", hex: "#9d174d" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Deep Rose", hex: "#9f1239" },
  { name: "Slate", hex: "#64748b" },
  { name: "Deep Slate", hex: "#1e293b" },
  { name: "Gray", hex: "#6b7280" },
  { name: "Deep Gray", hex: "#1f2937" },
  { name: "Stone", hex: "#78716c" },
  { name: "Deep Stone", hex: "#292524" },
]

/** Inline style carrying the pill's base hue for the `.km-pill` CSS scheme. */
export const pillStyle = (hex: string): CSSProperties => ({ "--pill": hex }) as CSSProperties

/** A random {@link PILL_COLORS} hex, preferring ones not in `used`. */
export function randomPillColor(used: ReadonlyArray<string> = []): string {
  const free = PILL_COLORS.filter((c) => !used.includes(c.hex))
  const pool = free.length > 0 ? free : PILL_COLORS
  return pool[Math.floor(Math.random() * pool.length)]!.hex
}

/** Picker over {@link PILL_COLORS} — each color rendered as the pill it will
 *  actually produce (tinted `.km-pill` scheme), the chosen one ringed. The only
 *  way to choose a pill color; a stored out-of-palette color shows no selection. */
export function ColorSwatchPicker({
  value,
  onChange,
  label = "Color",
  preview = "Label",
  taken,
}: {
  value: string | null
  onChange: (hex: string) => void
  label?: string
  /** Text shown inside every pill (uniform, so only the colors differ). */
  preview?: string
  /** Hexes already claimed elsewhere — rendered faded and unclickable so a
   *  scheme that wants unique colors (e.g. concepts) can enforce it. The
   *  current `value` should not be in the set. */
  taken?: ReadonlySet<string>
}) {
  // Regular/deep siblings render as one stacked column, so however the row
  // wraps, every deep pill sits directly under its regular counterpart.
  const pairs: Array<ReadonlyArray<(typeof PILL_COLORS)[number]>> = []
  for (let i = 0; i < PILL_COLORS.length; i += 2) pairs.push(PILL_COLORS.slice(i, i + 2))
  return (
    // No group role needed: each pill button carries a full "<label>: <color>" aria-label.
    <div className="flex flex-wrap items-start gap-1">
      {pairs.map((pair) => (
        <div key={pair[0]!.hex} className="flex min-w-0 flex-col items-stretch gap-1">
          {pair.map((c) => {
            const selected = value?.toLowerCase() === c.hex
            const unavailable = !selected && (taken?.has(c.hex) ?? false)
            return (
              <button
                key={c.hex}
                type="button"
                disabled={unavailable}
                aria-pressed={selected}
                aria-label={`${label}: ${c.name}`}
                title={unavailable ? `${c.name} — already in use` : c.name}
                onClick={() => onChange(c.hex)}
                style={pillStyle(c.hex)}
                className={cn(
                  "km-pill inline-flex max-w-28 justify-center rounded-full px-2 py-0.5 text-xs font-medium transition-transform hover:scale-105",
                  selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                  unavailable && "opacity-30 hover:scale-100",
                )}
              >
                <span className="truncate">{preview}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
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
  const style = color && parseHex(color) ? pillStyle(color) : undefined
  return (
    <span
      title={title}
      style={style}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        style ? "km-pill" : "bg-muted text-muted-foreground",
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
 *
 * `size` widens it for content that needs the room — `wide` for a file or image
 * preview, which fills 90% of the viewport in both axes: a page scan or a
 * spreadsheet is only legible at something near full size. Forms stay at the
 * default; don't reach for `wide` to fit more fields.
 *
 * `actions` sits in the title row, left of the close button — for controls that act
 * on what's being shown (download, open elsewhere) rather than on a form. A form's
 * submit still belongs at the bottom, next to what it's confirming.
 */
export function Modal({
  title,
  onClose,
  size = "default",
  actions,
  sidebar,
  children,
}: {
  title: ReactNode
  onClose: () => void
  size?: "default" | "wide"
  /** Header controls, placed before the close button — or, with a `sidebar`,
   *  stacked under the title in that column. */
  actions?: ReactNode
  /**
   * Navigation for a modal whose body has panes. It is a COLUMN OF THE FRAME,
   * running the full height beside the title — not a rail inside the body.
   * Placed in the body it starts below the header, and its tint then cuts a
   * seam across the modal a third of the way down; there is no amount of
   * padding that hides that, because the panel simply does not reach the top.
   *
   * Implies the `wide` frame.
   */
  sidebar?: ReactNode
  children: ReactNode
}) {
  const header = (
    <DialogHeader
      className={
        // The close button is positioned absolutely at top-4 right-4, so the row
        // has to keep clear of it — hence the right padding, and more of it when
        // actions share the row.
        actions ? "flex-row items-center gap-3 pr-9" : undefined
      }
    >
      {/* min-w-0 so a long filename truncates instead of shoving the actions
          under the close button. */}
      <DialogTitle className={actions ? "min-w-0 flex-1" : undefined}>{title}</DialogTitle>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </DialogHeader>
  )

  if (sidebar) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          aria-describedby={undefined}
          // `p-0` and `overflow-hidden`: the sidebar meets the frame's own edges
          // and its corners are clipped to the frame's radius, so the padding
          // belongs to each column rather than to the dialog.
          className="flex h-[90vh] w-[90vw] max-w-none flex-row gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          {/* TITLE, ACTIONS AND NAV IN ONE COLUMN. The title names the thing
              being edited and the nav picks a part of it, so they belong
              together; left in the content column the title sat above whichever
              pane was open, implying it described that pane. What remains on the
              right is only the pane. */}
          <aside className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-muted/30 p-4">
            <DialogHeader className="gap-1 text-left">
              <DialogTitle className="text-base leading-tight">{title}</DialogTitle>
            </DialogHeader>
            {actions}
            {sidebar}
          </aside>
          {/* `pr-12` at the top clears the close button, which the dialog pins to
              its own top-right corner. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-6 pr-12">{children}</div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className={
          size === "wide"
            ? // A fixed 90vw × 90vh frame, with the body scrolling inside it. `h`
              // (not just `max-h`) so the pane has a definite height to fill —
              // sized by content, a small image collapses the frame to a sliver.
              // No overflow here: nesting a scroll inside another leaves the image
              // scrollable while the frame stays put.
              "flex h-[90vh] w-[90vw] max-w-none flex-col gap-3 sm:max-w-none"
            : "max-h-[85vh] overflow-y-auto"
        }
      >
        {header}
        {children}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Horizontal top tab bar for full-page editors — a row of underline tabs (the
 * `line` variant) whose active item carries its own underline (no full-width
 * rule), sitting above the {@link TabsContent} panes. Render inside a default
 * (horizontal) `<Tabs>`; fill it with {@link TabBarItem}s. The page breadcrumb
 * already names the entity, so the bar carries only the tabs. `right` is an
 * optional slot for a tab-scoped action, aligned to the row's end.
 */
export function TabBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center">
      <TabsList variant="line" className="h-auto gap-6 p-0 pt-1.5">
        {children}
      </TabsList>
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
}

/** One top-bar tab — icon + label, with an underline active indicator. Carries
 *  no horizontal padding so the first tab sits flush with the content edge; the
 *  list's `gap` does the inter-tab spacing instead. */
export function TabBarItem({
  value,
  icon,
  children,
}: {
  value: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <TabsTrigger value={value} className="flex-none border-0 px-0">
      {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="truncate">{children}</span>
    </TabsTrigger>
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
