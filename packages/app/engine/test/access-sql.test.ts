import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  type AccessCondition,
  type AccessRule,
  decideRecord,
  emptyPolicy,
  matchesCondition,
  type PolicySet,
} from "../domain/access"
import { compileRecordFilter, filterFragment } from "../domain/accessSql"
import { AccessRoleService } from "../services/AccessRoleService"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { OrgContext } from "../services/OrgContext"
import { PolicyService } from "../services/PolicyService"
import { QueryService } from "../services/QueryService"
import { RecordService } from "../services/RecordService"
import type { RecordVersionRow } from "../services/rows"
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
  // Spread, not defaulted — most callers want it ABSENT (tier 0 via `tiersOf`'s
  // own default), and a bare `?? 0` here would make that indistinguishable from a
  // rule that explicitly asked for tier 0.
  ...(over.precedence !== undefined ? { precedence: over.precedence } : {}),
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
    const recordVersions = yield* RecordService
    const sql = yield* PgClient.PgClient

    const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })
    const owner = yield* fields.addField({ conceptId: concept.id, name: "Owner", kind: "text" })
    const stage = yield* fields.addField({ conceptId: concept.id, name: "Stage", kind: "text" })

    const mine = yield* recordVersions.create({
      conceptId: concept.id,
      fields: { [stage.id]: "active" },
    })
    const ownedByMe = yield* recordVersions.create({
      conceptId: concept.id,
      fields: { [owner.id]: ACTOR, [stage.id]: "won" },
    })
    const theirs = yield* recordVersions.create({
      conceptId: concept.id,
      fields: { [owner.id]: OTHER, [stage.id]: "active" },
    })

    // `created_by` is set by the write path in a later phase; for now stamp the
    // lineage directly so the `actorIs` predicate has something to match.
    yield* sql`UPDATE records SET created_by = ${ACTOR} WHERE id = ${mine.recordId}`
    yield* sql`UPDATE records SET created_by = ${OTHER} WHERE id = ${ownedByMe.recordId}`

    return {
      conceptId: concept.id,
      ownerFieldId: owner.id,
      stageFieldId: stage.id,
      mine,
      ownedByMe,
      theirs,
    }
  })

/** Run a compiled filter as a real query; returns the matching record ids. */
const idsMatching = (conceptId: string, policy: PolicySet, fallback: boolean) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const filter = compileRecordFilter(sql, policy, conceptId, fallback)
    const frag = filterFragment(sql, filter)
    const rows = yield* sql<RecordVersionRow>`
      SELECT * FROM record_versions
      WHERE concept_id = ${conceptId} AND archived_at IS NULL${frag}`
    return new Set(rows.map((r) => r.record_id))
  })

/** The same decision in memory, for the drift check. */
const idsMatchingInMemory = (
  records: ReadonlyArray<{
    recordId: string
    state: Record<string, unknown>
    createdBy: string | null
  }>,
  condition: AccessCondition | null,
) => new Set(records.filter((r) => matchesCondition(condition, ACTOR, r)).map((r) => r.recordId))

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
      const p = policyOf([rule({ resourceId: f.theirs.recordId, conceptId: f.conceptId })])
      const got = yield* idsMatching(f.conceptId, p, false)
      expect([...got]).toEqual([f.theirs.recordId])
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
          { recordId: f.mine.recordId, state: f.mine.state, createdBy: ACTOR },
          { recordId: f.ownedByMe.recordId, state: f.ownedByMe.state, createdBy: OTHER },
          { recordId: f.theirs.recordId, state: f.theirs.state, createdBy: null },
        ],
        condition,
      )
      expect(fromSql).toEqual(inMemory)
      expect([...fromSql]).toEqual([f.mine.recordId])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("fieldIs agrees with the in-memory evaluator, scalar and array", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const condition: AccessCondition = { kind: "fieldIs", fieldId: f.ownerFieldId }
      const p = policyOf([rule({ conceptId: f.conceptId, condition })])
      const fromSql = yield* idsMatching(f.conceptId, p, false)
      const records = [
        { recordId: f.mine.recordId, state: f.mine.state, createdBy: null },
        { recordId: f.ownedByMe.recordId, state: f.ownedByMe.state, createdBy: null },
        { recordId: f.theirs.recordId, state: f.theirs.state, createdBy: null },
      ]
      expect(fromSql).toEqual(idsMatchingInMemory(records, condition))
      expect([...fromSql]).toEqual([f.ownedByMe.recordId])

      // The array shape — a `multiple` user field storing several ids. Written
      // straight to state so the predicate's `@>` branch is exercised.
      const sql = yield* PgClient.PgClient
      yield* sql`UPDATE record_versions SET state = jsonb_set(state, ${[f.ownerFieldId]}, ${JSON.stringify([OTHER, ACTOR])}::jsonb)
                 WHERE id = ${f.theirs.id}`
      const afterArray = yield* idsMatching(f.conceptId, p, false)
      expect(afterArray.has(f.theirs.recordId)).toBe(true)
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
        { recordId: f.mine.recordId, state: f.mine.state, createdBy: null },
        { recordId: f.ownedByMe.recordId, state: f.ownedByMe.state, createdBy: null },
        { recordId: f.theirs.recordId, state: f.theirs.state, createdBy: null },
      ]
      expect(fromSql).toEqual(idsMatchingInMemory(records, condition))
      expect(fromSql.size).toBe(2)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("THE DENY GUARD in SQL: a deny subtracts even from an open default", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([
        rule({ effect: "deny", resourceId: f.theirs.recordId, conceptId: f.conceptId }),
      ])
      const got = yield* idsMatching(f.conceptId, p, true)
      expect(got.size).toBe(2)
      expect(got.has(f.theirs.recordId)).toBe(false)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a narrow allow cannot beat a blanket deny", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([
        rule({ effect: "deny", conceptId: f.conceptId }),
        rule({ effect: "allow", resourceId: f.mine.recordId, conceptId: f.conceptId }),
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
      // The seeded Member role grants only what's actually decided somewhere —
      // see `AccessRoleService.BUILTIN_ROLES`'s header. `task` gets an explicit
      // `view` (decided directly); `concept`'s blanket rule does NOT — reading an
      // EXISTING concept comes from the separate per-resource rule materialized
      // at creation time (none was created here), not from this blanket row.
      const actions = new Set(after.rules.flatMap((r) => r.actions))
      const taskActions = new Set(
        after.rules.filter((r) => r.resourceType === "task").flatMap((r) => r.actions),
      )
      const conceptActions = new Set(
        after.rules.filter((r) => r.resourceType === "concept").flatMap((r) => r.actions),
      )
      expect(taskActions.has("view")).toBe(true)
      expect(conceptActions.has("view")).toBe(false)
      expect(actions.has("create")).toBe(true)
      expect(actions.has("edit")).toBe(true)
      // No type grants `archive` any more — the one case that did (concept-schema
      // archive/restore) moved to admin-only for consistency with every other
      // concept-schema action.
      expect(actions.has("archive")).toBe(false)
      expect(actions.has("configure")).toBe(false)
      expect(actions.has("delete")).toBe(false)
    }).pipe(Effect.provide(testLayer(org))),
  )

  /**
   * THE SCOPE-COLUMN GUARD.
   *
   * The Records grid's rows are CONCEPTS — a cell there means "records in this
   * concept", stored as `concept_id`. The Concepts grid writes `resource_id` for the
   * same uuid. They are different grants, so each grid must own exactly one column:
   * if `setScopedRules` wrote (or deleted) the wrong one, saving one grid would
   * silently wipe the other's rules for the same concept.
   */
  it.effect("scopeBy keeps the concept-scoped and resource-scoped grids apart", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const role = yield* roles.create({ name: "Grid" })
      const conceptId = randomUUID()

      yield* roles.setScopedRules({
        roleId: role.id,
        resourceType: "record",
        scopeBy: "concept",
        entries: [{ resourceId: conceptId, allow: ["view"], deny: [] }],
      })
      yield* roles.setScopedRules({
        roleId: role.id,
        resourceType: "concept",
        entries: [{ resourceId: conceptId, allow: ["view"], deny: [] }],
      })

      const rules = yield* roles.rulesOf(role.id)
      const recordRule = rules.find((r) => r.resourceType === "record")
      const conceptRule = rules.find((r) => r.resourceType === "concept")
      // Both survived: the concept write did not delete the record-scoped row.
      expect(recordRule).toBeDefined()
      expect(conceptRule).toBeDefined()
      // …and each landed in its own column.
      expect(recordRule!.conceptId).toBe(conceptId)
      expect(recordRule!.resourceId).toBeNull()
      expect(conceptRule!.resourceId).toBe(conceptId)
      expect(conceptRule!.conceptId).toBeNull()

      // Clearing one grid clears only its own column.
      yield* roles.setScopedRules({ roleId: role.id, resourceType: "concept", entries: [] })
      const left = yield* roles.rulesOf(role.id)
      expect(left.filter((r) => r.resourceType === "concept").length).toBe(0)
      expect(left.filter((r) => r.resourceType === "record").length).toBe(1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  /**
   * ── THE BLANKET GUARD ──────────────────────────────────────────────────────
   *
   * Successor to THE BLANKET-VIEW GUARD, which asserted the Member preset grants no
   * blanket `view`. That test protected a property worth keeping — read access is
   * never granted wholesale by accident — but its subject is gone: read access IS
   * rules now, so a blanket allow no longer "outranks the visibility column". What it
   * does instead is grant every present AND FUTURE resource of its type, invisibly,
   * in a way no grid cell can show. So it is refused at the write, not caught by a
   * test on one preset.
   */
  it.effect("an untargeted allow is refused on a type with per-resource values", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const role = yield* roles.create({ name: "Sales" })

      for (const resourceType of [
        "concept",
        "record",
        "dashboard",
        "view",
        "automation",
      ] as const) {
        const err = yield* roles
          .addRule({ roleId: role.id, effect: "allow", actions: ["view"], resourceType })
          .pipe(Effect.flip)
        expect(err._tag, resourceType).toBe("BlanketRuleRefused")
      }

      // Naming ONE resource is fine — that is the whole point.
      const ok = yield* roles.addRule({
        roleId: role.id,
        effect: "allow",
        actions: ["view"],
        resourceType: "concept",
        resourceId: randomUUID(),
      })
      expect(ok).toBeTruthy()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a blanket DENY is still allowed — a hard block is legible", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const role = yield* roles.create({ name: "Contractor" })
      const id = yield* roles.addRule({
        roleId: role.id,
        effect: "deny",
        actions: ["view"],
        resourceType: "concept",
      })
      expect(id).toBeTruthy()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  /**
   * THE WILDCARD EXEMPTION. Owner/Admin hold `*`, which means "every action, present
   * and future". They are `full_access` and are therefore the one kind of role a
   * blanket allow is correct for — and materialization skips them, so the wildcard is
   * never expanded into a frozen list of today's actions.
   */
  it.effect("a full-access role keeps its wildcard and may still hold a blanket rule", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      yield* roles.ensureBuiltins
      const admin = yield* roles.getByKey("admin")
      const before = (yield* roles.rulesOf(admin!.id)).filter((r) => r.resourceType === "concept")
      expect(before.some((r) => r.actions.includes("*"))).toBe(true)

      // Exempt from the guard: a blanket allow is exactly what full access IS.
      const id = yield* roles.addRule({
        roleId: admin!.id,
        effect: "allow",
        actions: ["view"],
        resourceType: "concept",
      })
      expect(id).toBeTruthy()

      const after = (yield* roles.rulesOf(admin!.id)).filter((r) => r.resourceType === "concept")
      expect(after.some((r) => r.actions.includes("*"))).toBe(true)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("ensureBuiltins is idempotent — a second run seeds nothing", () =>
    Effect.gen(function* () {
      const roles = yield* AccessRoleService
      // Three: Admin, Member, and the automation role. There is deliberately no
      // Owner — that is a membership flag with a bypass, not a role.
      const first = yield* roles.ensureBuiltins
      expect(first).toBe(3)
      const second = yield* roles.ensureBuiltins
      expect(second).toBe(0)
      expect((yield* roles.list()).length).toBe(3)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

/**
 * ── THE LIST/DETAIL AGREEMENT ────────────────────────────────────────────────
 *
 * The whole point of record-level access: "you see only the rows shared with you".
 *
 * Two halves have to agree — `QueryService` compiles rules into SQL for lists,
 * `RecordService.assertRecordReadable` decides by id. A disagreement means a member
 * opens a record their list hid, or sees a row they cannot open. These tests assert
 * BOTH for the same fixtures, which is why they live together.
 */
describe("record-level access, end to end", () => {
  const SHAREE = "user-carol"

  /** A share of one record: the rule shape the Share dialog will write. */
  const shareOf = (recordId: string, conceptId: string): PolicySet => ({
    ...emptyPolicy(SHAREE),
    rules: [
      {
        id: randomUUID(),
        roleId: null,
        actorId: SHAREE,
        effect: "allow",
        actions: ["view"],
        resourceType: "record",
        resourceId: recordId,
        conceptId,
        condition: null,
      },
    ],
  })

  it.effect("a restricted concept + one share = exactly that record, and it opens", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const concepts = yield* ConceptService
      // 'admin' default: a member sees no records of this concept at all…
      yield* concepts.setVisibility(f.conceptId, "admin")
      const policy = shareOf(f.theirs.recordId, f.conceptId)

      // …except the one shared with them. THE LIST half.
      const listed = yield* Effect.provideService(
        Effect.flatMap(QueryService, (q) => q.findRecords({ conceptId: f.conceptId })),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(listed.map((r) => r.recordId)).toEqual([f.theirs.recordId])

      // THE BY-ID half must agree — same record readable…
      const opened = yield* Effect.provideService(
        Effect.flatMap(RecordService, (i) => i.get(f.theirs.id)),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(opened.recordId).toBe(f.theirs.recordId)

      // …and a NON-shared record of the same concept must NOT open. This is the
      // failure a naive `fallback = true` would introduce: the list is right while
      // every record opens by id.
      const other = yield* Effect.provideService(
        Effect.flatMap(RecordService, (i) => i.get(f.mine.id)).pipe(
          Effect.map(() => "opened"),
          Effect.catchTag("RecordVersionNotFound", () => Effect.succeed("not-found")),
        ),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(other).toBe("not-found")
    }).pipe(Effect.provide(testLayer(ORG))),
  )

  it.effect("THE COUNT GUARD: the limit bounds VISIBLE rows, not fetched rows", () =>
    Effect.gen(function* () {
      // Why the filter must be in the SQL. With a post-fetch filter, `limit: 2` would
      // fetch the 2 newest rows and then drop the ones the caller can't see — so a
      // caller entitled to 3 records would get 0-2 of them depending on ordering.
      const f = yield* seed()
      const concepts = yield* ConceptService
      yield* concepts.setVisibility(f.conceptId, "admin")
      const policy: PolicySet = {
        ...emptyPolicy(SHAREE),
        rules: [f.mine, f.ownedByMe, f.theirs].map((r) => ({
          id: randomUUID(),
          roleId: null,
          actorId: SHAREE,
          effect: "allow" as const,
          actions: ["view" as const],
          resourceType: "record" as const,
          resourceId: r.recordId,
          conceptId: f.conceptId,
          condition: null,
        })),
      }
      const all = yield* Effect.provideService(
        Effect.flatMap(QueryService, (q) => q.findRecords({ conceptId: f.conceptId })),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(all.length).toBe(3)
      // A limit of 2 must return 2 VISIBLE rows — not 2 fetched then filtered.
      const limited = yield* Effect.provideService(
        Effect.flatMap(QueryService, (q) => q.findRecords({ conceptId: f.conceptId, limit: 2 })),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(limited.length).toBe(2)
    }).pipe(Effect.provide(testLayer(ORG))),
  )

  it.effect("a share survives publishing a new version (rules key on the lineage)", () =>
    Effect.gen(function* () {
      // Why record rules key on records.id, never recordVersions.id: a versioned concept has
      // N version rows per record, and a new version must not silently revoke a share.
      const f = yield* seed()
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      yield* concepts.update({ id: f.conceptId, description: null, versioningEnabled: true })
      yield* concepts.setVisibility(f.conceptId, "admin")
      const policy = shareOf(f.theirs.recordId, f.conceptId)

      const before = yield* Effect.provideService(
        Effect.flatMap(QueryService, (q) => q.findRecords({ conceptId: f.conceptId })),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(before.map((r) => r.recordId)).toEqual([f.theirs.recordId])

      // Publish a fresh version of the shared record, as the owner.
      const draft = yield* recordVersions.newVersion({ recordId: f.theirs.recordId })
      yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })

      const after = yield* Effect.provideService(
        Effect.flatMap(QueryService, (q) => q.findRecords({ conceptId: f.conceptId })),
        OrgContext,
        { orgId: ORG, actor: SHAREE, role: "member", policy },
      )
      expect(after.map((r) => r.recordId)).toEqual([f.theirs.recordId])
      // …and it is the NEW head, not the superseded row.
      expect(after[0]!.versionSeq).toBeGreaterThan(1)
    }).pipe(Effect.provide(testLayer(ORG))),
  )
})

/**
 * ── THE CASCADE, COMPILED ─────────────────────────────────────────────────────
 *
 * `compileRecordFilter`'s multi-tier path (`compileTierVerdict` + `COALESCE`) has
 * no other test coverage, because nothing before this phase could ever produce
 * more than one tier — every fixture in the rest of this file, and every real
 * policy until a role is ordered or based on another, collapses to the single-tier
 * fast path (`compileTier`, unchanged since before the cascade). These are the
 * only tests that actually walk the COALESCE fold, against a real query.
 */
describe("record filter — multiple tiers (the new path)", () => {
  it.effect("a lower tier's targeted allow beats a higher tier's blanket deny", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([
        rule({ conceptId: f.conceptId, resourceId: f.theirs.recordId, precedence: 0 }),
        rule({ conceptId: f.conceptId, effect: "deny", precedence: 1 }),
      ])
      // Tier 0 has nothing to say about `mine`/`ownedByMe` (its rule names only
      // `theirs`), so they fall through to tier 1's blanket deny. `theirs` is
      // decided outright by tier 0 — tier 1 is never reached for that row.
      const got = yield* idsMatching(f.conceptId, p, false)
      expect([...got]).toEqual([f.theirs.recordId])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a higher tier's blanket allow only reaches rows the lower tier is silent on", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      const p = policyOf([
        rule({
          conceptId: f.conceptId,
          effect: "deny",
          resourceId: f.theirs.recordId,
          precedence: 0,
        }),
        rule({ conceptId: f.conceptId, precedence: 1 }),
      ])
      // Tier 0 decides `theirs` outright (deny) — tier 1's blanket allow never
      // reaches it. Everything else is silent in tier 0, so tier 1 grants it.
      const got = yield* idsMatching(f.conceptId, p, false)
      expect(got.has(f.theirs.recordId)).toBe(false)
      expect(got.has(f.mine.recordId)).toBe(true)
      expect(got.has(f.ownedByMe.recordId)).toBe(true)
      expect(got.size).toBe(2)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("SQL and the in-memory decideRecord agree on a three-tier policy", () =>
    Effect.gen(function* () {
      const f = yield* seed()
      // Tier 0 targets `mine` only (allow). Tier 1 is a conditional deny (owner
      // field = OTHER) that would otherwise catch `ownedByMe`. Tier 2 is a blanket
      // allow, the catch-all everything else falls into.
      const p = policyOf([
        rule({ conceptId: f.conceptId, resourceId: f.mine.recordId, precedence: 0 }),
        rule({
          conceptId: f.conceptId,
          effect: "deny",
          condition: { kind: "fieldIs", fieldId: f.ownerFieldId },
          precedence: 1,
        }),
        rule({ conceptId: f.conceptId, precedence: 2 }),
      ])
      const records = [
        { recordId: f.mine.recordId, state: f.mine.state, createdBy: ACTOR },
        { recordId: f.ownedByMe.recordId, state: f.ownedByMe.state, createdBy: OTHER },
        { recordId: f.theirs.recordId, state: f.theirs.state, createdBy: null },
      ]
      // `decideRecord`'s condition check is keyed to ACTOR (the policy's own
      // actorId) — `fieldIs` matches when ACTOR is named in that field.
      //
      // `conceptId` on the resource is REQUIRED here, unlike `compileRecordFilter`
      // (which takes the concept id as its own parameter and matches concept-scoped
      // rules directly): `decideRecord` goes through `rulesFor`/`coversResource`,
      // which only matches R1/R2 (both `resourceId: null, conceptId: f.conceptId`)
      // by comparing `rule.conceptId` against `resource.conceptId` — omit it and
      // both rules silently stop matching anything.
      const inMemory = new Set(
        records
          .filter((r) =>
            decideRecord(
              p,
              "view",
              { type: "record", id: r.recordId, conceptId: f.conceptId },
              false,
              r,
            ),
          )
          .map((r) => r.recordId),
      )
      const fromSql = yield* idsMatching(f.conceptId, p, false)
      expect(fromSql).toEqual(inMemory)
      // Spelled out, so a change to either side fails loudly rather than the two
      // drifting together: `mine` by tier 0, `theirs` by tier 2 (tier 1 is silent
      // for it — its owner field is unset, not ACTOR), `ownedByMe` excluded by
      // tier 1's deny before tier 2 is ever reached.
      expect([...fromSql].sort()).toEqual([f.mine.recordId, f.theirs.recordId].sort())
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

/** One org for the end-to-end block; the seed helper writes into whatever layer runs. */
const ORG = newOrgId()
