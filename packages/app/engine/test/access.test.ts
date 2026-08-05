import { describe, expect, it } from "@effect/vitest"
import {
  ACCESS_ACTIONS,
  type AccessCondition,
  type AccessRule,
  decide,
  decideRecord,
  emptyPolicy,
  explainDecision,
  matchesCondition,
  type PolicySet,
  rulesFor,
  unrestrictedPolicy,
} from "../domain/access"
import { TEMPLATED_TYPES } from "../services/AccessDefaultsService"
import { BUILTIN_ROLES } from "../services/AccessRoleService"

/**
 * The decision procedure, tested without a database.
 *
 * These are the invariants the whole feature rests on — especially DENY WINS and
 * "a conditional rule is never mistaken for a blanket one". Everything downstream
 * (the SQL compiler, the RPC gate) assumes them.
 */

const ACTOR = "user-1"

const rule = (over: Partial<AccessRule> = {}): AccessRule => ({
  id: over.id ?? "r1",
  roleId: over.roleId ?? "role-1",
  actorId: over.actorId ?? null,
  effect: over.effect ?? "allow",
  actions: over.actions ?? ["view"],
  resourceType: over.resourceType ?? "concept",
  resourceId: over.resourceId ?? null,
  conceptId: over.conceptId ?? null,
  condition: over.condition ?? null,
  // Deliberately spread, not defaulted: most callers never set it and want it
  // ABSENT (undefined), not 0 — `tiersOf` treats "absent" and "0" the same, but an
  // explicit test for that equivalence (below) needs to be able to tell them apart
  // in the fixture, which a `?? 0` default here would make impossible.
  ...(over.precedence !== undefined ? { precedence: over.precedence } : {}),
})

const policy = (rules: ReadonlyArray<AccessRule>): PolicySet => ({
  ...emptyPolicy(ACTOR),
  rules,
})

describe("access decisions", () => {
  it("falls through to the resource default when no rule matches", () => {
    const p = policy([])
    expect(decide(p, "view", { type: "concept", id: "c1" }, true)).toBe(true)
    expect(decide(p, "view", { type: "concept", id: "c1" }, false)).toBe(false)
  })

  it("an allow rule overrides a closed default", () => {
    const p = policy([rule({ resourceId: "c1" })])
    expect(decide(p, "view", { type: "concept", id: "c1" }, false)).toBe(true)
    // A different concept is untouched — the rule is targeted.
    expect(decide(p, "view", { type: "concept", id: "c2" }, false)).toBe(false)
  })

  it("THE DENY GUARD: a narrow allow must never beat a broad deny", () => {
    // The precedence trap. Every "specificity ladder" design would let the
    // record-specific allow win here; ours must not, or a role becomes unreadable
    // to the person editing it.
    const p = policy([
      rule({ id: "broad", effect: "deny", resourceType: "record", resourceId: null }),
      rule({ id: "narrow", effect: "allow", resourceType: "record", resourceId: "record-1" }),
    ])
    expect(decide(p, "view", { type: "record", id: "record-1" }, true)).toBe(false)
  })

  it("a deny that carries a condition still denies when we cannot test it", () => {
    // Fail CLOSED: without the record's data we cannot prove the condition fails,
    // so the deny stands. Opposite polarity to an allow (next test).
    const p = policy([rule({ effect: "deny", condition: { kind: "actorIs", who: "creator" } })])
    expect(
      decide(p, "view", { type: "concept", id: "c1" }, true, { unconditionalOnly: true }),
    ).toBe(false)
  })

  it("a conditional allow is NOT treated as a blanket allow", () => {
    const p = policy([
      rule({ condition: { kind: "actorIs", who: "creator" }, resourceType: "record" }),
    ])
    // No record to test against ⇒ the conditional grant does not apply.
    expect(decide(p, "view", { type: "record" }, false, { unconditionalOnly: true })).toBe(false)
    // With a record that satisfies it, the same rule grants.
    expect(
      decideRecord(p, "view", { type: "record", id: "i1" }, false, { state: {}, createdBy: ACTOR }),
    ).toBe(true)
  })

  it("the wildcard action covers every action, including ones added later", () => {
    const p = policy([rule({ actions: ["*"] })])
    for (const action of ACCESS_ACTIONS)
      expect(decide(p, action, { type: "concept", id: "c1" }, false)).toBe(true)
  })

  it("archive and delete are separately grantable", () => {
    // The point of splitting them: tidy up without being able to destroy.
    const p = policy([rule({ actions: ["archive"], resourceType: "record" })])
    expect(decide(p, "archive", { type: "record", id: "i1" }, false)).toBe(true)
    expect(decide(p, "delete", { type: "record", id: "i1" }, false)).toBe(false)
  })

  it("a concept-scoped record rule covers that concept's records only", () => {
    // How "may share any Deal" is expressed without a rule per deal.
    const p = policy([rule({ actions: ["share"], resourceType: "record", conceptId: "deals" })])
    expect(decide(p, "share", { type: "record", id: "i1", conceptId: "deals" }, false)).toBe(true)
    expect(decide(p, "share", { type: "record", id: "i2", conceptId: "people" }, false)).toBe(false)
  })

  it("an unrestricted policy bypasses everything, including denies", () => {
    const p: PolicySet = { ...unrestrictedPolicy("seed"), rules: [rule({ effect: "deny" })] }
    expect(decide(p, "delete", { type: "concept", id: "c1" }, false)).toBe(true)
  })

  it("a role rule and a direct share are the same mechanism", () => {
    const viaRole = policy([rule({ roleId: "role-1", actorId: null, resourceId: "c1" })])
    const viaShare = policy([rule({ roleId: null, actorId: ACTOR, resourceId: "c1" })])
    const q = { type: "concept", id: "c1" } as const
    expect(decide(viaRole, "view", q, false)).toBe(decide(viaShare, "view", q, false))
  })

  it("rulesFor ignores rules about other actions or resource types", () => {
    const p = policy([
      rule({ id: "a", actions: ["edit"] }),
      rule({ id: "b", resourceType: "dashboard" }),
      rule({ id: "c" }),
    ])
    expect(rulesFor(p, "view", { type: "concept", id: "c1" }).map((r) => r.id)).toEqual(["c"])
  })
})

describe("access conditions", () => {
  const rec = (state: Record<string, unknown>, createdBy: string | null = null) => ({
    state,
    createdBy,
  })

  it("actorIs creator matches only the lineage's creator", () => {
    const c: AccessCondition = { kind: "actorIs", who: "creator" }
    expect(matchesCondition(c, ACTOR, rec({}, ACTOR))).toBe(true)
    expect(matchesCondition(c, ACTOR, rec({}, "someone-else"))).toBe(false)
    // An unattributed record (pre-backfill, or created by a sync) matches nobody.
    expect(matchesCondition(c, ACTOR, rec({}, null))).toBe(false)
  })

  it("fieldIs matches a single user field and any element of a multiple one", () => {
    const c: AccessCondition = { kind: "fieldIs", fieldId: "owner" }
    expect(matchesCondition(c, ACTOR, rec({ owner: ACTOR }))).toBe(true)
    expect(matchesCondition(c, ACTOR, rec({ owner: "other" }))).toBe(false)
    expect(matchesCondition(c, ACTOR, rec({ owner: ["other", ACTOR] }))).toBe(true)
    expect(matchesCondition(c, ACTOR, rec({ owner: ["other"] }))).toBe(false)
    expect(matchesCondition(c, ACTOR, rec({}))).toBe(false)
  })

  it("where is containment, like `state @> :json`", () => {
    const c: AccessCondition = { kind: "where", state: { stage: "active" } }
    expect(matchesCondition(c, ACTOR, rec({ stage: "active", other: 1 }))).toBe(true)
    expect(matchesCondition(c, ACTOR, rec({ stage: "won" }))).toBe(false)
    expect(matchesCondition(c, ACTOR, rec({}))).toBe(false)
  })

  it("all / any combine, and null is unconditional", () => {
    const mine: AccessCondition = { kind: "actorIs", who: "creator" }
    const active: AccessCondition = { kind: "where", state: { stage: "active" } }
    const r = rec({ stage: "active" }, "other")
    expect(matchesCondition({ kind: "all", of: [mine, active] }, ACTOR, r)).toBe(false)
    expect(matchesCondition({ kind: "any", of: [mine, active] }, ACTOR, r)).toBe(true)
    expect(matchesCondition(null, ACTOR, r)).toBe(true)
  })

  it("an empty all grants and an empty any refuses", () => {
    // Vacuous-truth semantics, stated explicitly so the SQL compiler matches:
    // `AND` of nothing is TRUE, `OR` of nothing is FALSE.
    const r = rec({})
    expect(matchesCondition({ kind: "all", of: [] }, ACTOR, r)).toBe(true)
    expect(matchesCondition({ kind: "any", of: [] }, ACTOR, r)).toBe(false)
  })
})

describe("the presets reproduce today's behaviour", () => {
  const byKey = (key: string) => BUILTIN_ROLES.find((r) => r.key === key)!

  it("THE BLANKET-VIEW GUARD: the member preset must not grant view on a TEMPLATED type", () => {
    // Read access on a TEMPLATED type (concept/record/dashboard/view/automation) is
    // the DEFAULT LAYER's job — a creation-time rule, or (for concept/field) the
    // `visibility` column. A preset rule granting `view` there has `resource_id =
    // null`, so it would OUTRANK that default and hand members every admin-only
    // concept — silently undoing concept and field visibility.
    //
    // The engine tests would NOT catch that regression: `testLayer` provides a role
    // but no policy, so they fall through to the fallback and pass either way. Only
    // a real request resolves the blanket rule. Hence this assertion.
    for (const rule of byKey("member").rules) {
      if (!TEMPLATED_TYPES.includes(rule.resourceType)) continue
      expect(rule.actions, `member grants view on templated ${rule.resourceType}`).not.toContain(
        "view",
      )
      expect(rule.actions).not.toContain("*")
    }
  })

  it("the member preset DOES grant view on the six UNTEMPLATED types — P8", () => {
    // These have no per-resource default of their own to outrank (no creation-time
    // rule, no visibility column), so the reasoning above does not apply — and
    // since P8 closed the implicit "no rule = allowed" fallback they used to rely
    // on, an explicit grant is the only thing keeping today's behaviour.
    const untemplatedVisible = ["org", "field", "bucket", "task", "note", "member"]
    for (const resourceType of untemplatedVisible) {
      const rules = byKey("member").rules.filter((r) => r.resourceType === resourceType)
      const actions = new Set(rules.flatMap((r) => r.actions))
      expect(actions.has("view"), `member should grant view on ${resourceType}`).toBe(true)
    }
    // `role` is untemplated too, but deliberately excluded: role/rule editing is
    // governed entirely by `configure`, with no separate "view" of its own.
    expect(
      byKey("member")
        .rules.filter((r) => r.resourceType === "role")
        .flatMap((r) => r.actions),
    ).not.toContain("view")
  })

  it("member holds the write actions it has today, and not the two it doesn't", () => {
    const actions = new Set(byKey("member").rules.flatMap((r) => r.actions))
    expect(actions.has("create")).toBe(true)
    expect(actions.has("edit")).toBe(true)
    // Record version archive/restore is any member today.
    expect(actions.has("archive")).toBe(true)
    // Both are admin-gated at the RPC boundary today; granting either would widen.
    expect(actions.has("delete")).toBe(false)
    expect(actions.has("configure")).toBe(false)
  })

  it("Admin holds the wildcard, so restricted reads still work for it", () => {
    // Only Admin, because there is no Owner ROLE: an owner is a membership flag
    // whose session resolves unrestricted, which no rule can grant or take away.
    const actions = new Set(byKey("admin").rules.flatMap((r) => r.actions))
    expect(actions.has("*")).toBe(true)
    expect(BUILTIN_ROLES.some((r) => r.key === "owner")).toBe(false)
  })

  it("a blanket view rule DOES override a closed default — which is why none is seeded", () => {
    // Demonstrates the mechanism the guard above protects against, so the reason
    // for that guard is executable rather than only written down.
    const blanket: AccessRule = rule({ actions: ["view"], resourceType: "concept" })
    expect(decide(policy([blanket]), "view", { type: "concept", id: "restricted" }, false)).toBe(
      true,
    )
  })
})

/**
 * ── THE CASCADE ─────────────────────────────────────────────────────────────
 *
 * `precedence` groups already-matched rules into TIERS (`tiersOf`); `decide` /
 * `decideRecord` walk them ascending and stop at the first tier with a verdict.
 * Everything above this block never sets `precedence`, so every rule there shares
 * the implicit tier 0 — one bucket, "any deny beats any allow", the old flat
 * union. These tests are the ones that actually exercise more than one tier.
 */
describe("the cascade — tiers resolve in precedence order", () => {
  const tier = (n: number, over: Partial<AccessRule> = {}) => rule({ ...over, precedence: n })

  it("a HIGHER-precedence (later) tier's allow never overrides a lower tier's deny", () => {
    // The property that does NOT hold, on purpose: a role held first denying
    // something is not something a role held second can undo by allowing it.
    const p = policy([tier(0, { effect: "deny" }), tier(1, { effect: "allow" })])
    expect(decide(p, "view", { type: "concept", id: "c1" }, false)).toBe(false)
  })

  it("a LOWER-precedence (earlier) tier's allow beats a later tier's deny", () => {
    // This is the actual promise of the cascade: two roles that disagree are
    // resolved by which the person holds FIRST, not by deny always winning
    // globally — that only still holds WITHIN one tier.
    const p = policy([tier(0, { effect: "allow" }), tier(1, { effect: "deny" })])
    expect(decide(p, "view", { type: "concept", id: "c1" }, false)).toBe(true)
  })

  it("a silent tier is skipped, not treated as a verdict", () => {
    // Tier 0 doesn't mention this resource at all (it's for a different concept),
    // so resolution must fall through to tier 1 rather than stopping at 0 with
    // nothing decided.
    const p = policy([tier(0, { resourceId: "other-concept" }), tier(1, { effect: "deny" })])
    expect(decide(p, "view", { type: "concept", id: "c1" }, false)).toBe(false)
    expect(decide(p, "view", { type: "concept", id: "other-concept" }, true)).toBe(true)
  })

  it("every tier silent falls through to the fallback, same as no rules at all", () => {
    const p = policy([tier(0, { resourceId: "x" }), tier(1, { resourceId: "y" })])
    expect(decide(p, "view", { type: "concept", id: "c1" }, true)).toBe(true)
    expect(decide(p, "view", { type: "concept", id: "c1" }, false)).toBe(false)
  })

  it("deny still beats allow WITHIN one tier — that half of today's rule survives", () => {
    const p = policy([tier(0, { effect: "deny" }), tier(0, { effect: "allow" })])
    expect(decide(p, "view", { type: "concept", id: "c1" }, true)).toBe(false)
  })

  it("decideRecord walks tiers identically, conditions included", () => {
    const record = { state: {}, createdBy: ACTOR }
    const p = policy([
      tier(0, { effect: "allow", condition: { kind: "actorIs", who: "creator" } }),
      tier(1, { effect: "deny" }),
    ])
    // Tier 0's conditional allow matches THIS record, so it wins outright — tier
    // 1's blanket deny is never reached.
    expect(decideRecord(p, "view", { type: "concept", id: "c1" }, false, record)).toBe(true)
    // A record the tier-0 condition does NOT match falls through to tier 1.
    const someoneElses = { state: {}, createdBy: "someone-else" }
    expect(decideRecord(p, "view", { type: "concept", id: "c1" }, false, someoneElses)).toBe(false)
  })

  it("a rule with no precedence shares tier 0 with everything else untagged", () => {
    // The compatibility property every existing fixture (including every test
    // above this block) relies on without knowing it.
    const untagged = rule({ effect: "deny" })
    const explicitTierZero = tier(0, { effect: "allow", id: "r2" })
    const p = policy([untagged, explicitTierZero])
    // Same tier → deny wins within it, exactly like the flat model.
    expect(decide(p, "view", { type: "concept", id: "c1" }, true)).toBe(false)
  })
})

/**
 * ── THE EXPLAIN VIEW'S ENGINE ────────────────────────────────────────────────
 *
 * `explainDecision` is `decide`'s traceable twin: same tier walk, but it returns
 * every tier's verdict instead of stopping at the first one. These tests assert
 * it agrees with `decide` on the OUTCOME in every shape `decide` is tested above,
 * plus what only the trace can show: which tier decided, and that a silent tier
 * still appears rather than vanishing.
 */
describe("explainDecision — decide's traceable twin", () => {
  const tier = (n: number, over: Partial<AccessRule> = {}) => rule({ ...over, precedence: n })
  const q = { type: "concept", id: "c1" } as const

  it("unrestricted short-circuits with an empty trace, same as decide", () => {
    const p: PolicySet = { ...unrestrictedPolicy("seed"), rules: [rule({ effect: "deny" })] }
    const r = explainDecision(p, "view", q, false)
    expect(r).toEqual({ outcome: true, unrestricted: true, layers: [], decidedByFallback: false })
  })

  it("no covering rule at all: no layers, outcome is the fallback", () => {
    const p = policy([rule({ resourceType: "dashboard" })])
    const r = explainDecision(p, "view", q, true)
    expect(r.layers).toEqual([])
    expect(r.outcome).toBe(true)
    expect(r.decidedByFallback).toBe(true)
  })

  it("a single allowing tier decides, and is marked as the one that did", () => {
    const p = policy([rule({ effect: "allow" })])
    const r = explainDecision(p, "view", q, false)
    expect(r.outcome).toBe(true)
    expect(r.decidedByFallback).toBe(false)
    expect(r.layers).toHaveLength(1)
    expect(r.layers[0]).toMatchObject({ precedence: 0, verdict: "allow", decided: true })
  })

  it("a single denying tier decides false", () => {
    const p = policy([rule({ effect: "deny" })])
    const r = explainDecision(p, "view", q, true)
    expect(r.outcome).toBe(false)
    expect(r.layers[0]).toMatchObject({ verdict: "deny", decided: true })
  })

  it("a LOWER tier's allow beats a HIGHER tier's deny, and only the lower is decided", () => {
    const p = policy([tier(0, { effect: "allow" }), tier(1, { effect: "deny" })])
    const r = explainDecision(p, "view", q, false)
    expect(r.outcome).toBe(true)
    expect(r.layers).toEqual([
      { precedence: 0, roleIds: ["role-1"], ruleIds: ["r1"], verdict: "allow", decided: true },
      { precedence: 1, roleIds: ["role-1"], ruleIds: ["r1"], verdict: "deny", decided: false },
    ])
  })

  it("a silent tier still appears in the trace, distinct from an absent one", () => {
    // Tier 0 covers this resource but a DIFFERENT action, so it must show up
    // "silent" for `view` — proof it was considered, not proof it never applied.
    const p = policy([tier(0, { actions: ["edit"] }), tier(1, { effect: "deny" })])
    const r = explainDecision(p, "view", q, true)
    expect(r.outcome).toBe(false)
    expect(r.layers.map((l) => l.verdict)).toEqual(["silent", "deny"])
    expect(r.layers[0]!.decided).toBe(false)
    expect(r.layers[1]!.decided).toBe(true)
  })

  it("every tier silent falls through to the fallback, with decidedByFallback true", () => {
    const p = policy([tier(0, { actions: ["edit"] }), tier(1, { actions: ["archive"] })])
    const r = explainDecision(p, "view", q, true)
    expect(r.outcome).toBe(true)
    expect(r.decidedByFallback).toBe(true)
    expect(r.layers.every((l) => l.verdict === "silent" && !l.decided)).toBe(true)
  })

  it("deny still beats allow WITHIN one tier, reported as one deny-verdict layer", () => {
    const p = policy([tier(0, { effect: "deny" }), tier(0, { effect: "allow", id: "r2" })])
    const r = explainDecision(p, "view", q, true)
    expect(r.outcome).toBe(false)
    expect(r.layers).toHaveLength(1)
    expect(r.layers[0]).toMatchObject({ verdict: "deny", decided: true })
    expect([...r.layers[0]!.ruleIds].sort()).toEqual(["r1", "r2"])
  })

  it("two roles sharing a precedence are BOTH named — a tier is not one role", () => {
    // Per-person role ORDER isn't wired yet (P5), so every role sits at its
    // default position and two DIFFERENT roles can land in the same tier. Only
    // one of them (Admin, via `*`) actually grants `configure` here; the point is
    // that `roleIds` still names both — collapsing to one would blame whichever
    // rule happened to come first for a decision the other role had no part in.
    const p = policy([
      rule({ id: "admin-rule", roleId: "role-admin", actions: ["*"] }),
      rule({ id: "member-rule", roleId: "role-member", actions: ["edit"] }),
    ])
    const r = explainDecision(p, "configure", q, false)
    expect(r.outcome).toBe(true)
    expect(r.layers).toHaveLength(1)
    expect(new Set(r.layers[0]!.roleIds)).toEqual(new Set(["role-admin", "role-member"]))
    expect(r.layers[0]!.verdict).toBe("allow")
  })

  it("agrees with decide() on every case above it in this file", () => {
    const cases: ReadonlyArray<{
      readonly p: PolicySet
      readonly fallback: boolean
    }> = [
      { p: policy([]), fallback: true },
      { p: policy([rule({ resourceId: "c1" })]), fallback: false },
      {
        p: policy([
          tier(0, { effect: "deny", resourceType: "record", resourceId: null }),
          tier(0, { effect: "allow", resourceType: "record", resourceId: "record-1", id: "r2" }),
        ]),
        fallback: true,
      },
      { p: policy([tier(0, { effect: "allow" }), tier(1, { effect: "deny" })]), fallback: false },
      { p: policy([tier(0, { effect: "deny" }), tier(1, { effect: "allow" })]), fallback: false },
    ]
    for (const { p, fallback } of cases) {
      const resource: { readonly type: "record" | "concept"; readonly id: string } =
        p.rules[0]?.resourceType === "record" ? { type: "record", id: "record-1" } : q
      expect(explainDecision(p, "view", resource, fallback).outcome).toBe(
        decide(p, "view", resource, fallback),
      )
    }
  })
})
