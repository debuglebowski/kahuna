import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Minus, X } from "lucide-react"
import { useEffect, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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

const CYCLE: Record<CellState, CellState> = {
  inherit: "allow",
  allow: "deny",
  deny: "inherit",
}

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

function CellButton({
  state,
  onClick,
  label,
}: {
  state: CellState
  onClick: () => void
  label: string
}) {
  const look =
    state === "allow"
      ? "bg-success/15 text-success"
      : state === "deny"
        ? "bg-destructive/15 text-destructive"
        : "text-muted-foreground/50 hover:bg-accent"
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — click to change`}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-md transition ${look}`}
    >
      {state === "allow" ? (
        <Check size={15} />
      ) : state === "deny" ? (
        <X size={15} />
      ) : (
        <Minus size={14} />
      )}
    </button>
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

  /**
   * Advance one cell. The next state is computed INSIDE the updater, off the current
   * draft — not off the one captured when this render ran. Two clicks landing in the
   * same frame both read the pre-click value otherwise, so a quick Inherit → Allow →
   * Deny double-click silently stops at Allow.
   */

  const cycleCell = (itemId: string, action: string) => {
    setDraft((cur) => {
      const k = key(itemId, action)
      return new Map(cur).set(k, CYCLE[cur.get(k) ?? "inherit"])
    })
    setDirty(true)
  }

  /**
   * Set a whole column. Cycles off the column's CURRENT shared state so the header
   * behaves like a big cell: if the column is mixed, the first click makes it uniform
   * rather than jumping past the state you probably wanted.
   */
  const cycleColumn = (action: string) => {
    setDraft((cur) => {
      // Same reason as `cycleCell`: read the column's state from `cur`, not from the
      // render closure, so repeated header clicks keep advancing.
      // The default row is deliberately EXCLUDED: "set this column for every concept"
      // should not also rewrite the rule that covers concepts the grid never listed.
      const states = items.map((it) => cur.get(key(it.id, action)) ?? "inherit")
      const uniform = states.every((s) => s === states[0]) ? states[0] : undefined
      const next = uniform === undefined ? "allow" : CYCLE[uniform]
      const m = new Map(cur)
      for (const it of items) m.set(key(it.id, action), next)
      return m
    })
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
            <TableRow>
              <TableHead className="min-w-48">{itemsLabel}</TableHead>
              {actions.map((a) => (
                <TableHead key={a.id} className="text-center">
                  <button
                    type="button"
                    onClick={() => cycleColumn(a.id)}
                    title={`Set ${a.label} for every ${itemsLabel.toLowerCase()}`}
                    className="rounded px-1.5 py-0.5 text-xs font-medium hover:bg-accent"
                  >
                    {a.label}
                  </button>
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
            <TableRow className="border-b-2 hover:bg-transparent">
              <TableCell className="font-medium text-foreground">
                {allLabel}
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  default
                </span>
              </TableCell>
              {actions.map((a) => {
                const state = draft.get(key(DEFAULT_ROW, a.id)) ?? "inherit"
                return (
                  <TableCell key={a.id} className="text-center">
                    <div className="flex justify-center">
                      <CellButton
                        state={state}
                        label={`${a.label} on ${allLabel}: ${state}`}
                        onClick={() => cycleCell(DEFAULT_ROW, a.id)}
                      />
                    </div>
                  </TableCell>
                )
              })}
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
                {actions.map((a) => {
                  const state = draft.get(key(it.id, a.id)) ?? "inherit"
                  return (
                    <TableCell key={a.id} className="text-center">
                      <div className="flex justify-center">
                        <CellButton
                          state={state}
                          label={`${a.label} on ${it.name}: ${state}`}
                          onClick={() => cycleCell(it.id, a.id)}
                        />
                      </div>
                    </TableCell>
                  )
                })}
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
          Click a cell to cycle Inherit → Allow → Deny. A column header sets the whole column.
        </span>
        <Feedback error={save.error ? (save.error as Error).message : undefined} />
      </div>
    </div>
  )
}
