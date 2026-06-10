import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { newOrgId, testLayer } from "./harness"

describe("field requirement (required / flagged / optional)", () => {
  it.effect("create without a required field's value is rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Deal" })
      yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: { requirement: "required" },
      })
      const err = yield* instances.create({ conceptId: c.id, fields: {} }).pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      expect((err as { message: string }).message).toContain('"title" is required')
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("empty string / empty list count as missing on create", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: { requirement: "required" },
      })
      const tags = yield* fields.addField({
        conceptId: c.id,
        name: "tags",
        kind: "text",
        config: { requirement: "required", multiple: true },
      })
      const blankTitle = yield* instances
        .create({ conceptId: c.id, fields: { [title.id]: "", [tags.id]: ["a"] } })
        .pipe(Effect.flip)
      expect(blankTitle._tag).toBe("FieldValidationError")
      const emptyTags = yield* instances
        .create({ conceptId: c.id, fields: { [title.id]: "Acme", [tags.id]: [] } })
        .pipe(Effect.flip)
      expect(emptyTags._tag).toBe("FieldValidationError")
      const ok = yield* instances.create({
        conceptId: c.id,
        fields: { [title.id]: "Acme", [tags.id]: ["a"] },
      })
      expect(ok.state[title.id]).toBe("Acme")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("update may not clear a required value, but other fields stay editable", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const notes = yield* fields.addField({ conceptId: c.id, name: "notes", kind: "text" })
      // Created BEFORE the rule — the row predates `required` and misses a value.
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* fields.update({ id: title.id, config: { requirement: "required" } })

      // Editing an unrelated field on the incomplete row still works.
      const patched = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: inst.version,
        patch: { [notes.id]: "hello" },
      })
      expect(patched.state[notes.id]).toBe("hello")

      // Setting the required field works; clearing it back is rejected.
      const filled = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: patched.version,
        patch: { [title.id]: "Acme" },
      })
      const err = yield* instances
        .update({
          instanceId: inst.id,
          expectedVersion: filled.version,
          patch: { [title.id]: "" },
        })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      expect((err as { message: string }).message).toContain('"title" is required')
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("flagged never blocks writes", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: { requirement: "flagged" },
      })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      const cleared = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: inst.version,
        patch: { [title.id]: "" },
      })
      expect(cleared.state[title.id]).toBe("")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("config.requirement is rejected on relation/file/computed kinds", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Deal" })
      const err = yield* fields
        .addField({
          conceptId: c.id,
          name: "account",
          kind: "relation",
          config: { target: c.id, requirement: "required" },
        })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("publish is gated on required values a draft predates", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Spec" })
      yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      // Draft created while the field was optional, then the rule flips.
      const draft = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* fields.update({ id: title.id, config: { requirement: "required" } })

      const err = yield* instances
        .publishVersion({ instanceId: draft.id, expectedVersion: draft.version })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")

      const filled = yield* instances.update({
        instanceId: draft.id,
        expectedVersion: draft.version,
        patch: { [title.id]: "v1" },
      })
      const published = yield* instances.publishVersion({
        instanceId: draft.id,
        expectedVersion: filled.version,
      })
      expect(published.versionStatus).toBe("published")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
