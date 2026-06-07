import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { newOrgId, testLayer } from "./harness"

describe("concept configuration (settings)", () => {
  it.effect("updateConcept edits the description (name immutable)", () =>
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

  it.effect("deleteConcept removes the concept and its fields when empty", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Widget" })
      yield* fields.addField({ conceptId: c.id, name: "label", kind: "text" })
      yield* concepts.remove(c.id)
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
      const err = yield* concepts.remove(c.id).pipe(Effect.flip)
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
      yield* fields.remove(f.id)
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
      const e2 = yield* fields.remove(missing).pipe(Effect.flip)
      expect(e2._tag).toBe("FieldNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
