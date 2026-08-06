import type { OrgScope } from "../services/OrgContext"
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

/**
 * The OLD default answer for a concept: may this role read one with this visibility?
 *
 * No longer consulted at request time — concept access is now an explicit rule per
 * (concept, role), and `scopeConceptRead` fails closed without one. This survives
 * ONLY so `scripts/backfill-access-values.ts` and its proof can compute what access
 * used to answer, which is how the migration proves it changed nothing. It goes when
 * the `visibility` column does.
 *
 * `role` is a bare `string`, not `ScopeRole`: the value it cares about most is
 * `"admin"`, which membership no longer has. A historical answer has to keep
 * accepting historical inputs.
 */
export const canReadConcept = (visibility: ConceptVisibility, role: string): boolean =>
  // The old ROLE predicate, inlined. It is not `canReadRestricted` any more: that one
  // moved onto the rules, and this function's only job is to reproduce what the
  // membership tier answered BEFORE it did. Sharing an implementation would mean the
  // proof drifts with the thing it is proving.
  visibility === "visible" ||
  (visibility !== "none" && (role === "owner" || role === "admin" || role === "system"))

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

export const scopeConceptRead = (scope: OrgScope, conceptId: string): ConceptReadDecision => {
  // The engine itself — migrations, seeds, the decay tick — is exempt. It is the ONLY
  // exemption: `sessionScope`'s type makes "system" unreachable from a request, so
  // this cannot be claimed over HTTP.
  if (scope.role === "system") return { reachable: true, recordsByDefault: true }
  // FAIL CLOSED. There is no `visibility` column behind this any more: a concept is
  // readable because a rule says so, full stop. An absent policy therefore grants
  // nothing rather than falling through to a default.
  if (!scope.policy) return { reachable: false, recordsByDefault: false }
  const granted = decide(scope.policy, "view", { type: "concept", id: conceptId }, false, {
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
export const scopeCanReadConcept = (scope: OrgScope, conceptId: string): boolean =>
  scopeConceptRead(scope, conceptId).reachable
