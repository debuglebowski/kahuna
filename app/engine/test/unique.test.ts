import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { RecordService } from "../services/RecordService"
import { newOrgId, testLayer } from "./harness"

describe("field uniqueness (config.unique)", () => {
  it.effect("create with a duplicate value is rejected; a distinct value passes", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      const err = yield* recordVersions
        .create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      expect((err as { message: string }).message).toContain('"email" must be unique')
      const ok = yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "b@x.io" } })
      expect(ok.state[email.id]).toBe("b@x.io")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "update to a value another record holds is rejected; re-saving one's own value is not",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const recordVersions = yield* RecordService
        const c = yield* concepts.create({ name: "Person" })
        const handle = yield* fields.addField({
          conceptId: c.id,
          name: "handle",
          kind: "text",
          config: { unique: true },
        })
        yield* recordVersions.create({ conceptId: c.id, fields: { [handle.id]: "alice" } })
        const bob = yield* recordVersions.create({
          conceptId: c.id,
          fields: { [handle.id]: "bob" },
        })
        const err = yield* recordVersions
          .update({
            recordVersionId: bob.id,
            expectedVersion: bob.version,
            patch: { [handle.id]: "alice" },
          })
          .pipe(Effect.flip)
        expect(err._tag).toBe("FieldValidationError")
        // An idempotent save of the row's own value must pass (autosave re-sends).
        const same = yield* recordVersions.update({
          recordVersionId: bob.id,
          expectedVersion: bob.version,
          patch: { [handle.id]: "bob" },
        })
        expect(same.state[handle.id]).toBe("bob")
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("missing values never conflict (many rows without a value / with empty string)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      yield* recordVersions.create({ conceptId: c.id, fields: {} })
      yield* recordVersions.create({ conceptId: c.id, fields: {} })
      yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "" } })
      const ok = yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "" } })
      expect(ok.state[email.id]).toBe("")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an archived record keeps its claim on a value — only a purge releases it", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      const gone = yield* recordVersions.create({
        conceptId: c.id,
        fields: { [email.id]: "a@x.io" },
      })
      yield* recordVersions.archive({ recordVersionId: gone.id, expectedVersion: gone.version })
      const blocked = yield* recordVersions
        .create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
        .pipe(Effect.flip)
      expect(blocked._tag).toBe("FieldValidationError")
      yield* recordVersions.purge({ recordVersionId: gone.id })
      const ok = yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      expect(ok.state[email.id]).toBe("a@x.io")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("text uniqueness is case-insensitive (write-time and enable-scan)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "Bob@X.io" } })
      const err = yield* recordVersions
        .create({ conceptId: c.id, fields: { [email.id]: "bob@x.io" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      // Case-variant duplicates on an existing field also block flipping unique ON.
      const handle = yield* fields.addField({ conceptId: c.id, name: "handle", kind: "text" })
      yield* recordVersions.create({ conceptId: c.id, fields: { [handle.id]: "Alice" } })
      yield* recordVersions.create({ conceptId: c.id, fields: { [handle.id]: "alice" } })
      const flip = yield* fields
        .update({ id: handle.id, config: { unique: true } })
        .pipe(Effect.flip)
      expect(flip._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("enabling unique on a field with existing cross-record duplicates is rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({ conceptId: c.id, name: "email", kind: "text" })
      yield* recordVersions.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      const dup = yield* recordVersions.create({
        conceptId: c.id,
        fields: { [email.id]: "a@x.io" },
      })
      const err = yield* fields.update({ id: email.id, config: { unique: true } }).pipe(Effect.flip)
      expect(err._tag).toBe("FieldConfigInvalid")
      expect((err as { reason: string }).reason).toContain("duplicated across records")
      // Resolve the duplicate → the flip passes, and the rule enforces from then on.
      yield* recordVersions.update({
        recordVersionId: dup.id,
        expectedVersion: dup.version,
        patch: { [email.id]: "b@x.io" },
      })
      yield* fields.update({ id: email.id, config: { unique: true } })
      const blocked = yield* recordVersions
        .create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
        .pipe(Effect.flip)
      expect(blocked._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("config.unique is rejected on ineligible kinds and with config.multiple", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Person" })
      const onBool = yield* fields
        .addField({ conceptId: c.id, name: "flag", kind: "bool", config: { unique: true } })
        .pipe(Effect.flip)
      expect(onBool._tag).toBe("FieldConfigInvalid")
      const withMultiple = yield* fields
        .addField({
          conceptId: c.id,
          name: "tags",
          kind: "text",
          config: { unique: true, multiple: true },
        })
        .pipe(Effect.flip)
      expect(withMultiple._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("versions of one record share a unique value; other records still can't take it", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Spec" })
      yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
      const sku = yield* fields.addField({
        conceptId: c.id,
        name: "sku",
        kind: "text",
        config: { unique: true },
      })
      const draft = yield* recordVersions.create({ conceptId: c.id, fields: { [sku.id]: "SKU-1" } })
      const published = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })
      // A new draft clones the head's state — the shared value is legal in-lineage.
      const v2 = yield* recordVersions.newVersion({ recordId: published.recordId })
      expect(v2.state[sku.id]).toBe("SKU-1")
      const err = yield* recordVersions
        .create({ conceptId: c.id, fields: { [sku.id]: "SKU-1" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("structured values compare by jsonb equality (money)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Deal" })
      const price = yield* fields.addField({
        conceptId: c.id,
        name: "price",
        kind: "money",
        config: { unique: true },
      })
      yield* recordVersions.create({
        conceptId: c.id,
        fields: { [price.id]: { amount: 100, currency: "EUR" } },
      })
      const err = yield* recordVersions
        .create({ conceptId: c.id, fields: { [price.id]: { amount: 100, currency: "EUR" } } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      const ok = yield* recordVersions.create({
        conceptId: c.id,
        fields: { [price.id]: { amount: 100, currency: "USD" } },
      })
      expect(ok.state[price.id]).toEqual({ amount: 100, currency: "USD" })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
