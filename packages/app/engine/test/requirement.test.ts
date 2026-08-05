import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { RecordService } from "../services/RecordService"
import { newOrgId, testLayer } from "./harness"

describe("field requirement (required / flagged / optional)", () => {
  it.effect("create without a required field's value is rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Deal" })
      yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: { requirement: "required" },
      })
      const err = yield* recordVersions.create({ conceptId: c.id, fields: {} }).pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      expect((err as { message: string }).message).toContain('"title" is required')
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an explicit null clears an optional field on update (key dropped)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: {},
      })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "Acme" } })
      const cleared = yield* recordVersions.update({
        recordVersionId: inst.id,
        expectedVersion: inst.version,
        patch: { [title.id]: null },
      })
      expect(title.id in cleared.state).toBe(false)
      expect(cleared.version).toBe(inst.version + 1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an explicit null on a required field is rejected (clear-protection)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: { requirement: "required" },
      })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "Acme" } })
      const err = yield* recordVersions
        .update({
          recordVersionId: inst.id,
          expectedVersion: inst.version,
          patch: { [title.id]: null },
        })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      expect((err as { message: string }).message).toContain('"title" is required')
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("empty string / empty list count as missing on create", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
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
      const blankTitle = yield* recordVersions
        .create({ conceptId: c.id, fields: { [title.id]: "", [tags.id]: ["a"] } })
        .pipe(Effect.flip)
      expect(blankTitle._tag).toBe("FieldValidationError")
      const emptyTags = yield* recordVersions
        .create({ conceptId: c.id, fields: { [title.id]: "Acme", [tags.id]: [] } })
        .pipe(Effect.flip)
      expect(emptyTags._tag).toBe("FieldValidationError")
      const ok = yield* recordVersions.create({
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
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const notes = yield* fields.addField({ conceptId: c.id, name: "notes", kind: "text" })
      // Created BEFORE the rule — the row predates `required` and misses a value.
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      yield* fields.update({ id: title.id, config: { requirement: "required" } })

      // Editing an unrelated field on the incomplete row still works.
      const patched = yield* recordVersions.update({
        recordVersionId: inst.id,
        expectedVersion: inst.version,
        patch: { [notes.id]: "hello" },
      })
      expect(patched.state[notes.id]).toBe("hello")

      // Setting the required field works; clearing it back is rejected.
      const filled = yield* recordVersions.update({
        recordVersionId: inst.id,
        expectedVersion: patched.version,
        patch: { [title.id]: "Acme" },
      })
      const err = yield* recordVersions
        .update({
          recordVersionId: inst.id,
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
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Deal" })
      const title = yield* fields.addField({
        conceptId: c.id,
        name: "title",
        kind: "text",
        config: { requirement: "flagged" },
      })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const cleared = yield* recordVersions.update({
        recordVersionId: inst.id,
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
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Spec" })
      yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      // Draft created while the field was optional, then the rule flips.
      const draft = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      yield* fields.update({ id: title.id, config: { requirement: "required" } })

      const err = yield* recordVersions
        .publishVersion({ recordVersionId: draft.id, expectedVersion: draft.version })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")

      const filled = yield* recordVersions.update({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        patch: { [title.id]: "v1" },
      })
      const published = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: filled.version,
      })
      expect(published.versionStatus).toBe("published")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
