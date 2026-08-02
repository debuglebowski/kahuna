import type { ScopeRole } from "../services/OrgContext"
import type { ConceptVisibility } from "./types"

/**
 * Read-visibility predicates. Pure, so they are unit-testable without a database
 * and usable from both the engine services and the use-case boundary.
 *
 * The privilege order is deliberately explicit rather than a rank comparison: a
 * new role must be classified here on purpose, not inherit access by sorting
 * above "member".
 */

/** May this role read admin-only material? `"system"` is the engine itself. */
export const canReadRestricted = (role: ScopeRole): boolean =>
  role === "owner" || role === "admin" || role === "system"

/**
 * May this role read a concept with this visibility?
 *
 * Note the default direction: an unrecognised visibility never reaches here,
 * because `toConcept` already coerces anything it doesn't know to `"admin"`.
 */
export const canReadConcept = (visibility: ConceptVisibility, role: ScopeRole): boolean =>
  visibility === "visible" || canReadRestricted(role)

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

/** Ids of the fields this role may not read. Empty for a privileged caller. */
export const hiddenFieldIds = (
  defs: ReadonlyArray<{ readonly id: string; readonly visibility: ConceptVisibility }>,
  role: ScopeRole,
): ReadonlySet<string> =>
  canReadRestricted(role)
    ? new Set<string>()
    : new Set(defs.filter((d) => d.visibility === "admin").map((d) => d.id))

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
