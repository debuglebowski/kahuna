import { PgClient } from "@effect/sql-pg"
import { Effect, Ref } from "effect"
import {
  ACTION_ALL,
  type AccessAction,
  type AccessCondition,
  type AccessResourceType,
  type AccessRule,
  emptyPolicy,
  type PolicySet,
} from "../domain/access"

/** A row of `access_rules`, as `loadRules` returns it — `precedence` is computed
 *  by the query, not a column on the table (see `AccessRule.precedence`). */
interface AccessRuleRow {
  readonly id: string
  readonly role_id: string | null
  readonly actor_id: string | null
  readonly effect: string
  readonly actions: ReadonlyArray<string>
  readonly resource_type: string
  readonly resource_id: string | null
  readonly concept_id: string | null
  readonly condition: unknown
  readonly precedence: number
}

/**
 * A condition that can never hold — an empty `any` (OR of nothing is FALSE, in
 * both the evaluator and the SQL compiler). The fail-closed value for a condition
 * we cannot parse: the rule stays present but grants nothing.
 */
const UNSATISFIABLE: AccessCondition = { kind: "any", of: [] }

/**
 * Narrow a stored condition to the typed union, or null.
 *
 * `null` here means UNCONDITIONAL, which is the WIDENING direction for an allow —
 * so a malformed condition must never become null. Rules are only written through
 * validated RPCs, but this is a boundary from `jsonb`, so anything unrecognised
 * becomes `UNSATISFIABLE` instead.
 */
const toCondition = (raw: unknown): AccessCondition | null => {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "object") return UNSATISFIABLE
  const kind = (raw as { kind?: unknown }).kind
  switch (kind) {
    case "actorIs":
      return (raw as { who?: unknown }).who === "creator"
        ? { kind: "actorIs", who: "creator" }
        : UNSATISFIABLE
    case "fieldIs": {
      const fieldId = (raw as { fieldId?: unknown }).fieldId
      return typeof fieldId === "string" ? { kind: "fieldIs", fieldId } : UNSATISFIABLE
    }
    case "where": {
      const state = (raw as { state?: unknown }).state
      return state && typeof state === "object"
        ? { kind: "where", state: state as Record<string, unknown> }
        : UNSATISFIABLE
    }
    case "all":
    case "any": {
      const of = (raw as { of?: unknown }).of
      if (!Array.isArray(of)) return UNSATISFIABLE
      const parsed = of.map(toCondition)
      // A malformed child must not vanish (that would widen an `all`), so it is
      // carried through as the unsatisfiable condition.
      return { kind, of: parsed.map((c) => c ?? UNSATISFIABLE) }
    }
    default:
      return UNSATISFIABLE
  }
}

const KNOWN_ACTIONS = new Set<string>([
  "view",
  "create",
  "edit",
  "archive",
  "delete",
  "share",
  "configure",
])

const toRule = (r: AccessRuleRow): AccessRule => ({
  id: r.id,
  roleId: r.role_id,
  actorId: r.actor_id,
  // Fail CLOSED on an unrecognised effect: anything that isn't exactly "allow"
  // is a deny, matching the polarity of `visibility`'s coercion in rows.ts.
  effect: r.effect === "allow" ? "allow" : "deny",
  actions: r.actions.filter(
    (a): a is AccessAction | typeof ACTION_ALL => a === ACTION_ALL || KNOWN_ACTIONS.has(a),
  ),
  resourceType: r.resource_type as AccessResourceType,
  resourceId: r.resource_id,
  conceptId: r.concept_id,
  condition: toCondition(r.condition),
  precedence: r.precedence,
})

/** One memoized entry: the rules an actor holds, and the generation they came from. */
interface CacheEntry {
  readonly version: number
  readonly policy: PolicySet
}

/**
 * Resolves the access rules that apply to one actor.
 *
 * WHY A CACHE. Every request needs the full rule set before it can filter a list,
 * and the set changes rarely (only when someone edits a role or shares something).
 * So it is memoized per (org, actor) and keyed on `access_policy_versions.version`,
 * which every access write bumps. That gives correctness without a TTL: a rule
 * change is visible to the very next request, and a stale entry is impossible
 * because the version is read fresh each time.
 *
 * The version read is one indexed primary-key lookup — far cheaper than the join
 * it replaces, which is the point.
 */
export class PolicyService extends Effect.Service<PolicyService>()("engine/PolicyService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    // Process-wide, not request-scoped: the whole point is to survive across
    // requests. Bounded by (orgs × actors), and entries are replaced not appended.
    const cache = yield* Ref.make(new Map<string, CacheEntry>())

    /** The org's current policy generation. A missing row reads as 0. */
    const versionOf = (orgId: string) =>
      sql<{ readonly version: number }>`
        SELECT version FROM access_policy_versions WHERE org_id = ${orgId} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.version ?? 0),
      )

    /**
     * Bump the generation, invalidating every cached entry for the org.
     *
     * Called by every access write. An upsert, so an org that has never had a rule
     * starts at 1 the first time one is written.
     */
    const bump = (orgId: string) =>
      sql`
        INSERT INTO access_policy_versions (org_id, version, updated_at)
        VALUES (${orgId}, 1, now())
        ON CONFLICT (org_id)
        DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now()`.pipe(
        Effect.asVoid,
      )

    /**
     * Every rule applying to `actorId`, via their roles — each carrying the
     * PRECEDENCE it resolves at (see `AccessRule.precedence` / `decide`).
     *
     * `r.actor_id` (a direct share) is deliberately NOT read here any more. Shares
     * were removed — every rule now comes from a role, which is what makes a fixed
     * (role position, chain depth) precedence a complete ordering. The column stays
     * on `access_rules` and is not written to, the same rollback window earlier
     * migrations used; it is dropped in a later release.
     *
     * ── WHAT MAKES DEACTIVATION REAL ─────────────────────────────────────────
     *
     * `access_roles.active` is filtered HERE, not in the UI and not on assignment.
     * An inactive role's rules never enter any policy, so it grants nothing to
     * anybody — while its assignments stay on the table, which is what lets
     * reactivating restore exactly what was there. Every other treatment (hiding the
     * row, refusing new assignments) would leave existing holders still holding it.
     * An inactive PARENT stops the based-on walk too (`parent.active = true` below)
     * — a child must not silently keep inheriting from a role that was turned off.
     *
     * ── THE PRECEDENCE WALK ──────────────────────────────────────────────────
     *
     * `chain` is a recursive CTE: it starts at every role `actorId` directly holds
     * (depth 0, precedence `(position + 1) * 100` — Layer 1 is reserved for a
     * PERSONAL role, `personal_for IS NOT NULL`, which always resolves at 0
     * regardless of position, and Layer 0 is the owner's recovery floor, added by
     * the caller of this service, never a row here), then walks each role's `based_on` parent
     * upward, one hop = one more point of precedence AND one more step of `depth`
     * (a defensive cap, `< 8`, purely against a cycle nothing today can create —
     * `based_on` accepts no write path yet — but this runs on every request, so a
     * future bug must not turn it into an unbounded loop).
     *
     * The SAME role can be reachable more than one way (held directly AND inherited
     * through a different held role's chain) — `best` takes `MIN(precedence)`, the
     * more favourable path, per role. With every `position` at its default 0 and no
     * `based_on` set anywhere yet, every held role computes to the SAME precedence
     * (100) — one tier, i.e. today's flat union, unchanged.
     */
    const loadRules = (orgId: string, actorId: string) =>
      sql<AccessRuleRow>`
        WITH RECURSIVE chain AS (
          SELECT a.role_id AS role_id, 0 AS depth,
                 CASE WHEN ro.personal_for IS NOT NULL THEN 0
                      ELSE (a.position + 1) * 100 END AS precedence
            FROM access_role_actors a
            JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
           WHERE a.org_id = ${orgId} AND a.actor_id = ${actorId} AND ro.active = true
          UNION ALL
          SELECT parent.id AS role_id, chain.depth + 1 AS depth,
                 chain.precedence + 1 AS precedence
            FROM chain
            JOIN access_roles child ON child.id = chain.role_id
            JOIN access_roles parent
              ON parent.id = child.based_on AND parent.org_id = child.org_id
           WHERE parent.active = true AND chain.depth < 8
        ),
        best AS (
          SELECT role_id, MIN(precedence) AS precedence FROM chain GROUP BY role_id
        )
        SELECT r.id, r.role_id, r.actor_id, r.effect, r.actions,
               r.resource_type, r.resource_id, r.concept_id, r.condition,
               b.precedence
        FROM best b
        JOIN access_rules r ON r.role_id = b.role_id AND r.org_id = ${orgId}`.pipe(
        Effect.map((rows) => rows.map(toRule)),
      )

    /** The actor's resolved policy, from cache when the generation still matches. */
    const resolve = (orgId: string, actorId: string): Effect.Effect<PolicySet> =>
      Effect.gen(function* () {
        const version = yield* versionOf(orgId)
        const key = `${orgId}:${actorId}`
        const hit = (yield* Ref.get(cache)).get(key)
        if (hit && hit.version === version) return hit.policy
        const rules = yield* loadRules(orgId, actorId)
        const policy: PolicySet = { ...emptyPolicy(actorId, version), rules }
        yield* Ref.update(cache, (m) => new Map(m).set(key, { version, policy }))
        return policy
      }).pipe(
        // A policy read must never take a request down. An unreachable DB fails the
        // request elsewhere (every other query dies too); here we fall back to the
        // empty set, which grants nothing beyond resource defaults — fail closed.
        Effect.catchAll(() => Effect.succeed(emptyPolicy(actorId))),
      )

    /** Drop every cached entry (tests, and after a bulk backfill). */
    const invalidateAll = Ref.set(cache, new Map<string, CacheEntry>())

    return { resolve, bump, versionOf, invalidateAll } as const
  }),
}) {}
