import type { Statement } from "@effect/sql"
import type { PgClient } from "@effect/sql-pg"
import {
  type AccessCondition,
  type AccessRule,
  type PolicySet,
  recordRulesForConcept,
  tiersOf,
} from "./access"

/** The `sql` tag every engine service already holds (`PgClient`, which carries
 *  `.json`). Aliased so the signatures below read as intent, not plumbing. */
type Sql = PgClient.PgClient

/**
 * ── COMPILING ACCESS TO SQL ──────────────────────────────────────────────────
 *
 * Record-level access is a FILTER, and it must live INSIDE the query.
 *
 * This is the third enforcement category, distinct from the two that
 * `domain/visibility.ts` documents: a concept restriction is a FAILURE (safe
 * anywhere) and a field restriction is a PROJECTION (only at the use-case
 * boundary). A record restriction is neither — it decides which ROWS exist for
 * this caller, so filtering after the fetch would make `LIMIT` bound the wrong
 * set. `listRecords` runs with a 50k limit (`server/rpc.ts`), so a post-fetch
 * filter reports wrong counts and truncates the wrong rows.
 *
 * Every `AccessCondition` variant therefore has to become a predicate here. That
 * is why the DSL is small and deliberately not `SidebarCondition` — see the
 * comment on `AccessCondition`.
 *
 * The predicates below are written against a row source exposing `record_id` and
 * `state`, which both `findRecords` branches satisfy (the versioned branch's
 * outer `head` subquery selects `*`).
 */

/** A compiled filter. `"all"` and `"none"` let callers skip the query entirely. */
export type CompiledFilter = "all" | "none" | Statement.Fragment

/**
 * Compile one condition to a row predicate.
 *
 * MUST stay semantically identical to `matchesCondition` — if they drift, a member
 * sees rows in a list they cannot open (or the reverse). `access-sql.test.ts` runs
 * both over the same fixtures against a real database to hold that line.
 */
const compileCondition = (
  sql: Sql,
  condition: AccessCondition,
  actorId: string,
): Statement.Fragment => {
  switch (condition.kind) {
    case "actorIs":
      // The creator lives on the LINEAGE (`records.created_by`), not the version row:
      // publishing a new version must not change who created the record.
      return sql`record_id IN (SELECT id FROM records WHERE created_by = ${actorId})`
    case "fieldIs":
      // Two shapes in one predicate, because a `multiple` user field stores an
      // array while a single one stores a scalar — and the field's `config` is not
      // in scope here. `@>` on a one-element array covers the array case; the
      // `->>` equality covers the scalar. Mirrors `matchesCondition`'s Array check.
      //
      // `JSON.stringify`, NOT `sql.json`, for the array: `sql.json` serializes a
      // TOP-LEVEL JS array as a Postgres array literal, which Postgres then rejects
      // as invalid json. An array nested in an object is fine; this one is not.
      return sql`(state->>${condition.fieldId} = ${actorId}
        OR state->${condition.fieldId} @> ${JSON.stringify([actorId])}::jsonb)`
    case "where":
      // Containment — same operator the `where` option already uses, so it rides
      // the existing `record_versions_state_gin` index.
      return sql`state @> ${sql.json(condition.state)}`
    case "all": {
      // Vacuous truth, matching `matchesCondition`: AND of nothing is TRUE.
      if (condition.of.length === 0) return sql`TRUE`
      const parts = condition.of.map((c) => compileCondition(sql, c, actorId))
      return parts.reduce((acc, p) => sql`(${acc} AND ${p})`)
    }
    case "any": {
      // OR of nothing is FALSE.
      if (condition.of.length === 0) return sql`FALSE`
      const parts = condition.of.map((c) => compileCondition(sql, c, actorId))
      return parts.reduce((acc, p) => sql`(${acc} OR ${p})`)
    }
  }
}

/** The rule's own row predicate: its resource target AND its condition. */
const compileRule = (sql: Sql, rule: AccessRule, actorId: string): Statement.Fragment => {
  // A rule naming one record (`resource_id` = an records.id) restricts to that
  // lineage; one scoped only by concept applies to every record in it.
  const target = rule.resourceId !== null ? sql`record_id = ${rule.resourceId}` : sql`TRUE`
  if (rule.condition === null) return target
  return sql`(${target} AND ${compileCondition(sql, rule.condition, actorId)})`
}

/** OR the rules of one polarity into a single predicate, or null if there are none. */
const anyOf = (
  sql: Sql,
  rules: ReadonlyArray<AccessRule>,
  actorId: string,
): Statement.Fragment | null =>
  rules
    .map((r) => compileRule(sql, r, actorId))
    .reduce((acc, p) => (acc ? sql`(${acc}) OR (${p})` : p), null as Statement.Fragment | null)

/**
 * What the walk has decided so far, folding tiers from the BOTTOM up.
 *
 * `true`/`false` are constants — every remaining tier agreed, or there were none
 * and this is the fallback. A fragment is a per-row expression.
 */
type Tail = boolean | Statement.Fragment

/**
 * ── DENY BEATS ALLOW, IN ONE PLACE ───────────────────────────────────────────
 *
 * One tier folded onto whatever the tiers below it already decided. This used to be
 * TWO functions — one that baked the fallback in for the single-tier fast path, one
 * that emitted a three-valued `CASE` for `COALESCE` to chain — which meant the rule
 * "deny beats allow within a tier, and a silent tier defers" was written twice, in
 * two different shapes, in this one file. They agreed, but only by inspection.
 *
 * The split existed for a real reason, and it is preserved below rather than
 * discarded: when the tail is a CONSTANT, this emits plain boolean algebra
 * (`allow`, `NOT (deny)`, `(allow) AND NOT (deny)`) which leaves the predicates at
 * the top level where an index can still reach them — `record_id = …` on a share,
 * `state @>` on the GIN index. Burying those inside a `CASE` costs the plan. So the
 * constant-tail branch is not a fast path bolted on beside the general one; it is
 * the same fold, taking the cheaper representation when the shape allows it.
 *
 * A useful consequence: the LAST tier of a multi-tier walk now also gets the cheap
 * form, since its tail is the fallback constant. That was not true before.
 */
const foldTier = (sql: Sql, tier: ReadonlyArray<AccessRule>, actorId: string, tail: Tail): Tail => {
  const deny = anyOf(
    sql,
    tier.filter((r) => r.effect === "deny"),
    actorId,
  )
  const allow = anyOf(
    sql,
    tier.filter((r) => r.effect === "allow"),
    actorId,
  )
  // `tiersOf` never yields an empty tier, so at least one side is non-null.

  if (typeof tail === "boolean") {
    // Rows this tier says nothing about fall through to a constant, so the whole
    // thing collapses to boolean algebra.
    if (!deny) return tail === true ? true : allow!
    if (!allow) return tail === true ? sql`NOT (${deny})` : false
    return tail === true ? sql`NOT (${deny})` : sql`(${allow}) AND NOT (${deny})`
  }

  // The tail is per-row, so this tier must be able to say "no verdict" for a row and
  // defer. SQL `NULL` is that, and `COALESCE` is SQL's own "first verdict wins".
  const verdict =
    deny && allow
      ? sql`CASE WHEN ${deny} THEN FALSE WHEN ${allow} THEN TRUE END`
      : deny
        ? sql`CASE WHEN ${deny} THEN FALSE END`
        : sql`CASE WHEN ${allow} THEN TRUE END`
  return sql`COALESCE(${verdict}, ${tail})`
}

/**
 * The row filter for reading one concept's records.
 *
 * `fallback` is the concept's own default — whether this caller may read its
 * records absent any rule ANYWHERE, consulted only once every tier has stayed
 * silent about a given row.
 *
 * Returns `"all"` / `"none"` when nothing constrains the read at all (no rule
 * matched — the overwhelmingly common path, so the query is byte-identical to
 * today's) or when the FIRST tier decides it outright with no lower tier ever
 * reachable.
 */
export const compileRecordFilter = (
  sql: Sql,
  policy: PolicySet,
  conceptId: string,
  fallback: boolean,
): CompiledFilter => {
  if (policy.unrestricted) return "all"
  // `recordRulesForConcept`, NOT `rulesFor`: a rule naming ONE record must be kept
  // and compiled to `record_id = …`, not dropped for failing to match a resource we
  // are not asking about. See the comment on `recordRulesForConcept`.
  const rules = recordRulesForConcept(policy, "view", conceptId)
  if (rules.length === 0) return fallback ? "all" : "none"

  const tiers = tiersOf(rules)

  // A blanket deny (no target, no condition) in the FIRST — lowest-precedence —
  // tier kills the read before any lower tier is even relevant: it is
  // unconditionally TRUE for every row, so the fold would land on FALSE for all of
  // them anyway. This just lets the caller skip the query entirely.
  if (tiers[0]!.some((r) => r.effect === "deny" && r.resourceId === null && r.condition === null))
    return "none"

  // Fold from the BOTTOM tier up, starting at the fallback. Right-to-left because
  // each tier needs to know what the ones below it already decided in order to
  // choose its cheap constant-tail form; and because the `sql` helper composes by
  // interpolation rather than by splicing a variable-length argument list — same
  // reasoning as `compileCondition`'s all/any folds.
  let acc: Tail = fallback
  for (let i = tiers.length - 1; i >= 0; i--) {
    acc = foldTier(sql, tiers[i]!, policy.actorId, acc)
  }
  return acc === true ? "all" : acc === false ? "none" : acc
}

/**
 * Fold a compiled filter into a query as an ` AND (…)` fragment.
 *
 * `"none"` becomes `AND FALSE` rather than a short-circuit so callers keep ONE
 * code path — the planner drops the scan anyway, and a second early-return branch
 * in `findRecords` is exactly where a future edit would forget the filter.
 */
export const filterFragment = (sql: Sql, filter: CompiledFilter): Statement.Fragment => {
  if (filter === "all") return sql``
  if (filter === "none") return sql` AND FALSE`
  return sql` AND (${filter})`
}
