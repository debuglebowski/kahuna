import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type AccessRule, emptyPolicy, type PolicySet, unrestrictedPolicy } from "../domain/access"
import { canReadConcept } from "../domain/visibility"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import type { OrgContext } from "../services/OrgContext"
import { QueryService } from "../services/QueryService"
import { RecordService } from "../services/RecordService"
import { RelationService } from "../services/RelationService"
import { newOrgId, ordinaryMember, testLayer } from "./harness"

/**
 * Concept-level READ visibility. `visibility: "admin"` must make a concept read as
 * if it does not exist for a member — never as a distinct "forbidden", which would
 * confirm it exists.
 *
 * Each case runs the SAME org through two layers with different roles, which is the
 * only way to prove the gate keys off the caller rather than the data.
 */
/** Seed a restricted concept with one record; returns the ids a reader would use. */
const seedRestricted = () =>
  Effect.gen(function* () {
    const concepts = yield* ConceptService
    const fields = yield* FieldService
    const recordVersions = yield* RecordService
    const concept = yield* concepts.create({ name: `Secret ${randomUUID().slice(0, 6)}` })
    const field = yield* fields.addField({ conceptId: concept.id, name: "Amount", kind: "text" })
    const inst = yield* recordVersions.create({
      conceptId: concept.id,
      fields: { [field.id]: "9000" },
    })
    yield* concepts.setVisibility(concept.id, "admin")
    return { conceptId: concept.id, slug: concept.slug, recordVersion: inst, fieldId: field.id }
  })

describe("concept read visibility", () => {
  it("canReadConcept: the OLD tier answer, kept only for the migration proof", () => {
    expect(canReadConcept("visible", "member")).toBe(true)
    expect(canReadConcept("admin", "member")).toBe(false)
    expect(canReadConcept("admin", "owner")).toBe(true)
  })

  it("a member cannot list, read, search or version-list a restricted concept", async () => {
    const orgId = newOrgId()
    const seeded = await Effect.runPromise(
      seedRestricted().pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    // ── as a MEMBER ──────────────────────────────────────────────────────────
    const asMember = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const query = yield* QueryService
        const recordVersions = yield* RecordService
        const listed = yield* concepts.list()
        const byId = yield* Effect.either(concepts.getByIdForRead(seeded.conceptId))
        const bySlug = yield* Effect.either(concepts.getBySlug(seeded.slug))
        const rows = yield* Effect.either(query.findRecords({ conceptId: seeded.conceptId }))
        const one = yield* Effect.either(recordVersions.get(seeded.recordVersion.id))
        const record = yield* Effect.either(recordVersions.getRecord(seeded.recordVersion.recordId))
        const versions = yield* Effect.either(
          recordVersions.listVersions(seeded.recordVersion.recordId),
        )
        const single = yield* Effect.either(recordVersions.singleRecordOf(seeded.conceptId))
        return { listed, byId, bySlug, rows, one, record, versions, single }
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
    )

    expect(asMember.listed.map((c) => c.id)).not.toContain(seeded.conceptId)
    // Every by-id read fails, and as NotFound — not a distinguishable 403.
    expect(asMember.byId._tag).toBe("Left")
    if (asMember.byId._tag === "Left")
      expect((asMember.byId.left as { _tag: string })._tag).toBe("ConceptNotFound")
    expect(asMember.bySlug._tag).toBe("Left")
    expect(asMember.rows._tag).toBe("Left")
    expect(asMember.one._tag).toBe("Left")
    if (asMember.one._tag === "Left")
      expect((asMember.one.left as { _tag: string })._tag).toBe("RecordVersionNotFound")
    expect(asMember.record._tag).toBe("Left")
    expect(asMember.versions._tag).toBe("Left")
    expect(asMember.single._tag).toBe("Left")

    // ── as an ADMIN, the same reads all succeed ──────────────────────────────
    const asAdmin = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const query = yield* QueryService
        const recordVersions = yield* RecordService
        return {
          listed: (yield* concepts.list()).map((c) => c.id),
          byId: (yield* concepts.getByIdForRead(seeded.conceptId)).id,
          rows: (yield* query.findRecords({ conceptId: seeded.conceptId })).length,
          value: (yield* recordVersions.get(seeded.recordVersion.id)).state[seeded.fieldId],
          versions: (yield* recordVersions.listVersions(seeded.recordVersion.recordId)).length,
        }
      }).pipe(
        Effect.provide(testLayer(orgId, "admin-user", "member", unrestrictedPolicy("admin-user"))),
      ),
    )
    expect(asAdmin.listed).toContain(seeded.conceptId)
    expect(asAdmin.byId).toBe(seeded.conceptId)
    expect(asAdmin.rows).toBe(1)
    expect(asAdmin.value).toBe("9000")
    expect(asAdmin.versions).toBe(1)
  })

  it("a visible concept is unaffected for a member", async () => {
    const orgId = newOrgId()
    const open = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const recordVersions = yield* RecordService
        const c = yield* concepts.create({ name: `Open ${randomUUID().slice(0, 6)}` })
        const f = yield* fields.addField({ conceptId: c.id, name: "Note", kind: "text" })
        const i = yield* recordVersions.create({ conceptId: c.id, fields: { [f.id]: "hello" } })
        return { conceptId: c.id, recordVersionId: i.id, fieldId: f.id }
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const query = yield* QueryService
        const recordVersions = yield* RecordService
        return {
          listed: (yield* concepts.list()).map((c) => c.id),
          rows: (yield* query.findRecords({ conceptId: open.conceptId })).length,
          value: (yield* recordVersions.get(open.recordVersionId)).state[open.fieldId],
          visibility: (yield* concepts.getByIdForRead(open.conceptId)).visibility,
        }
      }).pipe(
        Effect.provide(testLayer(orgId, "member-user", "member", ordinaryMember("member-user"))),
      ),
    )
    expect(seen.listed).toContain(open.conceptId)
    expect(seen.rows).toBe(1)
    expect(seen.value).toBe("hello")
    expect(seen.visibility).toBe("visible")
  })

  it("a member cannot create a relation INTO a restricted concept", async () => {
    const orgId = newOrgId()
    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const recordVersions = yield* RecordService
        const secret = yield* concepts.create({ name: `Vault ${randomUUID().slice(0, 6)}` })
        const secretRec = yield* recordVersions.create({ conceptId: secret.id, fields: {} })
        const open = yield* concepts.create({ name: `Doc ${randomUUID().slice(0, 6)}` })
        const link = yield* fields.addField({
          conceptId: open.id,
          name: "Vault",
          kind: "relation",
          config: { target: secret.id },
        })
        const openRec = yield* recordVersions.create({ conceptId: open.id, fields: {} })
        yield* concepts.setVisibility(secret.id, "admin")
        return { fieldId: link.id, fromId: openRec.id, toRecordId: secretRec.recordId }
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const relations = yield* RelationService
        return yield* Effect.either(
          relations.create({
            fieldId: setup.fieldId,
            fromId: setup.fromId,
            toRecordId: setup.toRecordId,
          }),
        )
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
    )
    expect(denied._tag).toBe("Left")

    // An admin may still link it, so this is the read gate and not a broken field.
    const allowed = await Effect.runPromise(
      Effect.gen(function* () {
        const relations = yield* RelationService
        return yield* relations.create({
          fieldId: setup.fieldId,
          fromId: setup.fromId,
          toRecordId: setup.toRecordId,
        })
      }).pipe(
        Effect.provide(testLayer(orgId, "admin-user", "member", unrestrictedPolicy("admin-user"))),
      ),
    )
    expect(allowed.id).toBeTruthy()
  })

  it("an unknown visibility value in the DB fails CLOSED", async () => {
    // The opposite polarity to `editReach`, so it is worth pinning: an older server
    // meeting a future value must restrict, not publish.
    const orgId = newOrgId()
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        return yield* concepts.create({ name: `Future ${randomUUID().slice(0, 6)}` })
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )
    const { PgClient } = await import("@effect/sql-pg")
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE concepts SET visibility = 'team:eng' WHERE id = ${created.id}`
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )
    const asMember = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        return {
          listed: (yield* concepts.list()).map((c) => c.id),
          byId: yield* Effect.either(concepts.getByIdForRead(created.id)),
        }
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
    )
    expect(asMember.listed).not.toContain(created.id)
    expect(asMember.byId._tag).toBe("Left")
  })
})

/**
 * ── RULES OVER DEFAULTS ──────────────────────────────────────────────────────
 *
 * The tests above assert the DEFAULT layer (the `visibility` column) in isolation:
 * they pass no policy, so they still describe the pre-access-model behaviour exactly.
 *
 * These assert the layer ON TOP — that a rule can open a restricted concept and
 * close a visible one. Without them, P2 could have swapped every gate to `decide()`
 * while the rules branch never actually ran.
 */
describe("access rules over the visibility default", () => {
  const BASE: AccessRule = {
    id: "r1",
    roleId: null,
    actorId: "tester",
    effect: "allow",
    actions: ["view"],
    resourceType: "concept",
    resourceId: null,
    conceptId: null,
    condition: null,
  }
  const policyWith = (over: Partial<AccessRule>): PolicySet => ({
    ...emptyPolicy("tester"),
    rules: [{ ...BASE, ...over }],
  })
  const readOutcome = (conceptId: string, layer: ReturnType<typeof testLayer>) =>
    Effect.runPromise(
      Effect.flatMap(ConceptService, (c) => c.getByIdForRead(conceptId)).pipe(
        Effect.provide(layer),
        Effect.map(() => "read"),
        Effect.catchTag("ConceptNotFound", () => Effect.succeed("not-found")),
      ),
    )
  const listIds = (layer: ReturnType<typeof testLayer>) =>
    Effect.runPromise(
      Effect.flatMap(ConceptService, (c) => c.list()).pipe(
        Effect.map((cs) => cs.map((c) => c.id)),
        Effect.provide(layer),
      ),
    )

  it("an allow rule opens ONE restricted concept, and only that one", async () => {
    const orgId = newOrgId()
    const seeded = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const open = yield* concepts.create({ name: `Open ${randomUUID().slice(0, 6)}` })
        const shut = yield* concepts.create({ name: `Shut ${randomUUID().slice(0, 6)}` })
        yield* concepts.setVisibility(open.id, "admin")
        yield* concepts.setVisibility(shut.id, "admin")
        return { open: open.id, shut: shut.id }
      }).pipe(Effect.provide(testLayer(orgId))),
    )

    // A member with no rules sees neither — the default.
    const bare = await listIds(testLayer(orgId, "tester", "member"))
    expect(bare).not.toContain(seeded.open)
    expect(bare).not.toContain(seeded.shut)

    // With a rule naming ONE of them, the list widens by exactly one entry.
    const layer = testLayer(orgId, "tester", "member", policyWith({ resourceId: seeded.open }))
    const listed = await listIds(layer)
    expect(listed).toContain(seeded.open)
    expect(listed).not.toContain(seeded.shut)

    // The by-id read must AGREE with the list: a mismatch means a member sees an
    // entry they cannot open, or can open one the list hid.
    expect(await readOutcome(seeded.open, layer)).toBe("read")
    expect(await readOutcome(seeded.shut, layer)).toBe("not-found")
  })

  it("a deny rule closes a VISIBLE concept, even for an owner", async () => {
    // Deny wins over both the default AND privilege. If this fails, "deny always
    // wins" is only true on paper.
    const orgId = newOrgId()
    const conceptId = await Effect.runPromise(
      Effect.flatMap(ConceptService, (c) =>
        c.create({ name: `Public ${randomUUID().slice(0, 6)}` }),
      ).pipe(
        Effect.map((c) => c.id),
        Effect.provide(testLayer(orgId)),
      ),
    )
    const layer = testLayer(
      orgId,
      "tester",
      "owner",
      policyWith({ effect: "deny", resourceId: conceptId }),
    )
    expect(await listIds(layer)).not.toContain(conceptId)
    expect(await readOutcome(conceptId, layer)).toBe("not-found")
  })

  it("'none' is readable by nobody by default — not even an owner", async () => {
    const orgId = newOrgId()
    const conceptId = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const c = yield* concepts.create({ name: `Locked ${randomUUID().slice(0, 6)}` })
        yield* concepts.setVisibility(c.id, "none")
        return c.id
      }).pipe(Effect.provide(testLayer(orgId))),
    )
    expect(await listIds(testLayer(orgId, "tester", "owner"))).not.toContain(conceptId)
    // …but an explicit rule still reaches it. That is what 'none' is FOR.
    const opened = testLayer(orgId, "tester", "member", policyWith({ resourceId: conceptId }))
    expect(await listIds(opened)).toContain(conceptId)
    expect(await readOutcome(conceptId, opened)).toBe("read")
  })
})

/**
 * ── THE WRITE GATE ──────────────────────────────────────────────────────────
 *
 * A caller who cannot READ a record must not be able to WRITE it either.
 *
 * This was a real hole, found by reviewing the finished feature rather than by any
 * test: every read path was gated, and `update` / `archive` / `transition` / `purge` /
 * `discardDraft` / the record-level writes were not. A member who got `RecordVersionNotFound`
 * on read could still overwrite the record's fields by id — the value was verified
 * TAMPERED in the database.
 *
 * Two halves are needed and both are easy to get wrong alone: the concept gate covers
 * the `admin`/`none` default, and the record gate covers per-record rules but
 * deliberately no-ops when the caller holds no record rules — so on its own it lets an
 * empty-policy member straight through. That was the first failed fix attempt.
 */
describe("THE WRITE GATE: no writing what you cannot read", () => {
  const seedRestrictedRecord = () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const concept = yield* concepts.create({ name: `Sealed ${randomUUID().slice(0, 6)}` })
      const field = yield* fields.addField({ conceptId: concept.id, name: "T", kind: "text" })
      const inst = yield* recordVersions.create({
        conceptId: concept.id,
        fields: { [field.id]: "original" },
      })
      yield* concepts.setVisibility(concept.id, "admin")
      return { conceptId: concept.id, fieldId: field.id, inst }
    })

  it("a member cannot update, archive or transition a record they cannot read", async () => {
    const orgId = newOrgId()
    const f = await Effect.runPromise(seedRestrictedRecord().pipe(Effect.provide(testLayer(orgId))))
    const asMember = testLayer(orgId, "intruder", "member")

    const attempt = <A>(eff: Effect.Effect<A, unknown, OrgContext | RecordService>) =>
      Effect.runPromise(
        eff.pipe(
          Effect.provide(asMember),
          Effect.map(() => "succeeded"),
          Effect.catchAll(() => Effect.succeed("blocked")),
        ),
      )

    // The read is refused …
    expect(await attempt(Effect.flatMap(RecordService, (i) => i.get(f.inst.id)))).toBe("blocked")
    // … so every write must be too.
    expect(
      await attempt(
        Effect.flatMap(RecordService, (i) =>
          i.update({
            recordVersionId: f.inst.id,
            expectedVersion: f.inst.version,
            patch: { [f.fieldId]: "TAMPERED" },
          }),
        ),
      ),
    ).toBe("blocked")
    expect(
      await attempt(
        Effect.flatMap(RecordService, (i) =>
          i.archive({ recordVersionId: f.inst.id, expectedVersion: f.inst.version }),
        ),
      ),
    ).toBe("blocked")
    expect(
      await attempt(Effect.flatMap(RecordService, (i) => i.purge({ recordVersionId: f.inst.id }))),
    ).toBe("blocked")

    // THE PROOF: the value is untouched. A "blocked" result that still wrote would
    // pass every assertion above.
    const after = await Effect.runPromise(
      Effect.flatMap(RecordService, (i) => i.get(f.inst.id)).pipe(Effect.provide(testLayer(orgId))),
    )
    expect(after.state[f.fieldId]).toBe("original")
  })

  it("an admin CAN still write it — the gate follows read access, not privilege", async () => {
    const orgId = newOrgId()
    const f = await Effect.runPromise(seedRestrictedRecord().pipe(Effect.provide(testLayer(orgId))))
    const updated = await Effect.runPromise(
      Effect.flatMap(RecordService, (i) =>
        i.update({
          recordVersionId: f.inst.id,
          expectedVersion: f.inst.version,
          patch: { [f.fieldId]: "legitimate" },
        }),
      ).pipe(Effect.provide(testLayer(orgId, "boss", "member", unrestrictedPolicy("boss")))),
    )
    expect(updated.state[f.fieldId]).toBe("legitimate")
  })

  it("a member CAN write a record in a visible concept — no over-blocking", async () => {
    // The regression this fix could plausibly cause: gating writes too widely would
    // break ordinary editing for everyone.
    const orgId = newOrgId()
    const open = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const recordVersions = yield* RecordService
        const concept = yield* concepts.create({ name: `Open ${randomUUID().slice(0, 6)}` })
        const field = yield* fields.addField({ conceptId: concept.id, name: "T", kind: "text" })
        const inst = yield* recordVersions.create({
          conceptId: concept.id,
          fields: { [field.id]: "a" },
        })
        return { fieldId: field.id, inst }
      }).pipe(Effect.provide(testLayer(orgId))),
    )
    const edited = await Effect.runPromise(
      Effect.flatMap(RecordService, (i) =>
        i.update({
          recordVersionId: open.inst.id,
          expectedVersion: open.inst.version,
          patch: { [open.fieldId]: "b" },
        }),
      ).pipe(Effect.provide(testLayer(orgId, "member-1", "member", ordinaryMember("member-1")))),
    )
    expect(edited.state[open.fieldId]).toBe("b")
  })
})
