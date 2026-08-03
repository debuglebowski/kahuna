import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type AccessRule, emptyPolicy, type PolicySet } from "../domain/access"
import {
  canReadConcept,
  canReadRestricted,
  hiddenFieldIds,
  projectState,
} from "../domain/visibility"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { QueryService } from "../services/QueryService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

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
    const instances = yield* InstanceService
    const concept = yield* concepts.create({ name: `Secret ${randomUUID().slice(0, 6)}` })
    const field = yield* fields.addField({ conceptId: concept.id, name: "Amount", kind: "text" })
    const inst = yield* instances.create({
      conceptId: concept.id,
      fields: { [field.id]: "9000" },
    })
    yield* concepts.setVisibility(concept.id, "admin")
    return { conceptId: concept.id, slug: concept.slug, instance: inst, fieldId: field.id }
  })

describe("concept read visibility", () => {
  it("the predicate is explicit about who may read restricted material", () => {
    expect(canReadRestricted("member")).toBe(false)
    expect(canReadRestricted("admin")).toBe(true)
    expect(canReadRestricted("owner")).toBe(true)
    // The engine itself (syncs, automations, seeds) is never filtered.
    expect(canReadRestricted("system")).toBe(true)
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
        const instances = yield* InstanceService
        const listed = yield* concepts.list()
        const byId = yield* Effect.either(concepts.getByIdForRead(seeded.conceptId))
        const bySlug = yield* Effect.either(concepts.getBySlug(seeded.slug))
        const rows = yield* Effect.either(query.findInstances({ conceptId: seeded.conceptId }))
        const one = yield* Effect.either(instances.get(seeded.instance.id))
        const item = yield* Effect.either(instances.getItem(seeded.instance.itemId))
        const versions = yield* Effect.either(instances.listVersions(seeded.instance.itemId))
        const single = yield* Effect.either(instances.singleRecordOf(seeded.conceptId))
        return { listed, byId, bySlug, rows, one, item, versions, single }
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
      expect((asMember.one.left as { _tag: string })._tag).toBe("InstanceNotFound")
    expect(asMember.item._tag).toBe("Left")
    expect(asMember.versions._tag).toBe("Left")
    expect(asMember.single._tag).toBe("Left")

    // ── as an ADMIN, the same reads all succeed ──────────────────────────────
    const asAdmin = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const query = yield* QueryService
        const instances = yield* InstanceService
        return {
          listed: (yield* concepts.list()).map((c) => c.id),
          byId: (yield* concepts.getByIdForRead(seeded.conceptId)).id,
          rows: (yield* query.findInstances({ conceptId: seeded.conceptId })).length,
          value: (yield* instances.get(seeded.instance.id)).state[seeded.fieldId],
          versions: (yield* instances.listVersions(seeded.instance.itemId)).length,
        }
      }).pipe(Effect.provide(testLayer(orgId, "admin-user", "admin"))),
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
        const instances = yield* InstanceService
        const c = yield* concepts.create({ name: `Open ${randomUUID().slice(0, 6)}` })
        const f = yield* fields.addField({ conceptId: c.id, name: "Note", kind: "text" })
        const i = yield* instances.create({ conceptId: c.id, fields: { [f.id]: "hello" } })
        return { conceptId: c.id, instanceId: i.id, fieldId: f.id }
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const query = yield* QueryService
        const instances = yield* InstanceService
        return {
          listed: (yield* concepts.list()).map((c) => c.id),
          rows: (yield* query.findInstances({ conceptId: open.conceptId })).length,
          value: (yield* instances.get(open.instanceId)).state[open.fieldId],
          visibility: (yield* concepts.getByIdForRead(open.conceptId)).visibility,
        }
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
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
        const instances = yield* InstanceService
        const secret = yield* concepts.create({ name: `Vault ${randomUUID().slice(0, 6)}` })
        const secretRec = yield* instances.create({ conceptId: secret.id, fields: {} })
        const open = yield* concepts.create({ name: `Doc ${randomUUID().slice(0, 6)}` })
        const link = yield* fields.addField({
          conceptId: open.id,
          name: "Vault",
          kind: "relation",
          config: { target: secret.id },
        })
        const openRec = yield* instances.create({ conceptId: open.id, fields: {} })
        yield* concepts.setVisibility(secret.id, "admin")
        return { fieldId: link.id, fromId: openRec.id, toItemId: secretRec.itemId }
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const relations = yield* RelationService
        return yield* Effect.either(
          relations.create({
            fieldId: setup.fieldId,
            fromId: setup.fromId,
            toItemId: setup.toItemId,
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
          toItemId: setup.toItemId,
        })
      }).pipe(Effect.provide(testLayer(orgId, "admin-user", "admin"))),
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

describe("field read visibility", () => {
  /** A concept with one open + one restricted field, and a record holding both. */
  const seedFields = () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const concept = yield* concepts.create({ name: `Staff ${randomUUID().slice(0, 6)}` })
      const name = yield* fields.addField({ conceptId: concept.id, name: "Name", kind: "text" })
      const salary = yield* fields.addField({ conceptId: concept.id, name: "Salary", kind: "text" })
      const rec = yield* instances.create({
        conceptId: concept.id,
        fields: { [name.id]: "Ada", [salary.id]: "250000" },
      })
      yield* fields.setVisibility(salary.id, "admin")
      return { conceptId: concept.id, nameId: name.id, salaryId: salary.id, rec }
    })

  it("the projection drops only hidden keys, and is identity when nothing hides", () => {
    const defs = [
      { id: "a", visibility: "visible" as const },
      { id: "b", visibility: "admin" as const },
    ]
    const hidden = hiddenFieldIds(defs, "member")
    expect([...hidden]).toEqual(["b"])
    expect(projectState({ a: 1, b: 2 }, hidden)).toEqual({ a: 1 })
    // A privileged caller gets the SAME object back — no needless copying.
    const none = hiddenFieldIds(defs, "admin")
    const state = { a: 1, b: 2 }
    expect(projectState(state, none)).toBe(state)
  })

  it("THE DATA-LOSS GUARD: a member's edit must not erase a hidden field", async () => {
    // This is why the projection lives at the use-case boundary and NOT in
    // `toInstance`: `update` reads current state through the mapper, folds the patch
    // onto it, and writes the result back. A filter there would delete the salary.
    const orgId = newOrgId()
    const f = await Effect.runPromise(
      seedFields().pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        const cur = yield* instances.get(f.rec.id)
        return yield* instances.update({
          instanceId: f.rec.id,
          expectedVersion: cur.version,
          patch: { [f.nameId]: "Grace" },
        })
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
    )
    expect(updated.state[f.nameId]).toBe("Grace")

    // Read it back as SYSTEM: the hidden value must still be there.
    const raw = await Effect.runPromise(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        return (yield* instances.get(f.rec.id)).state
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )
    expect(raw[f.salaryId]).toBe("250000")
    expect(raw[f.nameId]).toBe("Grace")
  })

  it("THE ENFORCEMENT GUARD: a required hidden field still blocks a create", async () => {
    // Why the filter is not in `FieldService.listFields`: `checkRequired` iterates
    // those same defs, so filtering them would silently stop enforcing requirements.
    const orgId = newOrgId()
    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const c = yield* concepts.create({ name: `Req ${randomUUID().slice(0, 6)}` })
        const secret = yield* fields.addField({
          conceptId: c.id,
          name: "Secret",
          kind: "text",
          config: { requirement: "required" },
        })
        yield* fields.setVisibility(secret.id, "admin")
        return { conceptId: c.id, secretId: secret.id }
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )

    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        return yield* Effect.either(instances.create({ conceptId: setup.conceptId, fields: {} }))
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
    )
    expect(denied._tag).toBe("Left")
    if (denied._tag === "Left")
      expect((denied.left as { _tag: string })._tag).toBe("FieldValidationError")
  })

  it("rebuild after a member-scoped read leaves state byte-identical", async () => {
    const orgId = newOrgId()
    const f = await Effect.runPromise(
      seedFields().pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )
    // A member reads it (which masks), then the projection is rebuilt from events.
    await Effect.runPromise(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        yield* instances.get(f.rec.id)
      }).pipe(Effect.provide(testLayer(orgId, "member-user", "member"))),
    )
    const rebuilt = await Effect.runPromise(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        yield* instances.rebuild(f.rec.id)
        return (yield* instances.get(f.rec.id)).state
      }).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
    )
    expect(rebuilt[f.salaryId]).toBe("250000")
    expect(rebuilt[f.nameId]).toBe("Ada")
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
