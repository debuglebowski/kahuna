import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Info, Minus, TriangleAlert, X } from "lucide-react"
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
import { Badge, Button, Callout, InfoHint, Spinner } from "../../components/ui"
import { type AccessActionName, type AccessResourceType, api } from "../../lib/api"
import { Feedback } from "./parts"

/**
 * The permissions grid: every item in one area down the side, actions across the top,
 * and a tri-state cell at each intersection.
 *
 * WHY TRI-STATE. A two-state checkbox conflates "no rule" with "denied", and the
 * difference is the whole model:
 *
 *   Inherit — no rule at all here; the CASCADE decides (another tier this role's
 *             actor holds, this role's `based on` chain, or the resource's own default).
 *   Allow   — an allow rule on this record, in THIS role.
 *   Deny    — a deny rule, which beats an allow WITHIN this role's own tier — but,
 *             since the cascade redesign, does not beat an allow from a tier this
 *             role's actor holds at higher precedence. See `engine/domain/access.ts`.
 *
 * A ticked box could not represent a role that deliberately revokes access, and an
 * unticked one could not tell "we never said" from "we said no" — which is exactly
 * why this went to two states and back once role INHERITANCE (`based on`, P6) made
 * "we never said, but our parent did" a real, showable thing again.
 *
 * WHAT IT CANNOT SHOW. Two things stay in the rule list below it:
 *   - CONDITIONAL rules ("records I created") — a cell has nowhere to put a condition.
 *   - BLANKET rules (no target), which apply to every row at once. An untargeted ALLOW
 *     folds onto the DEFAULT row instead (`addRule` refuses creating a new one for a
 *     templated type, so this only reaches old data); an untargeted DENY stays a
 *     read-only "Blocked" banner, because un-blocking one row can't be a per-cell action
 *     when the rule that blocks it covers all of them.
 *
 * WHAT A ROW IS. Usually the resource itself — one concept, one dashboard. The Records
 * grid is the exception: its rows are CONCEPTS and each cell means "records inside this
 * concept", which the model stores as `concept_id` rather than `resource_id`. That is
 * `scopeBy`, and it must match on both read and write or the grid reads one set of rules
 * and writes another.
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

/** One row of `access_defaults` as the grid consumes it — ONE effect; a role may
 *  hold both an allow row and a deny row for the same type. */
export interface MatrixDefault {
  readonly roleId: string
  readonly resourceType: string
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<string>
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

/** Key for the local edit map. Exported for `PermissionMatrix.test.ts`. */
export const key = (recordId: string, action: string) => `${recordId}:${action}`

/**
 * The row a rule belongs to, or null if it is not a row-scoped rule of this shape.
 *
 * A concept-scoped RECORD rule and a resource-scoped one are different grants over the
 * same uuid, so each grid reads only its own column — otherwise the Records grid would
 * show (and then overwrite) rules meant for individual records.
 */
const targetOf = (r: MatrixRule, scopeBy: ScopeBy): string | null =>
  scopeBy === "concept" ? (r.resourceId ? null : r.conceptId) : r.resourceId

/** An untargeted rule. These no longer exist for templated types — `addRule` refuses
 *  them — but older data and blanket DENIES still can be, and they cover every row. */
const isDefaultRule = (r: MatrixRule): boolean => !r.resourceId && !r.conceptId && !r.condition

/**
 * Fold a role's rules into cell states. DENY is folded first and an ALLOW never
 * overwrites a cell a deny already claimed — deny beats allow WITHIN one role's own
 * rules, exactly as `decide()` does within one tier.
 *
 * An untargeted ALLOW folds onto the DEFAULT row, not every item row — a
 * simplification for old data (`addRule` refuses creating a new one for a
 * templated type), not a claim that it covers only future resources. Untargeted
 * DENYs are NOT folded in here at all: see `blanketDenyCells`.
 *
 * Exported for `PermissionMatrix.test.ts`.
 */
export const stateFrom = (
  rules: ReadonlyArray<MatrixRule>,
  defaults: ReadonlyArray<MatrixDefault>,
  resourceType: AccessResourceType,
  actions: ReadonlyArray<AccessActionName>,
  scopeBy: ScopeBy,
): Map<string, CellState> => {
  const out = new Map<string, CellState>()
  // The template row first: it comes from `access_defaults`, a different table, and
  // is deliberately NOT a rule — see the header. Deny before allow, same fold as
  // the rules below: a role's own deny template beats its own allow template.
  for (const a of defaults) {
    if (a.resourceType !== resourceType || a.effect !== "deny") continue
    for (const action of actions) {
      if (!a.actions.includes(action) && !a.actions.includes("*")) continue
      out.set(key(DEFAULT_ROW, action), "deny")
    }
  }
  for (const a of defaults) {
    if (a.resourceType !== resourceType || a.effect !== "allow") continue
    for (const action of actions) {
      if (!a.actions.includes(action) && !a.actions.includes("*")) continue
      if (out.get(key(DEFAULT_ROW, action)) === "deny") continue
      out.set(key(DEFAULT_ROW, action), "allow")
    }
  }
  for (const r of rules) {
    if (r.resourceType !== resourceType || r.condition || r.effect !== "deny") continue
    // An untargeted deny is NOT a per-cell state — see `blanketDenyCells`.
    if (isDefaultRule(r)) continue
    const target = targetOf(r, scopeBy)
    if (!target) continue
    for (const a of actions) {
      if (!r.actions.includes(a) && !r.actions.includes("*")) continue
      out.set(key(target, a), "deny")
    }
  }
  for (const r of rules) {
    if (r.resourceType !== resourceType || r.condition || r.effect !== "allow") continue
    const target = isDefaultRule(r) ? DEFAULT_ROW : targetOf(r, scopeBy)
    if (!target) continue
    for (const a of actions) {
      if (!r.actions.includes(a) && !r.actions.includes("*")) continue
      if (out.get(key(target, a)) === "deny") continue
      out.set(key(target, a), "allow")
    }
  }
  return out
}

/**
 * Cells an UNTARGETED deny covers, shown read-only: it blocks every row at once, so
 * no single cell can undo it — that stays a rule-list edit, in "Other". A TARGETED
 * deny is a real, editable "Deny" cell now (folded into `stateFrom`), which is the
 * whole point of this phase — this function only has the blanket case left.
 *
 * Exported for `PermissionMatrix.test.ts`.
 */
export const blanketDenyCells = (
  rules: ReadonlyArray<MatrixRule>,
  resourceType: AccessResourceType,
  actions: ReadonlyArray<AccessActionName>,
  items: ReadonlyArray<MatrixItem>,
): Set<string> => {
  const out = new Set<string>()
  for (const r of rules) {
    if (r.resourceType !== resourceType || r.effect !== "deny" || r.condition) continue
    if (!isDefaultRule(r)) continue
    for (const a of actions) {
      if (!r.actions.includes(a) && !r.actions.includes("*")) continue
      for (const it of items) out.add(key(it.id, a))
    }
  }
  return out
}

const ICON: Record<CellState, typeof Check> = { deny: X, inherit: Minus, allow: Check }

/**
 * How the SELECTED segment is painted.
 *
 * Inherit gets no fill — only a darkened icon. It is the resting state of nearly
 * every cell, so giving it the same weight as Allow and Deny would fill the grid
 * with highlights and bury the handful of rows that actually decide something. The
 * eye should land on colour, and colour should mean "this role's own rule decides".
 */
const SELECTED: Record<CellState, string> = {
  allow: "bg-success/15 text-success",
  deny: "bg-destructive/15 text-destructive",
  inherit: "text-foreground",
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
  defaults,
  loading,
  scopeBy = "resource",
  resourceNoun,
  parentRules,
  parentLabel,
}: {
  roleId: string
  resourceType: AccessResourceType
  items: ReadonlyArray<MatrixItem>
  /** Singular noun for the first column header, e.g. "Concept". */
  itemsLabel: string
  actions: ReadonlyArray<{ id: AccessActionName; label: string }>
  rules: ReadonlyArray<MatrixRule>
  /** This role's creation templates, filtered to nothing else. */
  defaults: ReadonlyArray<MatrixDefault>
  loading?: boolean
  /** "concept" for the Records grid, whose rows are containers. Default "resource". */
  scopeBy?: ScopeBy
  /** Plural noun for the RESOURCE, when it differs from the row noun — the Records
   *  grid's rows are concepts but its rules are about records, and a banner reading
   *  "covering all concepts" there would name the wrong thing. */
  resourceNoun?: string
  /** The `based on` parent's rules, when this role has one (P6) — an Inherit cell
   *  that the PARENT actually decides gets a small badge naming what it resolves
   *  to, one level up. Not a full transitive resolution of the whole chain; the
   *  Explain view (P4) is where that lives. */
  parentRules?: ReadonlyArray<MatrixRule>
  parentLabel?: string
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
        defaults,
        resourceType,
        actions.map((a) => a.id),
        scopeBy,
      ),
    )
  }, [rules, defaults, resourceType, actions, dirty, scopeBy])

  const save = useMutation({
    mutationFn: () => {
      const entries = items
        .map((it) => ({
          resourceId: it.id,
          allow: actions.filter((a) => draft.get(key(it.id, a.id)) === "allow").map((a) => a.id),
          deny: actions.filter((a) => draft.get(key(it.id, a.id)) === "deny").map((a) => a.id),
        }))
        // An all-Inherit row needs no rule at all.
        .filter((e) => e.allow.length > 0 || e.deny.length > 0)
      // The DEFAULT row is not a rule — it is the creation template, written to its
      // own table precisely so nothing consults it at request time. Tri-state, same
      // as any other row: a deny here beats an allow this role would otherwise
      // inherit on a resource created from now on.
      const defaultAllow = actions
        .filter((a) => draft.get(key(DEFAULT_ROW, a.id)) === "allow")
        .map((a) => a.id)
      const defaultDeny = actions
        .filter((a) => draft.get(key(DEFAULT_ROW, a.id)) === "deny")
        .map((a) => a.id)
      return api
        .setScopedRules({ roleId, resourceType, scopeBy, entries })
        .then(() =>
          api.setAccessDefault({ roleId, resourceType, allow: defaultAllow, deny: defaultDeny }),
        )
    },
    onSuccess: () => {
      setDirty(false)
      void qc.invalidateQueries({ queryKey: ["rules", roleId] })
      void qc.invalidateQueries({ queryKey: ["accessDefaults"] })
    },
  })

  const setCell = (recordId: string, action: string, next: CellState) => {
    setDraft((cur) => new Map(cur).set(key(recordId, action), next))
    setDirty(true)
  }

  // The one rule shape the grid still cannot represent — a cell has nowhere to put a
  // condition — surfaced so a cell reading Inherit is never quietly narrowed or
  // widened by something invisible.
  const conditional = rules.filter((r) => r.resourceType === resourceType && r.condition)
  /** Cells an UNTARGETED deny covers: shown, not editable — see the function's doc. */
  const blanketDeny = blanketDenyCells(
    rules,
    resourceType,
    actions.map((a) => a.id),
    items,
  )
  /** What the `based on` PARENT resolves for a cell this role stays silent on —
   *  named, not folded into `draft`: this role's own Inherit is still the truth
   *  for what THIS role writes, the parent's value is context for the reader. */
  const inheritedFrom = parentRules
    ? stateFrom(
        parentRules,
        [],
        resourceType,
        actions.map((a) => a.id),
        scopeBy,
      )
    : null

  /** What a NEW resource of this type starts as, for the template row. */
  const allLabel = `new ${resourceNoun ?? `${itemsLabel.toLowerCase()}s`}`

  if (loading) return <Spinner />

  return (
    <div className="space-y-4">
      {/* These two are ALERTS about live state, not description — a rule is
          overriding cells the reader is about to edit. As muted paragraphs they
          were indistinguishable from the pane's explanatory copy, which is
          exactly the thing they need to outrank. */}
      {blanketDeny.size > 0 ? (
        <Callout
          tone="amber"
          icon={<TriangleAlert size={14} />}
          title={`An untargeted deny covers ${blanketDeny.size} cell${blanketDeny.size > 1 ? "s" : ""} below`}
        >
          It blocks every row at once, so a single cell can't undo it — remove it under{" "}
          <b>Other rules</b> to change that.
        </Callout>
      ) : null}
      {conditional.length > 0 ? (
        <Callout
          tone="blue"
          icon={<Info size={14} />}
          title={`${conditional.length} conditional rule${conditional.length > 1 ? "s" : ""} not shown here`}
        >
          {'"Records I created"'} and the like live under <b>Other rules</b> — a cell has nowhere to
          put a condition.
        </Callout>
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
                <span className="flex items-center gap-1.5">
                  {itemsLabel}
                  {/* The cell LEGEND. It used to sit beside the Save button as a
                      200-character sentence, where it read as an instruction about
                      saving rather than as what ✕ / – / ✓ mean. */}
                  <InfoHint
                    label="What the cells mean"
                    text="Deny beats Allow within this role. Inherit defers to the cascade — another role held earlier, this role's `based on` chain, or the resource's own default."
                  />
                </span>
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
            {/* THE TEMPLATE ROW. It is NOT a rule and governs nothing that exists — it
                says what a resource created LATER starts with, and is copied into real
                rules at that moment. Pinned first and tinted because it is the one row
                whose effect is in the future, which is easy to misread as "and also
                everything below". Tri-state like any other row: Deny here beats an
                allow this role would otherwise inherit on a future resource. */}
            <TableRow className="border-b-2 border-border bg-muted/40 hover:bg-muted/40">
              <TableCell className="font-semibold text-foreground">
                Default value
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  applied to {allLabel}
                </span>
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
                  No {resourceNoun ?? `${itemsLabel.toLowerCase()}s`} yet — the default above is
                  what any created later will start with.
                </TableCell>
              </TableRow>
            ) : null}
            {items.map((it) => (
              <TableRow key={it.id} className="hover:bg-transparent">
                <TableCell className="font-medium text-foreground">{it.name}</TableCell>
                {actions.map((a) => {
                  const cellKey = key(it.id, a.id)
                  const state = draft.get(cellKey) ?? "inherit"
                  const inherited = state === "inherit" ? inheritedFrom?.get(cellKey) : undefined
                  return (
                    <TableCell key={a.id} className="text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {blanketDeny.has(cellKey) ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex h-6 items-center rounded-md bg-destructive/15 px-2 text-[11px] font-medium text-destructive">
                                Blocked
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Denied by an untargeted rule — blocks every row
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <StateGroup
                            state={state}
                            onSelect={(next) => setCell(it.id, a.id, next)}
                            describe={(st) => `${st.label} ${a.label.toLowerCase()} on ${it.name}`}
                          />
                        )}
                        {/* "An inherited cell names its source" — the based-on PARENT
                            decides this cell while this role stays silent on it. */}
                        {inherited && inherited !== "inherit" && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Badge tone={inherited === "allow" ? "green" : "red"}>
                                  {parentLabel ?? "parent"}
                                </Badge>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Inherited from {parentLabel ?? "its parent role"}:{" "}
                              {inherited === "allow" ? "Allow" : "Deny"}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Sticky, because the grid is as long as the org has concepts and the
          buttons used to scroll off the bottom of it. The content column is the
          scroll container (see RuleEditor), so this pins to the frame. */}
      <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3">
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
                  defaults,
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
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        <Feedback error={save.error ? (save.error as Error).message : undefined} />
      </div>
    </div>
  )
}
