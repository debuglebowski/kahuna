import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

describe("concept configuration (settings)", () => {
  it.effect("updateConcept edits the description (no name change leaves the name)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const c = yield* concepts.create({ name: "Account" })
      const updated = yield* concepts.update({ id: c.id, description: "The hub." })
      expect(updated.name).toBe("Account")
      expect(updated.description).toBe("The hub.")
      const reread = yield* concepts.getById(c.id)
      expect(reread.description).toBe("The hub.")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("updateConcept renames a concept; existing instances still resolve by id", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Account", description: "The hub." })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })

      const renamed = yield* concepts.update({ id: c.id, name: "Company", description: "The hub." })
      expect(renamed.id).toBe(c.id) // id stable
      expect(renamed.name).toBe("Company")

      // The instance is unaffected — it points at the (unchanged) concept id.
      const reread = yield* instances.get(inst.id)
      expect(reread.conceptId).toBe(c.id)
      // Old name no longer resolves; new name does, to the same id.
      const byOld = yield* concepts.getByName("Account").pipe(Effect.flip)
      expect(byOld._tag).toBe("ConceptNotFound")
      const byNew = yield* concepts.getByName("Company")
      expect(byNew.id).toBe(c.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("updateConcept rename to an existing name fails ConceptNameConflict", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      yield* concepts.create({ name: "Account" })
      const deal = yield* concepts.create({ name: "Deal" })
      const err = yield* concepts
        .update({ id: deal.id, name: "Account", description: null })
        .pipe(Effect.flip)
      expect(err._tag).toBe("ConceptNameConflict")
      // Unchanged after the rejected rename.
      const reread = yield* concepts.getById(deal.id)
      expect(reread.name).toBe("Deal")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("create derives a stable slug; rename keeps it; getBySlug resolves", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const c = yield* concepts.create({ name: "Deal" })
      expect(c.slug).toBe("deal")
      const bySlug = yield* concepts.getBySlug("deal")
      expect(bySlug.id).toBe(c.id)
      // Rename leaves the slug untouched — it's the handle dashboards pin by.
      const renamed = yield* concepts.update({ id: c.id, name: "Opportunity", description: null })
      expect(renamed.name).toBe("Opportunity")
      expect(renamed.slug).toBe("deal")
      const stillBySlug = yield* concepts.getBySlug("deal")
      expect(stillBySlug.id).toBe(c.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("slug collisions get a numeric suffix", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const a = yield* concepts.create({ name: "Foo Bar" })
      const b = yield* concepts.create({ name: "Foo_Bar" })
      expect(a.slug).toBe("foo_bar")
      expect(b.slug).toBe("foo_bar_2")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("relation field config.target (a concept id) is enforced on link", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const relations = yield* RelationService

      const account = yield* concepts.create({ name: "Account" })
      const deal = yield* concepts.create({ name: "Deal" })
      // Declare a relation field on Deal that must target Account (by id).
      const accountField = yield* fields.addField({
        conceptId: deal.id,
        name: "account",
        kind: "relation",
        config: { target: account.id, cardinality: "one" },
      })

      const acc = yield* instances.create({ conceptId: account.id, fields: {} })
      const d = yield* instances.create({ conceptId: deal.id, fields: {} })

      // Linking to an Account instance satisfies the declared target id.
      yield* relations.create({ fieldId: accountField.id, fromId: d.id, toId: acc.id })

      // Linking to a non-Account target (another Deal) is rejected.
      const d2 = yield* instances.create({ conceptId: deal.id, fields: {} })
      const err = yield* relations
        .create({ fieldId: accountField.id, fromId: d.id, toId: d2.id })
        .pipe(Effect.flip)
      expect(err._tag).toBe("RelationTargetMismatch")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("deleteConcept removes the concept and its fields when empty", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Widget" })
      yield* fields.addField({ conceptId: c.id, name: "label", kind: "text" })
      yield* concepts.purge(c.id)
      const list = yield* concepts.list()
      expect(list.find((x) => x.id === c.id)).toBeUndefined()
      const remainingFields = yield* fields.listFields(c.id)
      expect(remainingFields.length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("deleteConcept is refused while live instances exist", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Account" })
      yield* instances.create({ conceptName: "Account", fields: {} })
      const err = yield* concepts.purge(c.id).pipe(Effect.flip)
      expect(err._tag).toBe("ConceptInUse")
      // Concept still present.
      const reread = yield* concepts.getById(c.id)
      expect(reread.id).toBe(c.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("updateField edits enum options and transitions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Deal" })
      const f = yield* fields.addField({
        conceptId: c.id,
        name: "status",
        kind: "enum",
        config: { options: ["lead", "won"] },
      })
      const updated = yield* fields.update({
        id: f.id,
        config: { options: ["lead", "qualified", "won"], transitions: { lead: ["qualified"] } },
      })
      expect(updated.config.options).toEqual(["lead", "qualified", "won"])
      expect(updated.config.transitions?.lead).toEqual(["qualified"])
      expect(updated.kind).toBe("enum") // kind unchanged
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("updateField rejects config invalid for the field's kind", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Deal" })
      const f = yield* fields.addField({
        conceptId: c.id,
        name: "status",
        kind: "enum",
        config: { options: ["lead"] },
      })
      const err = yield* fields.update({ id: f.id, config: { options: [] } }).pipe(Effect.flip)
      expect(err._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("deleteField removes the field def", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Deal" })
      const f = yield* fields.addField({ conceptId: c.id, name: "blocker", kind: "text" })
      yield* fields.archive(f.id)
      const remaining = yield* fields.listFields(c.id)
      expect(remaining.length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("update/remove on a missing field fails FieldNotFound", () =>
    Effect.gen(function* () {
      const fields = yield* FieldService
      const missing = randomUUID()
      const e1 = yield* fields.update({ id: missing, formula: null }).pipe(Effect.flip)
      expect(e1._tag).toBe("FieldNotFound")
      const e2 = yield* fields.archive(missing).pipe(Effect.flip)
      expect(e2._tag).toBe("FieldNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("archiveConcept hides it from the live list; restore brings it back", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const c = yield* concepts.create({ name: "Vendor" })
      yield* concepts.archive(c.id)
      const live = yield* concepts.list()
      expect(live.find((x) => x.id === c.id)).toBeUndefined()
      const all = yield* concepts.list({ includeArchived: true })
      expect(all.find((x) => x.id === c.id)?.deletedAt).not.toBeNull()
      // Its display name is free to reuse while archived (partial unique index).
      const reused = yield* concepts.create({ name: "Vendor" })
      expect(reused.id).not.toBe(c.id)
      // Restoring now clashes with the live "Vendor" — refused until renamed.
      const clash = yield* concepts.restore(c.id).pipe(Effect.flip)
      expect(clash._tag).toBe("ConceptNameConflict")
      yield* concepts.archive(reused.id)
      const restored = yield* concepts.restore(c.id)
      expect(restored.deletedAt).toBeNull()
      const liveAgain = yield* concepts.list()
      expect(liveAgain.find((x) => x.id === c.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purge is refused while an archived instance still references the concept", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Ticket" })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.archive({ instanceId: inst.id, expectedVersion: inst.version })
      // Even though the instance is archived (not "live"), it still pins the concept.
      const err = yield* concepts.purge(c.id).pipe(Effect.flip)
      expect(err._tag).toBe("ConceptInUse")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("archiveField hides it from listFields; restore round-trips; purge is permanent", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Deal" })
      const f = yield* fields.addField({ conceptId: c.id, name: "note", kind: "text" })

      yield* fields.archive(f.id)
      expect((yield* fields.listFields(c.id)).length).toBe(0)
      const withArchived = yield* fields.listFields(c.id, { includeArchived: true })
      expect(withArchived.find((x) => x.id === f.id)?.deletedAt).not.toBeNull()

      const restored = yield* fields.restore(f.id)
      expect(restored.deletedAt).toBeNull()
      expect((yield* fields.listFields(c.id)).length).toBe(1)

      yield* fields.purge(f.id)
      expect((yield* fields.listFields(c.id, { includeArchived: true })).length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purge field is refused while a relation edge references it (FieldInUse)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const account = yield* concepts.create({ name: "Account" })
      const deal = yield* concepts.create({ name: "Deal" })
      const rel = yield* fields.addField({
        conceptId: deal.id,
        name: "account",
        kind: "relation",
        config: { target: account.id, cardinality: "one" },
      })
      const acc = yield* instances.create({ conceptId: account.id, fields: {} })
      const d = yield* instances.create({ conceptId: deal.id, fields: {} })
      yield* relations.create({ fieldId: rel.id, fromId: d.id, toId: acc.id })
      const err = yield* fields.purge(rel.id).pipe(Effect.flip)
      expect(err._tag).toBe("FieldInUse")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
