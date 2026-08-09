import { Check, Minus, X } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * The tri-state answer control, and the vocabulary every permissions pane is built
 * on. Lifted out of the old `PermissionMatrix` because it is now used in three
 * places — a table cell, a question card, and the inherited-from comparison — and a
 * second hand-rolled tri-state would be the same three states drawn two ways.
 *
 * WHY TRI-STATE. A two-state checkbox conflates "no rule" with "denied", and the
 * difference is the whole model:
 *
 *   Inherit — no rule at all here; the CASCADE decides (another role this actor
 *             holds, this role's `based on` chain, or the fallback).
 *   Allow   — an allow rule, in THIS role.
 *   Deny    — a deny rule, which beats an allow WITHIN this role's own tier — but
 *             does not beat an allow from a tier held at higher precedence. See
 *             `engine/domain/access.ts`.
 *
 * A ticked box could not represent a role that deliberately revokes access, and an
 * unticked one could not tell "we never said" from "we said no".
 */
export type CellState = "deny" | "inherit" | "allow"

const STATES: ReadonlyArray<{
  readonly id: CellState
  readonly label: string
  readonly tip: string
}> = [
  { id: "deny", label: "Deny", tip: "Denied — beats an allow within this role" },
  { id: "inherit", label: "Inherit", tip: "No rule here — the cascade decides" },
  { id: "allow", label: "Allow", tip: "Allowed by this role" },
]

const ICON: Record<CellState, typeof Check> = { deny: X, inherit: Minus, allow: Check }

/**
 * How the SELECTED segment is painted: a fill on all three, tinted for the two
 * verdicts and NEUTRAL for inherit.
 *
 * Inherit went without a fill for a while, to keep a long grid's resting state
 * quiet. That cost more than it saved: once the unselected segments carry their own
 * colour, a selected inherit differed from an unselected one only by text opacity —
 * so the one state meaning "this role has said nothing" was the one you could not
 * read at a glance. The fill says SELECTED; the colour says which verdict. Keeping
 * those two jobs separate is what lets inherit be plainly on without also looking
 * like a third verdict.
 */
const SELECTED: Record<CellState, string> = {
  allow: "bg-success/15 text-success",
  deny: "bg-destructive/15 text-destructive",
  inherit: "bg-accent text-foreground",
}

/**
 * How an UNSELECTED segment is painted: its own colour, dimmed — not grey.
 *
 * ✕ is red and ✓ is green whether or not they are the current answer, because the
 * colour is what the segment MEANS, not a report of which one is on. Draining both
 * to the same grey made a reader work out from position alone which end denied.
 *
 * Inherit stays neutral even so: it is the absence of an answer, and a colour of its
 * own would make "we said nothing" look like a third verdict. Its hover is lighter
 * than its selected fill, so passing the cursor over the segment you already have
 * selected does not read as a state change.
 */
const IDLE: Record<CellState, string> = {
  allow: "text-success/50 hover:bg-success/10 hover:text-success",
  deny: "text-destructive/50 hover:bg-destructive/10 hover:text-destructive",
  inherit: "text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground",
}

/**
 * Three segments, not a cycling toggle.
 *
 * A cycler hides two of its three states behind repeated clicks — you cannot see
 * what the options are, and reaching Deny from Allow means passing THROUGH Inherit,
 * which for a heartbeat is a different (and weaker) permission. Three segments make
 * every state visible, one click away, and impossible to overshoot.
 */
export function StateGroup({
  state,
  onSelect,
  describe,
  disabled,
}: {
  state: CellState
  onSelect: (next: CellState) => void
  /** The segment's accessible name, e.g. "Allow view on Policy". Longer than the
   *  tooltip on purpose: a screen reader has no column header or row label to hand,
   *  so the name is the only place the target can be stated. */
  describe: (s: (typeof STATES)[number]) => string
  disabled?: boolean
}) {
  return (
    <fieldset
      disabled={disabled}
      className="inline-flex overflow-hidden rounded-md border border-border/70 bg-background disabled:opacity-60"
    >
      {STATES.map((s) => {
        const Icon = ICON[s.id]
        const on = state === s.id
        return (
          <Tooltip key={s.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={on}
                aria-label={describe(s)}
                onClick={() => onSelect(s.id)}
                className={`flex size-6 items-center justify-center border-border/70 transition not-last:border-r ${
                  on ? SELECTED[s.id] : IDLE[s.id]
                }`}
              >
                <Icon size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{s.tip}</TooltipContent>
          </Tooltip>
        )
      })}
    </fieldset>
  )
}
