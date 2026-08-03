import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  type AccessCondition,
  type AccessRule,
  emptyPolicy,
  matchesCondition,
  type PolicySet,
} from "../domain/access"
import { compileRecordFilter, filterFragment } from "../domain/accessSql"
import { AccessRoleService } from "../services/AccessRoleService"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { PolicyService } from "../services/PolicyService"
import type { InstanceRow } from "../services/rows"
import { newOrgId, testLayer } from "./harness"

/**
 * The SQL compiler, against a real database.
 *
 * THE POINT OF THIS FILE: `matchesCondition` (in-memory, for a single record) and
 * `compileCondition` (SQL, for a list) are two implementations of one semantics. If
 * they drift, a member sees rows in a list they cannot open — or worse, opens one
 * the list correctly hid. Every case below asserts BOTH agree on the same fixture.
 */

const ACTOR = "user-alice"
const OTHER = "user-bob"

const rule = (over: Partial<AccessRule>): AccessRule => ({
  id: over.id ?? randomUUID(),
  roleId: over.roleId ?? null,
  actorId: over.actorId ?? ACTOR,
  effect: over.effect ?? "allow",
  actions: over.actions ?? ["view"],
  resourceType: over.resourceType ?? "record",
  resourceId: over.resourceId ?? null,
  conceptId: over.conceptId ?? null,
  condition: over.condition ?? null,
})

const policyOf = (rules: ReadonlyArray<AccessRule>): PolicySet => ({
  ...emptyPolicy(ACTOR),
  rules,
})

/**
 * A concept with three records: one created by ACTOR, one owned by ACTOR via a
 * user field, one belonging to neither. `stage` separates them again by state, so
 * one fixture exercises all three condition kinds.
 */
const seed = () =>
  Effect.gen(function* () {
    const concepts = yield* ConceptService
    const fields = yield* FieldService
    const instances = yield* InstanceService
    const sql = yield* PgClient.PgClient

    const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })
    const owner = yield* fields.addField({ conceptId: concept.id, name: "Owner", kind: "text" })
    const stage = yield* fields.addField({ conceptId: concept.id, name: "Stage", kind: "text" })

    const mine = yield* instances.create({
      conceptId: concept.id,
      fields: { [stage.id]: "active" },
    })
    const ownedByMe = yield* instances.create({
      conceptId: concept.id,
      fields: { [owner.id]: ACTOR, [stage.id]: "won" },
    })
    const theirs = yield* instances.create({
      conceptId: concept.id,
      fields: { [owner.id]: OTHER, [stage.id]: "active" },
    })

    // `created_by` is set by the write path in a later phase; for now stamp the
    // lineage directly so the `actorIs` predicate has something to match.
    yield* sql`UPDATE items SET created_by = ${ACTOR} WHERE id = ${mine.itemId}`
    yield* sql`UPDATE items SET created_by = ${OTHER} WHERE id = ${ownedByMe.itemId}`

    return {
      conceptId: concept.id,
      ownerFieldId: owner.id,
      stageFieldId: stage.id,
      mine,
      ownedByMe,
      theirs,
    }
  })

/** Run a compiled filter as a real query; returns the matching item ids. */
const idsMatching = (conceptId: string, policy: PolicySet, fallback: boolean) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const filter = compileRecordFilter(sql, policy, conceptId, fallback)
    const frag = filterFragment(sql, filter)
    const rows = yield* sql<InstanceRow>`
      SELECT * FROM instances
      WHERE concept_id = ${conceptId} AND archived_at IS NULL${frag}`
    return new Set(rows.map((r) => r.item_id))
  })

/** The same decision in memory, for the drift check. */
const idsMatchingInMemory = (
  records: ReadonlyArray<{
    itemId: string
    state: Record<string, unknown>
    createdBy: string | null
  }>,
  condition: AccessCondition | null,
) => new Set(records.filter((r) => matchesCondition(condition, ACTOR, r)).map((r) => r.itemId))

describe("record filter compiles to SQL", () => {
  it.effect("an unrestricted policy and an open default do not touch the query", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const all = yield* idsMatching(f.conceptId, policyOf([]), true)
      expect(all.size).toBe(3)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a closed default with no rules yields nothing", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const none = yield* idsMatching(f.conceptId, policyOf([]), false)
      expect(none.size).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a share of one record yields exactly that record", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([rule({ resourceId: f.theirs.itemId, conceptId: f.conceptId })])
      const got = yield* idsMatching(f.conceptId, p, false)
      expect([...got]).toEqual([f.theirs.itemId])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("actorIs creator agrees with the in-memory evaluator", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const condition: AccessCondition = { kind: "actorIs", who: "creator" }
      const p = policyOf([rule({ conceptId: f.conceptId, condition })])
      const fromSql = yield* idsMatching(f.conceptId, p, false)
      const inMemory = idsMatchingInMemory(
        [
          { itemId: f.mine.itemId, state: f.mine.state, createdBy: ACTOR },
          { itemId: f.ownedByMe.itemId, state: f.ownedByMe.state, createdBy: OTHER },
          { itemId: f.theirs.itemId, state: f.theirs.state, createdBy: null },
        ],
        condition,
      )
      expect(fromSql).toEqual(inMemory)
      expect([...fromSql]).toEqual([f.mine.itemId])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("fieldIs agrees with the in-memory evaluator, scalar and array", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const condition: AccessCondition = { kind: "fieldIs", fieldId: f.ownerFieldId }
      const p = policyOf([rule({ conceptId: f.conceptId, condition })])
      const fromSql = yield* idsMatching(f.conceptId, p, false)
      const records = [
        { itemId: f.mine.itemId, state: f.mine.state, createdBy: null },
        { itemId: f.ownedByMe.itemId, state: f.ownedByMe.state, createdBy: null },
        { itemId: f.theirs.itemId, state: f.theirs.state, createdBy: null },
      ]
      expect(fromSql).toEqual(idsMatchingInMemory(records, condition))
      expect([...fromSql]).toEqual([f.ownedByMe.itemId])

      // The array shape — a `multiple` user field storing several ids. Written
      // straight to state so the predicate's `@>` branch is exercised.
      const sql = yield* PgClient.PgClient
      yield* sql`UPDATE instances SET state = jsonb_set(state, ${[f.ownerFieldId]}, ${JSON.stringify([OTHER, ACTOR])}::jsonb)
                 WHERE id = ${f.theirs.id}`
      const afterArray = yield* idsMatching(f.conceptId, p, false)
      expect(afterArray.has(f.theirs.itemId)).toBe(true)
      expect(
        matchesCondition(condition, ACTOR, {
          state: { [f.ownerFieldId]: [OTHER, ACTOR] },
          createdBy: null,
        }),
      ).toBe(true)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("where agrees with the in-memory evaluator", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const condition: AccessCondition = { kind: "where", state: { [f.stageFieldId]: "active" } }
      const p = policyOf([rule({ conceptId: f.conceptId, condition })])
      const fromSql = yield* idsMatching(f.conceptId, p, false)
      const records = [
        { itemId: f.mine.itemId, state: f.mine.state, createdBy: null },
        { itemId: f.ownedByMe.itemId, state: f.ownedByMe.state, createdBy: null },
        { itemId: f.theirs.itemId, state: f.theirs.state, createdBy: null },
      ]
      expect(fromSql).toEqual(idsMatchingInMemory(records, condition))
      expect(fromSql.size).toBe(2)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("THE DENY GUARD in SQL: a deny subtracts even from an open default", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([
        rule({ effect: "deny", resourceId: f.theirs.itemId, conceptId: f.conceptId }),
      ])
      const got = yield* idsMatching(f.conceptId, p, true)
      expect(got.size).toBe(2)
      expect(got.has(f.theirs.itemId)).toBe(false)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a narrow allow cannot beat a blanket deny", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([
        rule({ effect: "deny", conceptId: f.conceptId }),
        rule({ effect: "allow", resourceId: f.mine.itemId, conceptId: f.conceptId }),
      ])
      const got = yield* idsMatching(f.conceptId, p, true)
      expect(got.size).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("empty all / empty any compile to the same polarity they evaluate to", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const openAll = yield* idsMatching(
        f.conceptId,
        policyOf([rule({ conceptId: f.conceptId, condition: { kind: "all", of: [] } })]),
        false,
      )
      expect(openAll.size).toBe(3) // AND of nothing is TRUE
      const closedAny = yield* idsMatching(
        f.conceptId,
        policyOf([rule({ conceptId: f.conceptId, condition: { kind: "any", of: [] } })]),
        false,
      )
      expect(closedAny.size).toBe(0) // OR of nothing is FALSE
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("policy loading", () => {
  /** One org id shared by the layer and the assertions inside this test. */
  const org = newOrgId()

  it.effect("THE CACHE GUARD: a rule write bumps the generation and is seen at once", () =>
    Effect.gen(function* () {
      // Memoization is keyed on the generation, so an edit must land on the very
      // next resolve — no TTL, no manual flush. If someone "optimises" the version
      // read away, this fails.
      const policies = yield* PolicyService
      const roles = yield* AccessRoleService
      const before = yield* policies.resolve(org, ACTOR)
      expect(before.rules.length).toBe(0)

      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")
      expect(member).not.toBeNull()
      yield* roles.assign(member!.id, ACTOR)

      const after = yield* policies.resolve(org, ACTOR)
      expect(after.version).toBeGreaterThan(before.version)
      expect(after.rules.length).toBeGreaterThan(0)
      // The seeded Member role reproduces today's behaviour: everything except
      // configure (admin-gated) and delete (already admin-only at the RPC tier).
      const actions = new Set(after.rules.flatMap((r) => r.actions))
      expect(actions.has("view")).toBe(true)
      expect(actions.has("edit")).toBe(true)
      expect(actions.has("archive")).toBe(true)
      expect(actions.has("configure")).toBe(false)
      expect(actions.has("delete")).toBe(false)
    }).pipe(Effect.provide(testLayer(org))),
  )

  it.effect("ensureBuiltins is idempotent — a second run seeds nothing", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const first = yield* roles.ensureBuiltins
      expect(first).toBe(4)
      const second = yield* roles.ensureBuiltins
      expect(second).toBe(0)
      expect((yield* roles.list()).length).toBe(4)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
