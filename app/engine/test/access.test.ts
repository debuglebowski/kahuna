import { describe, expect, it } from "@effect/vitest"
import {
  ACCESS_ACTIONS,
  type AccessCondition,
  type AccessRule,
  decide,
  decideRecord,
  emptyPolicy,
  matchesCondition,
  type PolicySet,
  rulesFor,
  unrestrictedPolicy,
} from "../domain/access"
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
      rule({ id: "narrow", effect: "allow", resourceType: "record", resourceId: "item-1" }),
    ])
    expect(decide(p, "view", { type: "record", id: "item-1" }, true)).toBe(false)
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

  it("THE BLANKET-VIEW GUARD: the member preset must not grant view", () => {
    // Read access is the DEFAULT LAYER's job (the `visibility` column). A preset
    // rule granting `view` on every concept has `resource_id = null`, so it would
    // OUTRANK that column and hand members every admin-only concept — silently
    // undoing concept and field visibility.
    //
    // The engine tests would NOT catch that regression: `testLayer` provides a role
    // but no policy, so they fall through to the fallback and pass either way. Only
    // a real request resolves the blanket rule. Hence this assertion.
    for (const rule of byKey("member").rules) {
      expect(rule.actions, `member grants view on ${rule.resourceType}`).not.toContain("view")
      expect(rule.actions).not.toContain("*")
    }
  })

  it("member holds the write actions it has today, and not the two it doesn't", () => {
    const actions = new Set(byKey("member").rules.flatMap((r) => r.actions))
    expect(actions.has("create")).toBe(true)
    expect(actions.has("edit")).toBe(true)
    // Instance archive/restore is any member today.
    expect(actions.has("archive")).toBe(true)
    // Both are admin-gated at the RPC boundary today; granting either would widen.
    expect(actions.has("delete")).toBe(false)
    expect(actions.has("configure")).toBe(false)
  })

  it("owner and admin hold the wildcard, so restricted reads still work for them", () => {
    for (const key of ["owner", "admin"]) {
      const actions = new Set(byKey(key).rules.flatMap((r) => r.actions))
      expect(actions.has("*"), `${key} must hold the wildcard`).toBe(true)
    }
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
