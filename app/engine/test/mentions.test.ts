import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { extractMentions, MAX_MENTIONS_PER_DOC } from "../domain/mentions"
import { AnnotationService } from "../services/AnnotationService"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { MentionService } from "../services/MentionService"
import { newOrgId, testLayer } from "./harness"

interface Ref {
  readonly kind: string
  readonly targetId: string
  readonly label?: string
}

/** A doc holding one mention per ref, each in its own paragraph. */
const docOf = (...refs: ReadonlyArray<Ref>) => ({
  type: "doc",
  content: refs.map((r) => ({
    type: "paragraph",
    content: [{ type: "mention", attrs: { label: "", ...r } }],
  })),
})

const envelope = (...refs: ReadonlyArray<Ref>) => ({ doc: docOf(...refs), text: "" })

/** Mention index rows for one instance, read straight from the table. */
const rowsFor = (instanceId: string) =>
  Effect.flatMap(
    PgClient.PgClient,
    (sql) => sql<{
      readonly kind: string
      readonly target_id: string
      readonly target_item_id: string | null
      readonly from_field_id: string | null
    }>`SELECT kind, target_id, target_item_id, from_field_id FROM mentions
       WHERE from_instance_id = ${instanceId} ORDER BY target_id`,
  )

describe("extractMentions (pure)", () => {
  it("collects distinct mentions in document order", () => {
    const doc = docOf(
      { kind: "record", targetId: "a" },
      { kind: "person", targetId: "u1" },
      { kind: "record", targetId: "a" }, // duplicate: one row, not two
    )
    expect(extractMentions(doc)).toEqual([
      { kind: "record", targetId: "a" },
      { kind: "person", targetId: "u1" },
    ])
  })

  it("DROPS malformed nodes rather than failing — a document is never hostage to the index", () => {
    expect(extractMentions(docOf({ kind: "notAKind", targetId: "x" }))).toEqual([])
    expect(extractMentions(docOf({ kind: "record", targetId: "" }))).toEqual([])
    expect(extractMentions({ type: "doc", content: [{ type: "mention" }] })).toEqual([])
    expect(extractMentions(null)).toEqual([])
    expect(extractMentions({ type: "doc" })).toEqual([])
  })

  it("caps at MAX_MENTIONS_PER_DOC", () => {
    const many = Array.from({ length: MAX_MENTIONS_PER_DOC + 50 }, (_, i) => ({
      kind: "record" as const,
      targetId: `id-${i}`,
    }))
    expect(extractMentions(docOf(...many))).toHaveLength(MAX_MENTIONS_PER_DOC)
  })
})

describe("mention index: instance fields", () => {
  it.effect("indexes on create, and links a real record target to its lineage", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const target = yield* instances.create({ conceptId: c.id, fields: {} })

      const inst = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: envelope({ kind: "record", targetId: target.itemId, label: "Acme" }) },
      })
      const rows = yield* rowsFor(inst.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe("record")
      expect(rows[0]!.target_item_id).toBe(target.itemId)
      expect(rows[0]!.from_field_id).toBe(body.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a mention of a nonexistent record indexes with a null lineage, no FK error", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })

      const gone = "11111111-2222-3333-4444-555555555555"
      const inst = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: envelope({ kind: "record", targetId: gone, label: "Ghost" }) },
      })
      const rows = yield* rowsFor(inst.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.target_id).toBe(gone)
      expect(rows[0]!.target_item_id).toBe(null)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a non-uuid targetId cannot reach the uuid comparison", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })

      // `page` targets are nav keys, not uuids; a record kind can also be garbage.
      const inst = yield* instances.create({
        conceptId: c.id,
        fields: {
          [body.id]: envelope(
            { kind: "page", targetId: "overview", label: "Overview" },
            { kind: "record", targetId: "not-a-uuid", label: "Junk" },
          ),
        },
      })
      const rows = yield* rowsFor(inst.id)
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.target_item_id === null)).toBe(true)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("THE FOLDED-STATE GUARD: updating field B keeps field A's mentions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const a = yield* fields.addField({ conceptId: c.id, name: "a", kind: "richtext" })
      const b = yield* fields.addField({ conceptId: c.id, name: "b", kind: "richtext" })

      const inst = yield* instances.create({
        conceptId: c.id,
        fields: {
          [a.id]: envelope({ kind: "person", targetId: "u-a", label: "A" }),
          [b.id]: envelope({ kind: "person", targetId: "u-b", label: "B" }),
        },
      })
      expect(yield* rowsFor(inst.id)).toHaveLength(2)

      // An update carries ONLY field b. Re-indexing from the patch instead of the
      // folded state would delete every row for this instance and re-insert only
      // b's — silently dropping a's backlink.
      const updated = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: inst.version,
        patch: { [b.id]: envelope({ kind: "person", targetId: "u-b2", label: "B2" }) },
      })
      const rows = yield* rowsFor(updated.id)
      expect(rows.map((r) => r.target_id).sort()).toEqual(["u-a", "u-b2"])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("clearing a field removes its rows", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const inst = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: envelope({ kind: "person", targetId: "u1", label: "A" }) },
      })
      expect(yield* rowsFor(inst.id)).toHaveLength(1)

      const cleared = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: inst.version,
        patch: { [body.id]: null },
      })
      expect(yield* rowsFor(cleared.id)).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("listBacklinks", () => {
  it.effect("a DRAFT source is private — it produces no backlink until published", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const mentions = yield* MentionService
      // Versioned so `create` yields a draft we can publish deliberately.
      const c = yield* concepts.create({ name: "Page" })
      yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const target = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.publishVersion({ instanceId: target.id, expectedVersion: target.version })

      const src = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: envelope({ kind: "record", targetId: target.itemId, label: "T" }) },
      })
      expect(yield* mentions.listBacklinks(target.itemId)).toHaveLength(0)

      yield* instances.publishVersion({ instanceId: src.id, expectedVersion: src.version })
      const after = yield* mentions.listBacklinks(target.itemId)
      expect(after).toHaveLength(1)
      expect(after[0]!.source).toBe("record")
      expect(after[0]!.fromItemId).toBe(src.itemId)
      expect(after[0]!.fromFieldId).toBe(body.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("THE DEDUPE GUARD: two published versions of one source are one backlink", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const mentions = yield* MentionService
      const c = yield* concepts.create({ name: "Page" })
      yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })

      const target = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.publishVersion({ instanceId: target.id, expectedVersion: target.version })

      const v1 = yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: envelope({ kind: "record", targetId: target.itemId, label: "T" }) },
      })
      yield* instances.publishVersion({ instanceId: v1.id, expectedVersion: v1.version })
      // A second published version of the SAME lineage, carrying the same mention
      // (newVersion clones the head's state). Both rows match the target, so
      // without the DISTINCT ON the panel would list this one source twice.
      const draft = yield* instances.newVersion({ itemId: v1.itemId })
      yield* instances.publishVersion({ instanceId: draft.id, expectedVersion: draft.version })

      const links = yield* mentions.listBacklinks(target.itemId)
      expect(links).toHaveLength(1)
      expect(links[0]!.fromItemId).toBe(v1.itemId)
      // …and it is the NEWEST version that represents the lineage.
      expect(links[0]!.fromInstanceId).toBe(draft.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("indexes a task description, and archiving the task withdraws it", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const annotations = yield* AnnotationService
      const mentions = yield* MentionService
      const c = yield* concepts.create({ name: "Page" })
      const target = yield* instances.create({ conceptId: c.id, fields: {} })

      const task = yield* annotations.createTask({
        subjectId: null,
        title: "Follow up",
        description: envelope({ kind: "record", targetId: target.itemId, label: "Acme" }),
      })
      const links = yield* mentions.listBacklinks(target.itemId)
      expect(links).toHaveLength(1)
      expect(links[0]!.source).toBe("task")
      expect(links[0]!.fromAnnotationId).toBe(task.id)

      yield* annotations.archiveTask(task.id, task.version)
      expect(yield* mentions.listBacklinks(target.itemId)).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purging the mentioned record does not leave a dangling FK", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Page" })
      const body = yield* fields.addField({ conceptId: c.id, name: "body", kind: "richtext" })
      const target = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.create({
        conceptId: c.id,
        fields: { [body.id]: envelope({ kind: "record", targetId: target.itemId, label: "T" }) },
      })
      // The inbound row holds an FK to the lineage; purging the last version
      // deletes the item, which would fail unless that row goes first.
      yield* instances.purge({ instanceId: target.id })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
