import type { OrgScope, ScopeRole } from "../services/OrgContext"
import { decide, recordRulesForConcept, rulesFor } from "./access"
import type { ConceptVisibility } from "./types"

/**
 * Read-visibility predicates. Pure, so they are unit-testable without a database
 * and usable from both the engine services and the use-case boundary.
 *
 * ── HOW THE TWO LAYERS COMPOSE ───────────────────────────────────────────────
 *
 * The `visibility` column is the DEFAULT: who may read this normally, decided by
 * role. `access_rules` are EXCEPTIONS over that default, and `decide()` resolves
 * the pair — deny beats everything, then an explicit allow, then the default.
 *
 * So the role-only functions below are not dead: they compute the DEFAULT that
 * `decide()` falls back to. Keeping them separate is what makes the access model a
 * strict superset of today's behaviour rather than a replacement for it — an org
 * with no rules behaves exactly as it did.
 *
 * The privilege order is deliberately explicit rather than a rank comparison: a
 * new role must be classified here on purpose, not inherit access by sorting
 * above "member".
 */

/** May this role read admin-only material? `"system"` is the engine itself. */
export const canReadRestricted = (role: ScopeRole): boolean =>
  role === "owner" || role === "admin" || role === "system"

/**
 * The DEFAULT answer for a concept: may this role read one with this visibility?
 *
 * Note the direction: an unrecognised visibility never reaches here, because
 * `toConcept` already coerces anything it doesn't know to `"admin"`. `"none"` is
 * readable by nobody by default — only an explicit rule opens it.
 */
export const canReadConcept = (visibility: ConceptVisibility, role: ScopeRole): boolean =>
  visibility === "visible" || (visibility !== "none" && canReadRestricted(role))

/**
 * ── THE CONCEPT READ DECISION ────────────────────────────────────────────────
 *
 * Two answers, deliberately separate, because "may I open this concept at all?" and
 * "may I read its records by default?" are different questions:
 *
 *   reachable        — the concept resolves instead of failing NotFound.
 *   recordsByDefault — its records are readable WITHOUT a per-record rule; this is
 *                      the fallback the record filter subtracts denies from.
 *
 * They come apart in exactly the case that motivates record-level access: a concept
 * whose default is `none` (or `admin`, for a member) where someone holds a share of
 * ONE record. That caller must be able to reach the concept — otherwise the list they
 * are entitled to can't even be requested — while seeing nothing but the shared row.
 * So a record grant makes a concept `reachable` but never sets `recordsByDefault`.
 *
 * Collapsing these into one boolean is what makes list and by-id reads disagree, and
 * a disagreement means a member opens a record their list hid (or the reverse).
 */
export interface ConceptReadDecision {
  readonly reachable: boolean
  readonly recordsByDefault: boolean
}

export const scopeConceptRead = (
  scope: OrgScope,
  conceptId: string,
  visibility: ConceptVisibility,
): ConceptReadDecision => {
  const byDefault = canReadConcept(visibility, scope.role)
  if (!scope.policy) return { reachable: byDefault, recordsByDefault: byDefault }
  const granted = decide(scope.policy, "view", { type: "concept", id: conceptId }, byDefault, {
    // No record in hand, so a conditional rule must not read as a blanket one.
    unconditionalOnly: true,
  })
  if (granted) return { reachable: true, recordsByDefault: true }
  // Not granted at concept level. A DENY must stay final — it cannot be reopened by
  // holding a record share — so only fall through to record grants when nothing
  // explicitly denied the concept.
  const denied = rulesFor(scope.policy, "view", { type: "concept", id: conceptId }).some(
    (r) => r.effect === "deny",
  )
  if (denied) return { reachable: false, recordsByDefault: false }
  const hasRecordGrant = recordRulesForConcept(scope.policy, "view", conceptId).some(
    (r) => r.effect === "allow",
  )
  return { reachable: hasRecordGrant, recordsByDefault: false }
}

/**
 * THE concept read gate, for callers that only need the yes/no.
 *
 * Note this is `reachable`, not `recordsByDefault`: a share-only caller MUST get past
 * the concept gate, and the record filter is what then limits them to the shared row.
 */
export const scopeCanReadConcept = (
  scope: OrgScope,
  conceptId: string,
  visibility: ConceptVisibility,
): boolean => scopeConceptRead(scope, conceptId, visibility).reachable

/**
 * ── WHERE FIELD-LEVEL FILTERING MAY AND MAY NOT LIVE ─────────────────────────
 *
 * Concept visibility is a FAILURE, so it is safe anywhere. Field visibility is a
 * PROJECTION, and two tempting placements silently corrupt data:
 *
 *  1. NOT in `toInstance` (services/rows.ts). `InstanceService.update` reads the
 *     current row through it, folds the patch onto that state, and writes the
 *     result back with `SET state = …`. Filtering there means a member's ordinary
 *     edit PERMANENTLY DELETES every hidden field's value.
 *
 *  2. NOT in `FieldService.listFields`. `validateFields` rejects any key absent
 *     from the defs list and `checkRequired` iterates those same defs, so
 *     filtering there makes required hidden fields silently stop being enforced
 *     (and makes writing one look like "unknown field").
 *
 * So both stay TRUTHFUL, and the projection is applied at the use-case boundary —
 * `server/use-cases.ts` is the only path from engine to wire, which makes the set
 * of filtered reads greppable and auditable.
 */

/** Ids of the fields this role may not read, by DEFAULT (no rules consulted).
 *  Empty for a privileged caller. */
export const hiddenFieldIds = (
  defs: ReadonlyArray<{ readonly id: string; readonly visibility: ConceptVisibility }>,
  role: ScopeRole,
): ReadonlySet<string> =>
  canReadRestricted(role)
    ? new Set<string>()
    : new Set(defs.filter((d) => d.visibility !== "visible").map((d) => d.id))

/**
 * Ids of the fields this scope may not read: the defaults above, with rules applied.
 *
 * Field access is per CONCEPT — a field is visible to a caller or it isn't, the same
 * on every record. Field rules are therefore evaluated unconditionally, and a
 * condition on one is ignored by construction (`unconditionalOnly`) rather than
 * quietly making the mask vary per row: that variance is what THE DATA-LOSS GUARD in
 * `test/visibility.test.ts` exists to prevent.
 */
export const scopeHiddenFieldIds = (
  scope: OrgScope,
  defs: ReadonlyArray<{
    readonly id: string
    readonly conceptId: string
    readonly visibility: ConceptVisibility
  }>,
): ReadonlySet<string> => {
  const byDefault = hiddenFieldIds(defs, scope.role)
  if (!scope.policy) return byDefault
  const hidden = new Set<string>()
  for (const def of defs) {
    const readable = decide(
      scope.policy,
      "view",
      { type: "field", id: def.id, conceptId: def.conceptId },
      !byDefault.has(def.id),
      { unconditionalOnly: true },
    )
    if (!readable) hidden.add(def.id)
  }
  return hidden
}

/**
 * Drop hidden keys from an instance's state. Returns the SAME object when nothing
 * is hidden, so the common (privileged, or no restricted fields) path allocates
 * nothing and the identity is preserved for React memo comparisons.
 */
export const projectState = <T extends Record<string, unknown>>(
  state: T,
  hidden: ReadonlySet<string>,
): T => {
  if (hidden.size === 0) return state
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state)) {
    if (hidden.has(k)) {
      touched = true
      continue
    }
    out[k] = v
  }
  return touched ? (out as T) : state
}
