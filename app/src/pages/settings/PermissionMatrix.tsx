import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Slash } from "lucide-react"
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

export type CellState = "allow" | "no"

/**
 * TWO states, not three, and that is the point of the whole change.
 *
 * Access used to be two layers — a `visibility` column plus rules over it — so a cell
 * needed an "Inherit" state meaning "no rule here, something else decides". There is
 * no something else now: every (resource, role) pair carries its own value, so a cell
 * is Yes or No.
 *
 * "No" is stored as the ABSENCE of an allow, never as a deny row. A deny is absolute
 * and beats per-record shares, so storing "no" as a deny would silently kill sharing.
 * Denies still exist for deliberate hard blocks and are shown read-only (see
 * `blockedBy`), but they are not what an unticked cell means.
 */
const STATES: ReadonlyArray<{
  readonly id: CellState
  readonly label: string
  readonly tip: string
}> = [
  { id: "no", label: "No", tip: "No access" },
  { id: "allow", label: "Yes", tip: "Allowed" },
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

/** One row of `access_defaults` as the grid consumes it. */
export interface MatrixDefault {
  readonly roleId: string
  readonly resourceType: string
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

/** Key for the local edit map. */
const key = (recordId: string, action: string) => `${recordId}:${action}`

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
 * Fold the role's rules into cell states.
 *
 * DENY WINS here exactly as it does in the engine — a cell covered by both an allow and
 * a deny rule reads Deny, so the grid can never show access the server would refuse.
 */
const stateFrom = (
  rules: ReadonlyArray<MatrixRule>,
  defaults: ReadonlyArray<MatrixDefault>,
  resourceType: AccessResourceType,
  actions: ReadonlyArray<AccessActionName>,
  scopeBy: ScopeBy,
): Map<string, CellState> => {
  const out = new Map<string, CellState>()
  // The template row first: it comes from `access_defaults`, a different table, and
  // is deliberately NOT a rule — see the header.
  for (const a of defaults) {
    if (a.resourceType !== resourceType) continue
    for (const action of actions) {
      if (!a.actions.includes(action) && !a.actions.includes("*")) continue
      out.set(key(DEFAULT_ROW, action), "allow")
    }
  }
  for (const r of rules) {
    if (r.resourceType !== resourceType || r.condition) continue
    // ALLOWS ONLY. A deny is not "no" — it is an absolute block that also beats
    // per-record shares, so it is surfaced separately and read-only (`blocked`)
    // rather than folded into a cell someone could toggle off by accident.
    if (r.effect !== "allow") continue
    const target = isDefaultRule(r) ? DEFAULT_ROW : targetOf(r, scopeBy)
    if (!target) continue
    for (const a of actions) {
      if (!r.actions.includes(a) && !r.actions.includes("*")) continue
      out.set(key(target, a), "allow")
    }
  }
  return out
}

/** Cells a DENY rule covers, shown read-only: the grid must not paint a cell as
 *  granting access when a deny will refuse it anyway. */
const blockedCells = (
  rules: ReadonlyArray<MatrixRule>,
  resourceType: AccessResourceType,
  actions: ReadonlyArray<AccessActionName>,
  scopeBy: ScopeBy,
  items: ReadonlyArray<MatrixItem>,
): Set<string> => {
  const out = new Set<string>()
  for (const r of rules) {
    if (r.resourceType !== resourceType || r.effect !== "deny") continue
    const target = isDefaultRule(r) ? null : targetOf(r, scopeBy)
    for (const a of actions) {
      if (!r.actions.includes(a) && !r.actions.includes("*")) continue
      // An untargeted deny covers EVERY row, so it marks all of them.
      if (target) out.add(key(target, a))
      else for (const it of items) out.add(key(it.id, a))
    }
  }
  return out
}

/** The icon for each state. `Slash` is the neutral one: a dash read as "off", which
 *  is exactly the confusion between "no rule" and "denied" this control exists to
 *  prevent. */
const ICON: Record<CellState, typeof Check> = { allow: Check, no: Slash }

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
  // No fill: "no" is the resting state of most cells, and giving it the same weight
  // as an allow would fill the grid with highlights and bury what actually grants.
  no: "text-foreground",
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
  /** This role's creation templates, filtered to nothing else. */
  defaults: ReadonlyArray<MatrixDefault>
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
          // Never a deny: "no" is the ABSENCE of an allow. Writing a deny would also
          // beat per-record shares, quietly breaking sharing.
          deny: [] as ReadonlyArray<AccessActionName>,
        }))
        // An all-"no" row needs no rule at all.
        .filter((e) => e.allow.length > 0)
      // The DEFAULT row is not a rule — it is the creation template, written to its
      // own table precisely so nothing consults it at request time.
      const defaultActions = actions
        .filter((a) => draft.get(key(DEFAULT_ROW, a.id)) === "allow")
        .map((a) => a.id)
      return api
        .setScopedRules({ roleId, resourceType, scopeBy, entries })
        .then(() => api.setAccessDefault({ roleId, resourceType, actions: defaultActions }))
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
  // condition — surfaced so a cell reading "No" is never quietly widened by something
  // invisible.
  const conditional = rules.filter((r) => r.resourceType === resourceType && r.condition)
  /** Cells a deny covers: shown, not editable. */
  const blocked = blockedCells(
    rules,
    resourceType,
    actions.map((a) => a.id),
    scopeBy,
    items,
  )

  /** What a NEW resource of this type starts as, for the template row. */
  const allLabel = `new ${resourceNoun ?? `${itemsLabel.toLowerCase()}s`}`

  if (loading) return <Spinner />

  return (
    <div className="space-y-4">
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      {blocked.size > 0 ? (
        <p className="text-sm text-muted-foreground">
          A <b>deny</b> rule covers {blocked.size} cell{blocked.size > 1 ? "s" : ""} below. A deny
          always wins, so those stay blocked whatever this grid says — remove it in <b>Other</b> to
          change that.
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
            {/* THE TEMPLATE ROW. It is NOT a rule and governs nothing that exists — it
                says what a resource created LATER starts with, and is copied into real
                rules at that moment. Pinned first and tinted because it is the one row
                whose effect is in the future, which is easy to misread as "and also
                everything below". */}
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
                      state={draft.get(key(DEFAULT_ROW, a.id)) ?? "no"}
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
                {actions.map((a) => (
                  <TableCell key={a.id} className="text-center">
                    <div className="flex justify-center">
                      {blocked.has(key(it.id, a.id)) ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex h-6 items-center rounded-md bg-destructive/15 px-2 text-[11px] font-medium text-destructive">
                              Blocked
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Denied by a rule — deny always wins</TooltipContent>
                        </Tooltip>
                      ) : (
                        <StateGroup
                          state={draft.get(key(it.id, a.id)) ?? "no"}
                          onSelect={(next) => setCell(it.id, a.id, next)}
                          describe={(st) => `${st.label} ${a.label.toLowerCase()} on ${it.name}`}
                        />
                      )}
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
        <span className="text-xs text-muted-foreground">
          A cell is Yes or No — there is no third state. The top row is the template for resources
          created later, not a rule over the ones below it.
        </span>
        <Feedback error={save.error ? (save.error as Error).message : undefined} />
      </div>
    </div>
  )
}
