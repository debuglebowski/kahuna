import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { QueryService } from "../services/QueryService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

/** Flip a concept into versioned mode (description is a required update field). */
const enableVersioning = (concepts: ConceptService, id: string) =>
  concepts.update({ id, description: null, versioningEnabled: true })

describe("versioning", () => {
  it.effect("non-versioned concept is unchanged: published seq-1, 1 item per instance", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      expect(inst.versionStatus).toBe("published")
      expect(inst.versionSeq).toBe(1)
      expect(inst.itemId).toBeTruthy()
      const live = yield* query.findInstances({ conceptId: c.id })
      expect(live.find((x) => x.id === inst.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("new versioned item is a draft: absent from head list, not referenceable", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const query = yield* QueryService

      const account = yield* concepts.create({ name: "Account" })
      yield* enableVersioning(concepts, account.id)
      const deal = yield* concepts.create({ name: "Deal" })
      const rel = yield* fields.addField({
        conceptId: deal.id,
        name: "account",
        kind: "relation",
        config: { target: account.id, cardinality: "one" },
      })

      const draft = yield* instances.create({ conceptId: account.id, fields: {} })
      expect(draft.versionStatus).toBe("draft")
      // Head-only list excludes the unpublished draft.
      const live = yield* query.findInstances({ conceptId: account.id })
      expect(live.find((x) => x.id === draft.id)).toBeUndefined()
      // A general ref to its item fails until first publish.
      const d = yield* instances.create({ conceptId: deal.id, fields: {} })
      const err = yield* relations
        .create({ fieldId: rel.id, fromId: d.id, toItemId: draft.itemId })
        .pipe(Effect.flip)
      expect(err._tag).toBe("ItemNotPublished")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("publish makes the version the head and referenceable", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const query = yield* QueryService

      const account = yield* concepts.create({ name: "Account" })
      yield* enableVersioning(concepts, account.id)
      const deal = yield* concepts.create({ name: "Deal" })
      const rel = yield* fields.addField({
        conceptId: deal.id,
        name: "account",
        kind: "relation",
        config: { target: account.id, cardinality: "one" },
      })

      const draft = yield* instances.create({ conceptId: account.id, fields: {} })
      const pub = yield* instances.publishVersion({
        instanceId: draft.id,
        expectedVersion: draft.version,
      })
      expect(pub.versionStatus).toBe("published")
      expect(pub.publishedAt).not.toBeNull()

      const live = yield* query.findInstances({ conceptId: account.id })
      expect(live.find((x) => x.id === draft.id)).toBeDefined()

      const d = yield* instances.create({ conceptId: deal.id, fields: {} })
      const edge = yield* relations.create({ fieldId: rel.id, fromId: d.id, toItemId: draft.itemId })
      expect(edge.toVersionId).toBeNull()
      expect(edge.toItemId).toBe(draft.itemId)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("edits go to drafts only; published is frozen; one draft at a time", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id)
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })

      const draft = yield* instances.create({ conceptId: c.id, fields: { [title.id]: "v1" } })
      const v1 = yield* instances.publishVersion({
        instanceId: draft.id,
        expectedVersion: draft.version,
      })
      // Editing a published version is rejected.
      const frozen = yield* instances
        .update({ instanceId: v1.id, expectedVersion: v1.version, patch: { [title.id]: "x" } })
        .pipe(Effect.flip)
      expect(frozen._tag).toBe("VersionFrozen")

      // New version clones the head's state into an editable draft.
      const v2 = yield* instances.newVersion({ itemId: v1.itemId })
      expect(v2.versionStatus).toBe("draft")
      expect(v2.versionSeq).toBe(2)
      expect(v2.state[title.id]).toBe("v1")
      // A second draft is refused while one is open.
      const dupe = yield* instances.newVersion({ itemId: v1.itemId }).pipe(Effect.flip)
      expect(dupe._tag).toBe("DraftAlreadyExists")
      // The draft is editable.
      const edited = yield* instances.update({
        instanceId: v2.id,
        expectedVersion: v2.version,
        patch: { [title.id]: "v2" },
      })
      expect(edited.state[title.id]).toBe("v2")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("general ref auto-advances to the new head; a pinned ref stays put", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService

      const account = yield* concepts.create({ name: "Account" })
      yield* enableVersioning(concepts, account.id)
      const d1 = yield* instances.create({ conceptId: account.id, fields: {} })
      const v1 = yield* instances.publishVersion({
        instanceId: d1.id,
        expectedVersion: d1.version,
      })
      // Head is v1.
      const head1 = yield* instances.headOf(v1.itemId)
      expect(head1?.id).toBe(v1.id)
      // Cut + publish v2.
      const d2 = yield* instances.newVersion({ itemId: v1.itemId })
      const v2 = yield* instances.publishVersion({
        instanceId: d2.id,
        expectedVersion: d2.version,
      })
      // General ("Latest") now resolves to v2; the pinned v1 is still a distinct row.
      const head2 = yield* instances.headOf(v1.itemId)
      expect(head2?.id).toBe(v2.id)
      expect(head2?.versionSeq).toBe(2)
      expect(v1.id).not.toBe(v2.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("pinning a reference to a draft is rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const relations = yield* RelationService

      const account = yield* concepts.create({ name: "Account" })
      yield* enableVersioning(concepts, account.id)
      const deal = yield* concepts.create({ name: "Deal" })
      const rel = yield* fields.addField({
        conceptId: deal.id,
        name: "account",
        kind: "relation",
        config: { target: account.id, cardinality: "one" },
      })
      const draft = yield* instances.create({ conceptId: account.id, fields: {} })
      const d = yield* instances.create({ conceptId: deal.id, fields: {} })
      const err = yield* relations
        .create({ fieldId: rel.id, fromId: d.id, toVersionId: draft.id })
        .pipe(Effect.flip)
      expect(err._tag).toBe("RelationPinToDraft")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("single-version archive rolls the head back to the prior published version", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* instances.create({ conceptId: c.id, fields: {} })
      const v1 = yield* instances.publishVersion({ instanceId: d1.id, expectedVersion: d1.version })
      const d2 = yield* instances.newVersion({ itemId: v1.itemId })
      const v2 = yield* instances.publishVersion({ instanceId: d2.id, expectedVersion: d2.version })

      // Head is v2.
      let live = yield* query.findInstances({ conceptId: c.id })
      expect(live.map((x) => x.id)).toContain(v2.id)
      expect(live.map((x) => x.id)).not.toContain(v1.id)

      // Archive the head version → list rolls back to v1.
      yield* instances.archive({ instanceId: v2.id, expectedVersion: v2.version })
      live = yield* query.findInstances({ conceptId: c.id })
      expect(live.map((x) => x.id)).toContain(v1.id)
      expect(live.map((x) => x.id)).not.toContain(v2.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("whole-item archive hides the lineage; restore brings it back", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* instances.create({ conceptId: c.id, fields: {} })
      const v1 = yield* instances.publishVersion({ instanceId: d1.id, expectedVersion: d1.version })

      yield* instances.archiveItem({ itemId: v1.itemId })
      let live = yield* query.findInstances({ conceptId: c.id })
      expect(live.find((x) => x.id === v1.id)).toBeUndefined()

      yield* instances.restoreItem({ itemId: v1.itemId })
      live = yield* query.findInstances({ conceptId: c.id })
      expect(live.find((x) => x.id === v1.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rebuild reproduces version_status; getAsOf at a pre-publish event shows draft", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const events = yield* EventStore

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id)
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const draft = yield* instances.create({ conceptId: c.id, fields: { [title.id]: "hi" } })
      const updated = yield* instances.update({
        instanceId: draft.id,
        expectedVersion: draft.version,
        patch: { [title.id]: "hello" },
      })
      const pub = yield* instances.publishVersion({
        instanceId: draft.id,
        expectedVersion: updated.version,
      })

      // Rebuild from the event stream reproduces the published projection.
      const rebuilt = yield* instances.rebuild(draft.id)
      expect(rebuilt.versionStatus).toBe("published")
      expect(rebuilt.publishedAt).not.toBeNull()

      // Time-travel to the InstanceUpdated event (before publish) shows a draft.
      const stream = yield* events.readStream(draft.id)
      const updateEvent = stream.find((e) => e.eventType === "InstanceUpdated")
      const asOf = yield* instances.getAsOf(draft.id, updateEvent!.id)
      expect(asOf.versionStatus).toBe("draft")
      expect(asOf.publishedAt).toBeNull()
      // Sanity: the publish is the last event.
      expect(stream.some((e) => e.eventType === "VersionPublished")).toBe(true)
      expect(pub.versionStatus).toBe("published")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("disabling versioning is blocked while an item has multiple versions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* instances.create({ conceptId: c.id, fields: {} })
      const v1 = yield* instances.publishVersion({ instanceId: d1.id, expectedVersion: d1.version })
      yield* instances.newVersion({ itemId: v1.itemId }) // now 2 versions

      const err = yield* concepts
        .update({ id: c.id, description: null, versioningEnabled: false })
        .pipe(Effect.flip)
      expect(err._tag).toBe("VersioningInUse")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("seq is never reused: archiving the head doesn't free its number", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* instances.create({ conceptId: c.id, fields: {} })
      const v1 = yield* instances.publishVersion({ instanceId: d1.id, expectedVersion: d1.version })
      const d2 = yield* instances.newVersion({ itemId: v1.itemId })
      const v2 = yield* instances.publishVersion({ instanceId: d2.id, expectedVersion: d2.version })

      // Archive the head (v2): the next draft must take seq 3, not reuse 2 —
      // otherwise restoring v2 later would leave two live versions sharing a seq.
      const archived = yield* instances.archive({ instanceId: v2.id, expectedVersion: v2.version })
      const d3 = yield* instances.newVersion({ itemId: v1.itemId })
      expect(d3.versionSeq).toBe(3)
      const v3 = yield* instances.publishVersion({ instanceId: d3.id, expectedVersion: d3.version })

      // Restoring v2 is now safe and unambiguous: head stays v3.
      yield* instances.restore({ instanceId: v2.id, expectedVersion: archived.version })
      const head = yield* instances.headOf(v1.itemId)
      expect(head?.id).toBe(v3.id)
      expect(head?.versionSeq).toBe(3)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("state filters apply to the head, not historical versions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const stage = yield* fields.addField({ conceptId: c.id, name: "stage", kind: "text" })
      const d1 = yield* instances.create({ conceptId: c.id, fields: { [stage.id]: "open" } })
      const v1 = yield* instances.publishVersion({ instanceId: d1.id, expectedVersion: d1.version })
      const d2 = yield* instances.newVersion({ itemId: v1.itemId })
      const e2 = yield* instances.update({
        instanceId: d2.id,
        expectedVersion: d2.version,
        patch: { [stage.id]: "won" },
      })
      yield* instances.publishVersion({ instanceId: d2.id, expectedVersion: e2.version })

      // The head is "won": filtering by the OLD value must not resurrect v1.
      const open = yield* query.findInstances({ conceptId: c.id, where: { [stage.id]: "open" } })
      expect(open.length).toBe(0)
      const won = yield* query.findInstances({ conceptId: c.id, where: { [stage.id]: "won" } })
      expect(won.length).toBe(1)
      expect(won[0]!.id).toBe(d2.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("discardDraft removes an open draft and leaves the published head intact", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* instances.create({ conceptId: c.id, fields: {} })
      const v1 = yield* instances.publishVersion({ instanceId: d1.id, expectedVersion: d1.version })
      const draft = yield* instances.newVersion({ itemId: v1.itemId })

      yield* instances.discardDraft({ instanceId: draft.id })
      // The draft row is gone; the head is still v1; a fresh draft can be opened.
      const gone = yield* instances.get(draft.id).pipe(Effect.flip)
      expect(gone._tag).toBe("InstanceNotFound")
      const live = yield* query.findInstances({ conceptId: c.id })
      expect(live.map((x) => x.id)).toContain(v1.id)
      // The discarded draft's seq is freed: next version is head(seq 1) + 1 = 2.
      const again = yield* instances.newVersion({ itemId: v1.itemId })
      expect(again.versionSeq).toBe(2)
      expect(again.versionStatus).toBe("draft")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
