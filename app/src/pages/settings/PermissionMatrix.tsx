import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Slash, X } from "lucide-react"
import { useEffect, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button, Spinner } from "../../components/ui"
import { type AccessActionName, type AccessResourceType, api } from "../../lib/api"
import { Feedback } from "./parts"

/**
 * The permissions grid: every item in one area down the side, actions across the top,
 * and a tri-state cell at each intersection.
 *
 * WHY TRI-STATE and not a checkbox. A checkbox conflates "no rule" with "denied", and
 * the difference is the whole model:
 *
 *   Inherit — no rule at all; the item's own default visibility decides.
 *   Allow   — an allow rule on this item.
 *   Deny    — a deny rule, which beats everything, including an allow elsewhere.
 *
 * So a ticked box could not represent a role that deliberately revokes access, and an
 * unticked one could not tell "we never said" from "we said no".
 *
 * WHAT IT CANNOT SHOW. Two things stay in the rule list below it:
 *   - CONDITIONAL rules ("records I created") — a cell has nowhere to put a condition.
 *   - BLANKET rules (no target), which apply to every row at once. Those are surfaced
 *     as a banner rather than silently painted across the grid, because a row showing
 *     Inherit while a blanket allow grants it would be a lie.
 *
 * WHAT A ROW IS. Usually the resource itself — one concept, one dashboard. The Records
 * grid is the exception: its rows are CONCEPTS and each cell means "records inside this
 * concept", which the model stores as `concept_id` rather than `resource_id`. That is
 * `scopeBy`, and it must match on both read and write or the grid reads one set of rules
 * and writes another.
 */

export type CellState = "allow" | "inherit" | "deny"

/**
 * The three states, in the order they appear in every cell: negative, neutral,
 * positive. Fixed order matters more than it looks — the eye reads a column of
 * segmented controls by POSITION, so a row whose highlight sits on the left is
 * scannable as "denied" without reading the icon.
 */
const STATES: ReadonlyArray<{
  readonly id: CellState
  readonly label: string
  /** The tooltip. Deliberately a few words: it is read on hover, over and over, by
   *  someone who already knows what Allow means. The full explanation lives once, in
   *  the legend under the table. */
  readonly tip: string
}> = [
  { id: "deny", label: "Deny", tip: "Deny — always wins" },
  { id: "inherit", label: "Inherit", tip: "Inherit — no rule" },
  { id: "allow", label: "Allow", tip: "Allow" },
]

/** A rule as the grid consumes it. */
export interface MatrixRule {
  readonly id: string
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<string>
  readonly resourceType: string
  readonly resourceId: string | null
  readonly conceptId: string | null
  readonly condition: unknown
}

export interface MatrixItem {
  readonly id: string
  readonly name: string
}

/** Which column a row's id lives in. See the header comment. */
export type ScopeBy = "resource" | "concept"

/**
 * The default row's id in the draft map.
 *
 * A uuid can never collide with it, and keeping the default in the SAME map as the
 * item rows is what lets one Save carry both — the alternative, a second piece of
 * state, drifts out of sync with `dirty` the moment either is edited alone.
 */
export const DEFAULT_ROW = "__default__"

/** Key for the local edit map. */
const key = (itemId: string, action: string) => `${itemId}:${action}`

/**
 * The row a rule belongs to, or null if it is not a row-scoped rule of this shape.
 *
 * A concept-scoped RECORD rule and a resource-scoped one are different grants over the
 * same uuid, so each grid reads only its own column — otherwise the Records grid would
 * show (and then overwrite) rules meant for individual records.
 */
const targetOf = (r: MatrixRule, scopeBy: ScopeBy): string | null =>
  scopeBy === "concept" ? (r.resourceId ? null : r.conceptId) : r.resourceId

/** The area's DEFAULT rule: untargeted, so it covers every resource of the type.
 *  Scope-independent — "all records" is the same rule whichever grid is showing. */
const isDefaultRule = (r: MatrixRule): boolean => !r.resourceId && !r.conceptId && !r.condition

/**
 * Fold the role's rules into cell states.
 *
 * DENY WINS here exactly as it does in the engine — a cell covered by both an allow and
 * a deny rule reads Deny, so the grid can never show access the server would refuse.
 */
const stateFrom = (
  rules: ReadonlyArray<MatrixRule>,
  resourceType: AccessResourceType,
  actions: ReadonlyArray<AccessActionName>,
  scopeBy: ScopeBy,
): Map<string, CellState> => {
  const out = new Map<string, CellState>()
  for (const r of rules) {
    if (r.resourceType !== resourceType || r.condition) continue
    // `*` covers every action, including ones this grid does not show — it reads as
    // Allow across the row, and the server refuses to rewrite it on save.
    const target = isDefaultRule(r) ? DEFAULT_ROW : targetOf(r, scopeBy)
    if (!target) continue
    for (const a of actions) {
      if (!r.actions.includes(a) && !r.actions.includes("*")) continue
      const k = key(target, a)
      // A deny already recorded is never downgraded by a later allow.
      if (out.get(k) === "deny") continue
      out.set(k, r.effect)
    }
  }
  return out
}

/** The icon for each state. `Slash` is the neutral one: a dash read as "off", which
 *  is exactly the confusion between "no rule" and "denied" this control exists to
 *  prevent. */
const ICON: Record<CellState, typeof Check> = { allow: Check, inherit: Slash, deny: X }

/**
 * How the SELECTED segment is painted.
 *
 * Inherit gets no fill — only a darkened icon. It is the resting state of nearly
 * every cell, so giving it the same weight as Allow and Deny would fill the grid
 * with highlights and bury the handful of rows that actually decide something. The
 * eye should land on colour, and colour should mean "a rule exists here".
 */
const SELECTED: Record<CellState, string> = {
  allow: "bg-success/15 text-success",
  inherit: "text-foreground",
  deny: "bg-destructive/15 text-destructive",
}

/**
 * One cell: a three-way button group, not a cycling toggle.
 *
 * A cycler hides two of its three states behind repeated clicks — you cannot see
 * what the options are, and reaching Deny from Allow means passing THROUGH Inherit,
 * which for a heartbeat is a different (and weaker) permission. Three segments make
 * every state visible, one click away, and impossible to overshoot.
 */
function StateGroup({
  state,
  onSelect,
  describe,
}: {
  state: CellState
  onSelect: (next: CellState) => void
  /** The segment's accessible name, e.g. "Allow view on Policy". Longer than the
   *  tooltip on purpose: a screen reader has no column header or row label to hand,
   *  so the name is the only place the target can be stated. */
  describe: (s: (typeof STATES)[number]) => string
}) {
  return (
    <fieldset className="inline-flex overflow-hidden rounded-md border border-border/70 bg-background">
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
                  on
                    ? SELECTED[s.id]
                    : "text-muted-foreground/40 hover:bg-accent hover:text-foreground"
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

export function PermissionMatrix({
  roleId,
  resourceType,
  items,
  itemsLabel,
  actions,
  rules,
  loading,
  scopeBy = "resource",
  note,
  resourceNoun,
}: {
  roleId: string
  resourceType: AccessResourceType
  items: ReadonlyArray<MatrixItem>
  /** Singular noun for the first column header, e.g. "Concept". */
  itemsLabel: string
  actions: ReadonlyArray<{ id: AccessActionName; label: string }>
  rules: ReadonlyArray<MatrixRule>
  loading?: boolean
  /** "concept" for the Records grid, whose rows are containers. Default "resource". */
  scopeBy?: ScopeBy
  /** One line explaining what a cell means, when it is not self-evident. */
  note?: string
  /** Plural noun for the RESOURCE, when it differs from the row noun — the Records
   *  grid's rows are concepts but its rules are about records, and a banner reading
   *  "covering all concepts" there would name the wrong thing. */
  resourceNoun?: string
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Map<string, CellState>>(new Map())
  const [dirty, setDirty] = useState(false)

  // Re-seed from the server whenever the rules change — and NOT while dirty, or a
  // background refetch would silently discard edits mid-flow.
  useEffect(() => {
    if (dirty) return
    setDraft(
      stateFrom(
        rules,
        resourceType,
        actions.map((a) => a.id),
        scopeBy,
      ),
    )
  }, [rules, resourceType, actions, dirty, scopeBy])

  const save = useMutation({
    mutationFn: () => {
      const entries = items
        .map((it) => ({
          resourceId: it.id,
          allow: actions.filter((a) => draft.get(key(it.id, a.id)) === "allow").map((a) => a.id),
          deny: actions.filter((a) => draft.get(key(it.id, a.id)) === "deny").map((a) => a.id),
        }))
        // An all-inherit row needs no rule at all; sending it would write nothing but
        // makes the payload harder to read in the log.
        .filter((e) => e.allow.length > 0 || e.deny.length > 0)
      const blanket = {
        allow: actions
          .filter((a) => draft.get(key(DEFAULT_ROW, a.id)) === "allow")
          .map((a) => a.id),
        deny: actions.filter((a) => draft.get(key(DEFAULT_ROW, a.id)) === "deny").map((a) => a.id),
      }
      return api.setScopedRules({
        roleId,
        resourceType,
        scopeBy,
        entries,
        blanket,
        // Bounds what the blanket write may overwrite: an action this grid never
        // showed stays on the rule instead of being dropped by omission.
        managedActions: actions.map((a) => a.id),
      })
    },
    onSuccess: () => {
      setDirty(false)
      void qc.invalidateQueries({ queryKey: ["rules", roleId] })
    },
  })

  const setCell = (itemId: string, action: string, next: CellState) => {
    setDraft((cur) => new Map(cur).set(key(itemId, action), next))
    setDirty(true)
  }

  // The one rule shape the grid still cannot represent — a cell has nowhere to put a
  // condition — surfaced so a row reading Inherit is never quietly overridden by
  // something invisible.
  const conditional = rules.filter((r) => r.resourceType === resourceType && r.condition)
  /** A wildcard default means the row reads Allow everywhere and the server will
   *  refuse to narrow it here; say so rather than letting Save look broken. */
  const wildcardDefault = rules.some(
    (r) => r.resourceType === resourceType && isDefaultRule(r) && r.actions.includes("*"),
  )

  /** "All records", "All dashboards" — what the default row covers. */
  const allLabel = `All ${resourceNoun ?? `${itemsLabel.toLowerCase()}s`}`

  if (loading) return <Spinner />

  return (
    <div className="space-y-4">
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {wildcardDefault ? (
        <p className="text-sm text-muted-foreground">
          This role's default grants <b>every</b> action on {allLabel}, including ones this grid
          doesn't list. Saving here won't narrow it — clear that rule in <b>Other</b> first.
        </p>
      ) : null}
      {conditional.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {conditional.length} conditional rule{conditional.length > 1 ? "s" : ""} ({" "}
          {'"records I created"'} and the like ) live in <b>Other</b> — a cell has nowhere to put a
          condition.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            {/* Three distinct looks in this table, and only three: the header is quiet
                small-caps with no fill, the DEFAULT row below it is the only tinted
                band, and item rows are plain. Tinting the header too would merge it
                with the default row, implying the two are one thing — but only one of
                them is editable. */}
            <TableRow className="border-b hover:bg-transparent">
              <TableHead className="min-w-48 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {itemsLabel}
              </TableHead>
              {actions.map((a) => (
                <TableHead
                  key={a.id}
                  className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {a.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* The DEFAULT row. It owns this area's untargeted rule — the one that used
                to be an unreadable warning banner. Pinned first and given a heavier
                border so it reads as "what everything starts from", not as another
                item, because a row that silently outranks the 14 below it is exactly
                the thing someone must not skim past. */}
            <TableRow className="border-b-2 border-border bg-muted/40 hover:bg-muted/40">
              <TableCell className="font-semibold text-foreground">
                Default value
                <span className="ml-2 text-xs font-normal text-muted-foreground">{allLabel}</span>
              </TableCell>
              {actions.map((a) => (
                <TableCell key={a.id} className="text-center">
                  <div className="flex justify-center">
                    <StateGroup
                      state={draft.get(key(DEFAULT_ROW, a.id)) ?? "inherit"}
                      onSelect={(next) => setCell(DEFAULT_ROW, a.id, next)}
                      describe={(st) => `${st.label} ${a.label.toLowerCase()} by default`}
                    />
                  </div>
                </TableCell>
              ))}
            </TableRow>
            {/* No items is not an empty screen: the default above still governs every
                resource of this type, including ones created later. */}
            {items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={actions.length + 1}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  No {resourceNoun ?? `${itemsLabel.toLowerCase()}s`} yet — the default above still
                  applies to any that are created.
                </TableCell>
              </TableRow>
            ) : null}
            {items.map((it) => (
              <TableRow key={it.id} className="hover:bg-transparent">
                <TableCell className="font-medium text-foreground">{it.name}</TableCell>
                {actions.map((a) => (
                  <TableCell key={a.id} className="text-center">
                    <div className="flex justify-center">
                      <StateGroup
                        state={draft.get(key(it.id, a.id)) ?? "inherit"}
                        onSelect={(next) => setCell(it.id, a.id, next)}
                        describe={(st) => `${st.label} ${a.label.toLowerCase()} on ${it.name}`}
                      />
                    </div>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        {dirty ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDirty(false)
              setDraft(
                stateFrom(
                  rules,
                  resourceType,
                  actions.map((a) => a.id),
                  scopeBy,
                ),
              )
            }}
            disabled={save.isPending}
          >
            Discard
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Deny beats every allow. Inherit (/) means no rule — the resource's own default decides.
        </span>
        <Feedback error={save.error ? (save.error as Error).message : undefined} />
      </div>
    </div>
  )
}
