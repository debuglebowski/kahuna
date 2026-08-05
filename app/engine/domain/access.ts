/**
 * ── THE ACCESS MODEL ─────────────────────────────────────────────────────────
 *
 * One mechanism for every "who may do what" question. A **role** is a named bag
 * of **rules**. There is exactly one matcher, not one per feature.
 *
 * Access is a CASCADE: an actor's roles are ordered, each role may be based on
 * another, and resolving a decision walks that ordering as a sequence of TIERS —
 * `tiersOf` groups already-matched rules by `precedence`, `decide`/`decideRecord`
 * walk the tiers ascending, and the first one with a verdict wins outright. See
 * `decide`'s own doc for the walk itself; `PolicyService.loadRules` is where a
 * role's position and based-on chain become the `precedence` number a rule carries.
 *
 * Pure on purpose: no DB, no Effect, no SQL. `PolicyService` loads the rules and
 * `engine/domain/accessSql.ts` compiles conditions to predicates; everything here
 * is a function of its arguments, so the whole decision procedure is unit-testable
 * without a database.
 *
 * Read `domain/visibility.ts` alongside this — it documents the two placements
 * that silently corrupt data, and those constraints still hold.
 */

/** What a caller wants to do. `configure` is schema/settings administration. */
export type AccessAction = "view" | "create" | "edit" | "archive" | "delete" | "share" | "configure"

/**
 * `archive` is soft and restorable (it also covers restore); `delete` is the
 * irreversible purge. They are separate actions so a member can tidy up without
 * being able to destroy — the split already exists in the app (see
 * `archive-delete-convention`) and this makes it grantable.
 */
export const ACCESS_ACTIONS: ReadonlyArray<AccessAction> = [
  "view",
  "create",
  "edit",
  "archive",
  "delete",
  "share",
  "configure",
]

/** Wildcard in a rule's `actions` array — matches every action, present and future. */
export const ACTION_ALL = "*"

/**
 * What a rule can be about — see `AccessResource`.
 *
 * `role` governs role/rule editing itself (creating roles, assigning them, writing
 * rules) and `member` governs the member roster (add/remove/deactivate). Both used
 * to be reachable only through blanket org-`configure` — there was nothing narrower
 * to grant — which meant "may manage people" and "may manage permissions" could
 * never be separated. `configure` on `org` still exists and still gates schema/
 * settings administration (concepts, fields, labels, integrations); it does NOT
 * cover these two any more.
 */
export type AccessResourceType =
  | "org"
  | "concept"
  | "record"
  | "field"
  | "dashboard"
  | "view"
  | "automation"
  | "bucket"
  | "task"
  | "note"
  | "member"
  | "role"

/**
 * The thing being acted on.
 *
 * For `record`, `id` is an **`records.id`** (the lineage), never an `record_versions.id`:
 * a versioned concept has N version rows per record, and a rule naming one record
 * must survive someone publishing a new version. `conceptId` is carried alongside so
 * a concept-scoped rule can match a specific record without a second lookup.
 */
export interface AccessResource {
  readonly type: AccessResourceType
  /** Absent for `org`, and for a "may you create ANY record here?" style question. */
  readonly id?: string
  /** The owning concept, for `record` and `field` resources. */
  readonly conceptId?: string
}

/**
 * A condition narrows a rule to a subset of records.
 *
 * EVERY variant must be compilable to a SQL predicate, because record reads are
 * filtered inside the query rather than after the fetch (a post-fetch filter
 * breaks counts and truncation — `listRecords` runs with a 50k limit). If a
 * condition cannot become SQL, it does not belong in this union.
 *
 * Deliberately NOT `SidebarCondition`: that shape carries `changedTo`/`changedFrom`,
 * which compare against a PRIOR state and therefore cannot be a row predicate.
 * Reusing it would invite an uncompilable condition into a rule.
 */
export type AccessCondition =
  /** Records whose lineage was created by the caller (`records.created_by`). */
  | { readonly kind: "actorIs"; readonly who: "creator" }
  /** Records naming the caller in a `user`-kind field (Owner / AE / Assignee). */
  | { readonly kind: "fieldIs"; readonly fieldId: string }
  /** Records whose state contains these field values (`state @> …`). */
  | { readonly kind: "where"; readonly state: Record<string, unknown> }
  | { readonly kind: "all"; readonly of: ReadonlyArray<AccessCondition> }
  | { readonly kind: "any"; readonly of: ReadonlyArray<AccessCondition> }

/**
 * One grant (or refusal). Attached to a role.
 *
 * `actorId` is a historical column (once a direct per-person share) that
 * `PolicyService.loadRules` no longer reads — shares were removed, since every rule
 * now coming from a role is what makes precedence a complete ordering. Kept typed
 * here because `AccessRuleRow` still selects it and old rows still carry it; a value
 * arriving here is inert, not a signal.
 */
export interface AccessRule {
  readonly id: string
  readonly roleId: string | null
  readonly actorId: string | null
  readonly effect: "allow" | "deny"
  /** Action names, or `["*"]`. Empty grants nothing. */
  readonly actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>
  readonly resourceType: AccessResourceType
  /** null = every resource of this type. */
  readonly resourceId: string | null
  /** For a `record` rule scoped to one concept rather than one record. */
  readonly conceptId: string | null
  /** null = unconditional. */
  readonly condition: AccessCondition | null
  /**
   * Which LAYER this rule resolves in — lower wins outright (see `decide`).
   * Computed by `PolicyService.loadRules` from the held role's
   * `access_role_actors.position` and its `based_on` chain depth; never stored,
   * never round-tripped over the wire.
   *
   * Optional, and defaults to tier 0 wherever it is absent (`tiersOf`) — a
   * hand-built fixture that never sets it therefore shares ONE tier with every
   * other untagged rule, which is exactly the old flat "any deny beats any allow"
   * union. Only real DB-sourced policies differentiate.
   */
  readonly precedence?: number
}

/**
 * Every rule that applies to one actor in one org, via their roles, already unioned.
 * Built by `PolicyService` and carried on `OrgScope`, so a request resolves it once.
 */
export interface PolicySet {
  readonly actorId: string
  /**
   * True only for callers that are not governed at all: migrations, seeds,
   * backfills and the decay tick. NOT automations — those are actors with roles
   * (a scoped automation behaves the same no matter who tripped it).
   */
  readonly unrestricted: boolean
  readonly rules: ReadonlyArray<AccessRule>
  /** `access_policy_versions.version` this set was built from — the cache key. */
  readonly version: number
}

/** The allow-everything set, for migrations/seeds/the decay tick. */
export const unrestrictedPolicy = (actorId: string): PolicySet => ({
  actorId,
  unrestricted: true,
  rules: [],
  version: 0,
})

/** A set with no rules at all: everything falls through to resource defaults. */
export const emptyPolicy = (actorId: string, version = 0): PolicySet => ({
  actorId,
  unrestricted: false,
  rules: [],
  version,
})

const coversAction = (rule: AccessRule, action: AccessAction): boolean =>
  rule.actions.includes(ACTION_ALL) || rule.actions.includes(action)

/**
 * Does this rule's target cover this resource?
 *
 * A null `resourceId` means "every resource of this type". For a `record`, a rule
 * may instead be scoped by `conceptId` — that is what makes "may share any Deal"
 * expressible without a rule per deal.
 */
const coversResource = (rule: AccessRule, resource: AccessResource): boolean => {
  if (rule.resourceType !== resource.type) return false
  if (rule.resourceId !== null) return rule.resourceId === resource.id
  if (rule.conceptId !== null) return rule.conceptId === resource.conceptId
  return true
}

/**
 * Rules relevant to (action, resource), ignoring conditions.
 *
 * Conditions are evaluated in SQL for list reads and by `matchesCondition` for a
 * single known record, so this stays synchronous and data-free.
 */
export const rulesFor = (
  policy: PolicySet,
  action: AccessAction,
  resource: AccessResource,
): ReadonlyArray<AccessRule> =>
  policy.rules.filter((r) => coversAction(r, action) && coversResource(r, resource))

/**
 * Rules that could apply to ANY record of one concept.
 *
 * Distinct from `rulesFor` on purpose. `rulesFor` answers "does this rule cover
 * THIS resource?", so it drops a rule naming a different id — correct for a single
 * check, and wrong for building a list filter, where a rule naming one row is
 * precisely what must be kept and turned into `record_id = …`.
 *
 * Getting this wrong silently drops per-record shares from list queries: the
 * recipient sees an empty list while the record opens fine by id. Both are covered
 * in `access-sql.test.ts`.
 *
 * A rule with no `conceptId` is included whatever its `resourceId`: a bare share
 * doesn't have to name the concept, and the query is already concept-scoped, so a
 * row belonging elsewhere cannot match anyway.
 */
export const recordRulesForConcept = (
  policy: PolicySet,
  action: AccessAction,
  conceptId: string,
): ReadonlyArray<AccessRule> =>
  policy.rules.filter(
    (r) =>
      coversAction(r, action) &&
      r.resourceType === "record" &&
      (r.conceptId === null || r.conceptId === conceptId),
  )

/**
 * Group already-matched rules into precedence TIERS, ascending — tier 0 (or
 * whatever the lowest number present is) is consulted first and wins outright if
 * it has a verdict; a tier with nothing to say is skipped, not a tie-break input.
 *
 * A rule with no `precedence` defaults to tier 0 — see the field's own doc. That is
 * what makes every existing caller (every hand-built test fixture, and every real
 * policy until a role gets ordered or based on another) collapse to exactly ONE
 * tier, i.e. today's flat union: this function changes NOTHING for them, it only
 * gives `decide`/`decideRecord`/`compileRecordFilter` somewhere to put a rule that
 * DOES carry a different tier.
 */
export const tiersOf = (
  rules: ReadonlyArray<AccessRule>,
): ReadonlyArray<ReadonlyArray<AccessRule>> => {
  const byTier = new Map<number, AccessRule[]>()
  for (const r of rules) {
    const key = r.precedence ?? 0
    const list = byTier.get(key)
    if (list) list.push(r)
    else byTier.set(key, [r])
  }
  return [...byTier.entries()].sort(([a], [b]) => a - b).map(([, list]) => list)
}

/**
 * ── THE DECISION ────────────────────────────────────────────────────────────
 *
 * Walk tiers ascending; the FIRST one with a verdict wins outright — nothing below
 * it is even consulted. WITHIN one tier, deny beats allow, same as ever: no
 * specificity ladder there either, because "the narrower rule beats the broader
 * one" is what makes a role unreadable to the human editing it. Ordering is the
 * escape hatch instead — two roles that disagree are resolved by which one the
 * person holds FIRST, not by which rule happens to look more specific.
 *
 * `fallback` is the resource's OWN default (the `visibility` column: everyone /
 * admins only / no one), consulted only when NO tier had a verdict. It stays a
 * column because it is the cheap fast path inside list SQL and answers "who sees
 * this normally?" in a single row read.
 *
 * `unconditionalOnly` is how a caller says "I have no record to test conditions
 * against" — a conditional rule is then treated as not matching, so a conditional
 * grant can never be mistaken for a blanket one.
 */
export const decide = (
  policy: PolicySet,
  action: AccessAction,
  resource: AccessResource,
  fallback: boolean,
  opts: { readonly unconditionalOnly?: boolean } = {},
): boolean => {
  if (policy.unrestricted) return true
  const matched = rulesFor(policy, action, resource)
  for (const tier of tiersOf(matched)) {
    // Deny first, and WITHOUT the conditional filter: a deny carrying a condition
    // still denies here, because without the record's data we cannot prove the
    // condition FAILS. Fail closed.
    if (tier.some((r) => r.effect === "deny")) return false
    // An allow is the opposite polarity — a conditional grant must NOT be mistaken
    // for a blanket one, so it is dropped when there is no record to test it
    // against.
    if (tier.some((r) => r.effect === "allow" && (r.condition === null || !opts.unconditionalOnly)))
      return true
    // Neither in THIS tier — fall through to the next one, not the fallback yet.
  }
  return fallback
}

/**
 * Evaluate a condition against a record we already hold. The in-memory twin of
 * the SQL compiler, for single-record checks (`getInstance`, a write guard) where
 * there is no query to fold a predicate into.
 *
 * The two must agree. `access.test.ts` asserts that on the same fixtures — if they
 * drift, a member sees a record in a list they cannot open, or vice versa.
 */
export const matchesCondition = (
  condition: AccessCondition | null,
  actorId: string,
  record: {
    readonly state: Record<string, unknown>
    readonly createdBy: string | null
  },
): boolean => {
  if (condition === null) return true
  switch (condition.kind) {
    case "actorIs":
      return record.createdBy !== null && record.createdBy === actorId
    case "fieldIs": {
      const v = record.state[condition.fieldId]
      // A `multiple` user field stores an array — the caller matching ANY element
      // is what "records where I'm named" means.
      return Array.isArray(v) ? v.some((x) => x === actorId) : v === actorId
    }
    case "where":
      // Containment, matching `state @> :json`: every named key must be present
      // and equal. Compared as JSON so nested objects behave like the SQL does.
      return Object.entries(condition.state).every(
        ([k, want]) => JSON.stringify(record.state[k]) === JSON.stringify(want),
      )
    case "all":
      return condition.of.every((c) => matchesCondition(c, actorId, record))
    case "any":
      return condition.of.some((c) => matchesCondition(c, actorId, record))
  }
}

/**
 * Decide about a record whose data we have — conditions included.
 *
 * Split from `decide` rather than folded into it so the call sites stay honest:
 * a caller with no record MUST pass `unconditionalOnly` and cannot accidentally
 * get a conditional rule treated as blanket.
 *
 * Same tier walk as `decide`: the first tier with a verdict wins, deny beats allow
 * within it, and `fallback` is only reached when every tier stayed silent.
 */
export const decideRecord = (
  policy: PolicySet,
  action: AccessAction,
  resource: AccessResource,
  fallback: boolean,
  record: { readonly state: Record<string, unknown>; readonly createdBy: string | null },
): boolean => {
  if (policy.unrestricted) return true
  const matched = rulesFor(policy, action, resource).filter((r) =>
    matchesCondition(r.condition, policy.actorId, record),
  )
  for (const tier of tiersOf(matched)) {
    if (tier.some((r) => r.effect === "deny")) return false
    if (tier.some((r) => r.effect === "allow")) return true
  }
  return fallback
}
