import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { newOrgId, testLayer } from "./harness"

/** A minimal TipTap/ProseMirror doc with one paragraph of text. */
const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

describe("richtext field kind", () => {
  it.effect("a { doc, text } envelope round-trips through create and update", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })

      const v1 = { doc: doc("hello"), text: "hello" }
      const inst = yield* instances.create({ conceptId: c.id, fields: { [body.id]: v1 } })
      expect(inst.state[body.id]).toEqual(v1)

      const v2 = { doc: doc("hello world"), text: "hello world" }
      const updated = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: inst.version,
        patch: { [body.id]: v2 },
      })
      expect(updated.state[body.id]).toEqual(v2)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("stored text is derived from the doc — a lying client copy is overwritten", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const inst = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: { doc: doc("hello"), text: "something else entirely" } },
      })
      expect(inst.state[body.id]).toEqual({ doc: doc("hello"), text: "hello" })

      const multi = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "one" }] },
          { type: "paragraph", content: [{ type: "text", text: "two" }] },
        ],
      }
      const updated = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: inst.version,
        patch: { [body.id]: { doc: multi, text: "" } },
      })
      expect((updated.state[body.id] as { text: string }).text).toBe("one two")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("extra envelope keys are stripped on write", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const inst = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: { doc: doc("x"), text: "x", html: "<p>x</p>" } },
      })
      expect(inst.state[body.id]).toEqual({ doc: doc("x"), text: "x" })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("malformed values are rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const reject = (value: unknown) =>
        instances.create({ conceptId: c.id, fields: { [body.id]: value } }).pipe(Effect.flip)

      const plainString = yield* reject("just text")
      expect(plainString._tag).toBe("FieldValidationError")
      const noText = yield* reject({ doc: doc("x") })
      expect(noText._tag).toBe("FieldValidationError")
      const wrongRoot = yield* reject({ doc: { type: "paragraph" }, text: "x" })
      expect(wrongRoot._tag).toBe("FieldValidationError")
      const docOnlyJson = yield* reject(doc("x"))
      expect(docOnlyJson._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("requirement: an empty-text envelope counts as missing", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({
        conceptId: c.id,
        name: "body",
        kind: "richtext",
        config: { requirement: "required" },
      })

      const empty = yield* instances
        .create({
          conceptId: c.id,
          fields: { [body.id]: { doc: { type: "doc", content: [] }, text: "  " } },
        })
        .pipe(Effect.flip)
      expect(empty._tag).toBe("FieldValidationError")
      expect((empty as { message: string }).message).toContain('"body" is required')

      const ok = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: { doc: doc("hi"), text: "hi" } },
      })
      expect(ok.state[body.id]).toEqual({ doc: doc("hi"), text: "hi" })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("config.multiple is rejected on richtext fields", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Page" })
      const err = yield* fields
        .addField({ conceptId: c.id, name: "body", kind: "richtext", config: { multiple: true } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
