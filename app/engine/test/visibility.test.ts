import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { canReadConcept, canReadRestricted } from "../domain/visibility"
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
const seedRestricted = (orgId: string) =>
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
      seedRestricted(orgId).pipe(Effect.provide(testLayer(orgId, "seed", "system"))),
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
