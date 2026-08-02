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
