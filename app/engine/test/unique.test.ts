import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { newOrgId, testLayer } from "./harness"

describe("field uniqueness (config.unique)", () => {
  it.effect("create with a duplicate value is rejected; a distinct value passes", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      yield* instances.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      const err = yield* instances
        .create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      expect((err as { message: string }).message).toContain('"email" must be unique')
      const ok = yield* instances.create({ conceptId: c.id, fields: { [email.id]: "b@x.io" } })
      expect(ok.state[email.id]).toBe("b@x.io")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "update to a value another item holds is rejected; re-saving one's own value is not",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const instances = yield* InstanceService
        const c = yield* concepts.create({ name: "Person" })
        const handle = yield* fields.addField({
          conceptId: c.id,
          name: "handle",
          kind: "text",
          config: { unique: true },
        })
        yield* instances.create({ conceptId: c.id, fields: { [handle.id]: "alice" } })
        const bob = yield* instances.create({ conceptId: c.id, fields: { [handle.id]: "bob" } })
        const err = yield* instances
          .update({
            instanceId: bob.id,
            expectedVersion: bob.version,
            patch: { [handle.id]: "alice" },
          })
          .pipe(Effect.flip)
        expect(err._tag).toBe("FieldValidationError")
        // An idempotent save of the row's own value must pass (autosave re-sends).
        const same = yield* instances.update({
          instanceId: bob.id,
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
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.create({ conceptId: c.id, fields: { [email.id]: "" } })
      const ok = yield* instances.create({ conceptId: c.id, fields: { [email.id]: "" } })
      expect(ok.state[email.id]).toBe("")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an archived item keeps its claim on a value — only a purge releases it", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      const gone = yield* instances.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      yield* instances.archive({ instanceId: gone.id, expectedVersion: gone.version })
      const blocked = yield* instances
        .create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
        .pipe(Effect.flip)
      expect(blocked._tag).toBe("FieldValidationError")
      yield* instances.purge({ instanceId: gone.id })
      const ok = yield* instances.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      expect(ok.state[email.id]).toBe("a@x.io")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("text uniqueness is case-insensitive (write-time and enable-scan)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { unique: true },
      })
      yield* instances.create({ conceptId: c.id, fields: { [email.id]: "Bob@X.io" } })
      const err = yield* instances
        .create({ conceptId: c.id, fields: { [email.id]: "bob@x.io" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      // Case-variant duplicates on an existing field also block flipping unique ON.
      const handle = yield* fields.addField({ conceptId: c.id, name: "handle", kind: "text" })
      yield* instances.create({ conceptId: c.id, fields: { [handle.id]: "Alice" } })
      yield* instances.create({ conceptId: c.id, fields: { [handle.id]: "alice" } })
      const flip = yield* fields
        .update({ id: handle.id, config: { unique: true } })
        .pipe(Effect.flip)
      expect(flip._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("enabling unique on a field with existing cross-item duplicates is rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({ conceptId: c.id, name: "email", kind: "text" })
      yield* instances.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      const dup = yield* instances.create({ conceptId: c.id, fields: { [email.id]: "a@x.io" } })
      const err = yield* fields.update({ id: email.id, config: { unique: true } }).pipe(Effect.flip)
      expect(err._tag).toBe("FieldConfigInvalid")
      expect((err as { reason: string }).reason).toContain("duplicated across items")
      // Resolve the duplicate → the flip passes, and the rule enforces from then on.
      yield* instances.update({
        instanceId: dup.id,
        expectedVersion: dup.version,
        patch: { [email.id]: "b@x.io" },
      })
      yield* fields.update({ id: email.id, config: { unique: true } })
      const blocked = yield* instances
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

  it.effect("versions of one item share a unique value; other items still can't take it", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Spec" })
      yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
      const sku = yield* fields.addField({
        conceptId: c.id,
        name: "sku",
        kind: "text",
        config: { unique: true },
      })
      const draft = yield* instances.create({ conceptId: c.id, fields: { [sku.id]: "SKU-1" } })
      const published = yield* instances.publishVersion({
        instanceId: draft.id,
        expectedVersion: draft.version,
      })
      // A new draft clones the head's state — the shared value is legal in-lineage.
      const v2 = yield* instances.newVersion({ itemId: published.itemId })
      expect(v2.state[sku.id]).toBe("SKU-1")
      const err = yield* instances
        .create({ conceptId: c.id, fields: { [sku.id]: "SKU-1" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("structured values compare by jsonb equality (money)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Deal" })
      const price = yield* fields.addField({
        conceptId: c.id,
        name: "price",
        kind: "money",
        config: { unique: true },
      })
      yield* instances.create({
        conceptId: c.id,
        fields: { [price.id]: { amount: 100, currency: "EUR" } },
      })
      const err = yield* instances
        .create({ conceptId: c.id, fields: { [price.id]: { amount: 100, currency: "EUR" } } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
      const ok = yield* instances.create({
        conceptId: c.id,
        fields: { [price.id]: { amount: 100, currency: "USD" } },
      })
      expect(ok.state[price.id]).toEqual({ amount: 100, currency: "USD" })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
