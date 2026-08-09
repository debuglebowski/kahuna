import type { OrgScope } from "../services/OrgContext"
import { decide, recordRulesForConcept, rulesFor } from "./access"

/**
 * Read-visibility predicates. Pure, so they are unit-testable without a database
 * and usable from both the engine services and the use-case boundary.
 *
 * ── THERE IS ONLY ONE LAYER NOW ──────────────────────────────────────────────
 *
 * This file used to compose two: a `concepts.visibility` column holding the DEFAULT
 * ("who reads this normally, by role") with `access_rules` as exceptions layered
 * over it. The column is gone — dropped in migration 0022, after a long stretch in
 * which nothing consulted it at request time — along with `canReadConcept`, the
 * role-tier answer it fed.
 *
 * A concept is readable because a RULE says so, full stop. That is why everything
 * below fails closed on an absent policy rather than falling through to a default:
 * there is no longer a default to fall through to.
 */

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
  // NO `scope.role === "system"` BRANCH, deliberately. The engine's exemption is
  // carried by `unrestrictedPolicy`, which `decide()` honours on its first line, and
  // `systemScope` is the only thing that ever sets `role: "system"` — so a hand-rolled
  // check here was the same exemption written a second way, free to drift from the
  // first. One exemption, in one place.
  //
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
