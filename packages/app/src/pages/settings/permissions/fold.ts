import type { AccessActionName, AccessResourceType } from "../../../lib/api"
import type { CellState } from "./StateGroup"

/**
 * Rules in, answers out — and back again.
 *
 * Pure, and tested directly (`fold.test.ts`) rather than through a component: this
 * is the half of the permissions editor where a mistake is silent. A rendering bug
 * you see; a fold bug writes the wrong rule and looks fine.
 *
 * ── ONE KEY SPACE ────────────────────────────────────────────────────────────
 *
 * Every answer is `(rowId, resourceType, action)`. `rowId` is a resource's uuid, or
 * {@link ALL_ROW} for the blanket rule — the "All" row of a table, and equally the
 * answer behind a question card. That unification is the point: a question is not a
 * different kind of setting, it is a cell in the All row that happens to have no
 * per-item counterpart (nothing can name a concept that does not exist yet).
 *
 * ── WHAT A PANE OWNS ─────────────────────────────────────────────────────────
 *
 * `setRoleRules` replaces everything of a `(resourceType, scopeBy)` shape, so the
 * payload has to be complete. Two things would otherwise be destroyed by a save:
 *
 *  - actions the pane does not render — an action a newer server knows about, or a
 *    leftover from an older one. {@link readAnswers} sets them aside per (row,
 *    effect) and {@link writeGroups} puts them back.
 *
 * There is no longer a wildcard to carry: `*` is gone from the model entirely, so
 * every rule is exactly the actions it names and every role is editable here.
 *
 * Conditional rules are the exception the ENGINE handles: its DELETE skips them, so
 * they neither read into a cell nor get written back.
 */

/** The blanket row's id. No uuid can collide with it. */
export const ALL_ROW = "__all__"

/** One answerable thing: an action on a resource type, rendered as a column or a card. */
export interface Answerable {
  readonly resourceType: AccessResourceType
  readonly action: AccessActionName
}

/** A rule as the fold consumes it — the shape `api.listRules` returns. */
export interface FoldRule {
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<string>
  readonly resourceType: string
  readonly resourceId: string | null
  readonly conceptId: string | null
  readonly condition: unknown
}

/** Which id column a type's rows live in. `"concept"` = the container (records). */
export type ScopeBy = "resource" | "concept"

/** One `(resourceType, scopeBy)` shape a pane writes as a unit. */
export interface Group {
  readonly resourceType: AccessResourceType
  readonly scopeBy?: ScopeBy
}

export const key = (rowId: string, resourceType: string, action: string) =>
  `${rowId}:${resourceType}:${action}`

/** Actions this pane does not render, kept per (row, type, effect) so a save can put
 *  them back exactly where they were. */
export type Passthrough = ReadonlyMap<string, ReadonlyArray<string>>

const passKey = (rowId: string, resourceType: string, effect: string) =>
  `${rowId}:${resourceType}:${effect}`

/**
 * Which row a rule answers for, or null if it is not this group's shape.
 *
 * A concept-scoped RECORD rule and a resource-scoped one are different grants over
 * the same uuid, so a group reads only its own column — otherwise the records half
 * of a pane would show (and then overwrite) rules meant for individual records.
 */
const rowOf = (r: FoldRule, scopeBy: ScopeBy): string | null => {
  if (r.resourceId === null && r.conceptId === null) return ALL_ROW
  return scopeBy === "concept" ? (r.resourceId ? null : r.conceptId) : r.resourceId
}

export interface FoldResult {
  readonly answers: ReadonlyMap<string, CellState>
  readonly passthrough: Passthrough
}

/**
 * Fold a role's rules into answers.
 *
 * DENY is folded first and an ALLOW never overwrites a cell a deny already claimed —
 * deny beats allow WITHIN one role's own rules, exactly as `decide()` does within
 * one tier.
 */
export const readAnswers = (
  rules: ReadonlyArray<FoldRule>,
  groups: ReadonlyArray<Group>,
  answerable: ReadonlyArray<Answerable>,
): FoldResult => {
  const answers = new Map<string, CellState>()
  const passthrough = new Map<string, ReadonlyArray<string>>()
  const managed = new Map<string, ReadonlyArray<AccessActionName>>()
  for (const a of answerable) {
    managed.set(a.resourceType, [...(managed.get(a.resourceType) ?? []), a.action])
  }

  for (const effect of ["deny", "allow"] as const) {
    for (const g of groups) {
      const mine = managed.get(g.resourceType) ?? []
      for (const r of rules) {
        if (r.resourceType !== g.resourceType || r.effect !== effect) continue
        // The engine never replaces a conditional rule, so the pane must never claim
        // to represent one.
        if (r.condition) continue
        const row = rowOf(r, g.scopeBy ?? "resource")
        if (row === null) continue
        for (const action of mine) {
          if (!r.actions.includes(action)) continue
          // Deny is folded first, so an allow must never overwrite it.
          if (answers.get(key(row, g.resourceType, action)) === "deny") continue
          answers.set(key(row, g.resourceType, action), effect)
        }
        const unmanaged = r.actions.filter((a) => !mine.includes(a as AccessActionName))
        if (unmanaged.length > 0) {
          const k = passKey(row, g.resourceType, effect)
          passthrough.set(k, [...(passthrough.get(k) ?? []), ...unmanaged])
        }
      }
    }
  }
  return { answers, passthrough }
}

/**
 * Answers back out into the `groups` payload `setRoleRules` takes.
 *
 * A row whose every answer is Inherit and which carries no passthrough contributes
 * nothing — no rule at all is what Inherit means.
 */
export const writeGroups = (
  answers: ReadonlyMap<string, CellState>,
  passthrough: Passthrough,
  groups: ReadonlyArray<Group>,
  answerable: ReadonlyArray<Answerable>,
  /** Every per-item row currently on screen, WITHOUT {@link ALL_ROW} — which is
   *  always included, since a pane can always answer "all of them". */
  rowIds: ReadonlyArray<string>,
): ReadonlyArray<{
  readonly resourceType: AccessResourceType
  readonly scopeBy?: ScopeBy
  readonly entries: ReadonlyArray<{
    readonly resourceId: string | null
    readonly allow: ReadonlyArray<AccessActionName>
    readonly deny: ReadonlyArray<AccessActionName>
  }>
}> =>
  groups.map((g) => {
    const mine = answerable.filter((a) => a.resourceType === g.resourceType).map((a) => a.action)
    const entries = [ALL_ROW, ...rowIds]
      .map((rowId) => {
        const pick = (effect: CellState) => {
          const chosen = mine.filter((a) => answers.get(key(rowId, g.resourceType, a)) === effect)
          const kept = passthrough.get(passKey(rowId, g.resourceType, effect)) ?? []
          // De-duplicated: a passthrough action could in principle also be a managed
          // one if a pane's column set changed between load and save.
          return [...new Set([...kept, ...chosen])] as ReadonlyArray<AccessActionName>
        }
        return {
          resourceId: rowId === ALL_ROW ? null : rowId,
          allow: pick("allow"),
          deny: pick("deny"),
        }
      })
      .filter((e) => e.allow.length > 0 || e.deny.length > 0)
    return { resourceType: g.resourceType, scopeBy: g.scopeBy, entries }
  })

/** Do two answer maps say the same thing? An absent key and an explicit `"inherit"`
 *  are the SAME answer — without that, setting a cell and putting it back would leave
 *  the pane dirty with nothing to save. */
export const sameAnswers = (
  a: ReadonlyMap<string, CellState>,
  b: ReadonlyMap<string, CellState>,
): boolean => {
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(k) ?? "inherit") !== (b.get(k) ?? "inherit")) return false
  }
  return true
}
