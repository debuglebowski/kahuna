import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { EditReach } from "../domain/types"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { QueryService } from "../services/QueryService"
import { RecordService } from "../services/RecordService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

/** Flip a concept into versioned mode (description is a required update field).
 *  `reach` defaults to today's behaviour: a published version is frozen. */
const enableVersioning = (concepts: ConceptService, id: string, reach: EditReach = "draft") =>
  concepts.update({ id, description: null, versioningEnabled: true, editReach: reach })

describe("versioning", () => {
  it.effect("non-versioned concept is unchanged: published seq-1, 1 record per recordVersion", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const query = yield* QueryService
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      expect(inst.versionStatus).toBe("published")
      expect(inst.versionSeq).toBe(1)
      expect(inst.recordId).toBeTruthy()
      const live = yield* query.findRecords({ conceptId: c.id })
      expect(live.find((x) => x.id === inst.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("new versioned record is a draft: absent from head list, not referenceable", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
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

      const draft = yield* recordVersions.create({ conceptId: account.id, fields: {} })
      expect(draft.versionStatus).toBe("draft")
      // Head-only list excludes the unpublished draft.
      const live = yield* query.findRecords({ conceptId: account.id })
      expect(live.find((x) => x.id === draft.id)).toBeUndefined()
      // A general ref to its record fails until first publish.
      const d = yield* recordVersions.create({ conceptId: deal.id, fields: {} })
      const err = yield* relations
        .create({ fieldId: rel.id, fromId: d.id, toRecordId: draft.recordId })
        .pipe(Effect.flip)
      expect(err._tag).toBe("RecordNotPublished")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("publish makes the version the head and referenceable", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
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

      const draft = yield* recordVersions.create({ conceptId: account.id, fields: {} })
      const pub = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })
      expect(pub.versionStatus).toBe("published")
      expect(pub.publishedAt).not.toBeNull()

      const live = yield* query.findRecords({ conceptId: account.id })
      expect(live.find((x) => x.id === draft.id)).toBeDefined()

      const d = yield* recordVersions.create({ conceptId: deal.id, fields: {} })
      const edge = yield* relations.create({
        fieldId: rel.id,
        fromId: d.id,
        toRecordId: draft.recordId,
      })
      expect(edge.toVersionId).toBeNull()
      expect(edge.toRecordId).toBe(draft.recordId)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("edits go to drafts only; published is frozen; one draft at a time", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id)
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })

      const draft = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "v1" } })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })
      // Editing a published version is rejected.
      const frozen = yield* recordVersions
        .update({ recordVersionId: v1.id, expectedVersion: v1.version, patch: { [title.id]: "x" } })
        .pipe(Effect.flip)
      expect(frozen._tag).toBe("VersionFrozen")

      // New version clones the head's state into an editable draft.
      const v2 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      expect(v2.versionStatus).toBe("draft")
      expect(v2.versionSeq).toBe(2)
      expect(v2.state[title.id]).toBe("v1")
      // A second draft is refused while one is open.
      const dupe = yield* recordVersions.newVersion({ recordId: v1.recordId }).pipe(Effect.flip)
      expect(dupe._tag).toBe("DraftAlreadyExists")
      // The draft is editable.
      const edited = yield* recordVersions.update({
        recordVersionId: v2.id,
        expectedVersion: v2.version,
        patch: { [title.id]: "v2" },
      })
      expect(edited.state[title.id]).toBe("v2")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("general ref auto-advances to the new head; a pinned ref stays put", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService

      const account = yield* concepts.create({ name: "Account" })
      yield* enableVersioning(concepts, account.id)
      const d1 = yield* recordVersions.create({ conceptId: account.id, fields: {} })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      // Head is v1.
      const head1 = yield* recordVersions.headOf(v1.recordId)
      expect(head1?.id).toBe(v1.id)
      // Cut + publish v2.
      const d2 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      const v2 = yield* recordVersions.publishVersion({
        recordVersionId: d2.id,
        expectedVersion: d2.version,
      })
      // General ("Latest") now resolves to v2; the pinned v1 is still a distinct row.
      const head2 = yield* recordVersions.headOf(v1.recordId)
      expect(head2?.id).toBe(v2.id)
      expect(head2?.versionSeq).toBe(2)
      expect(v1.id).not.toBe(v2.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("pinning a reference to a draft is rejected", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
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
      const draft = yield* recordVersions.create({ conceptId: account.id, fields: {} })
      const d = yield* recordVersions.create({ conceptId: deal.id, fields: {} })
      const err = yield* relations
        .create({ fieldId: rel.id, fromId: d.id, toVersionId: draft.id })
        .pipe(Effect.flip)
      expect(err._tag).toBe("RelationPinToDraft")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("single-version archive rolls the head back to the prior published version", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const d2 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      const v2 = yield* recordVersions.publishVersion({
        recordVersionId: d2.id,
        expectedVersion: d2.version,
      })

      // Head is v2.
      let live = yield* query.findRecords({ conceptId: c.id })
      expect(live.map((x) => x.id)).toContain(v2.id)
      expect(live.map((x) => x.id)).not.toContain(v1.id)

      // Archive the head version → list rolls back to v1.
      yield* recordVersions.archive({ recordVersionId: v2.id, expectedVersion: v2.version })
      live = yield* query.findRecords({ conceptId: c.id })
      expect(live.map((x) => x.id)).toContain(v1.id)
      expect(live.map((x) => x.id)).not.toContain(v2.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("whole-record archive hides the lineage; restore brings it back", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })

      yield* recordVersions.archiveRecord({ recordId: v1.recordId })
      let live = yield* query.findRecords({ conceptId: c.id })
      expect(live.find((x) => x.id === v1.id)).toBeUndefined()

      yield* recordVersions.restoreRecord({ recordId: v1.recordId })
      live = yield* query.findRecords({ conceptId: c.id })
      expect(live.find((x) => x.id === v1.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rebuild reproduces version_status; getAsOf at a pre-publish event shows draft", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const events = yield* EventStore

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id)
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const draft = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "hi" } })
      const updated = yield* recordVersions.update({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        patch: { [title.id]: "hello" },
      })
      const pub = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: updated.version,
      })

      // Rebuild from the event stream reproduces the published projection.
      const rebuilt = yield* recordVersions.rebuild(draft.id)
      expect(rebuilt.versionStatus).toBe("published")
      expect(rebuilt.publishedAt).not.toBeNull()

      // Time-travel to the RecordVersionUpdated event (before publish) shows a draft.
      const stream = yield* events.readStream(draft.id)
      const updateEvent = stream.find((e) => e.eventType === "RecordVersionUpdated")
      const asOf = yield* recordVersions.getAsOf(draft.id, updateEvent!.id)
      expect(asOf.versionStatus).toBe("draft")
      expect(asOf.publishedAt).toBeNull()
      // Sanity: the publish is the last event.
      expect(stream.some((e) => e.eventType === "VersionPublished")).toBe(true)
      expect(pub.versionStatus).toBe("published")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("disabling versioning is blocked while a record has multiple versions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      yield* recordVersions.newVersion({ recordId: v1.recordId }) // now 2 versions

      const err = yield* concepts
        .update({ id: c.id, description: null, versioningEnabled: false })
        .pipe(Effect.flip)
      expect(err._tag).toBe("VersioningInUse")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("seq is never reused: archiving the head doesn't free its number", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const d2 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      const v2 = yield* recordVersions.publishVersion({
        recordVersionId: d2.id,
        expectedVersion: d2.version,
      })

      // Archive the head (v2): the next draft must take seq 3, not reuse 2 —
      // otherwise restoring v2 later would leave two live versions sharing a seq.
      const archived = yield* recordVersions.archive({
        recordVersionId: v2.id,
        expectedVersion: v2.version,
      })
      const d3 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      expect(d3.versionSeq).toBe(3)
      const v3 = yield* recordVersions.publishVersion({
        recordVersionId: d3.id,
        expectedVersion: d3.version,
      })

      // Restoring v2 is now safe and unambiguous: head stays v3.
      yield* recordVersions.restore({ recordVersionId: v2.id, expectedVersion: archived.version })
      const head = yield* recordVersions.headOf(v1.recordId)
      expect(head?.id).toBe(v3.id)
      expect(head?.versionSeq).toBe(3)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("state filters apply to the head, not historical versions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const stage = yield* fields.addField({ conceptId: c.id, name: "stage", kind: "text" })
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: { [stage.id]: "open" } })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const d2 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      const e2 = yield* recordVersions.update({
        recordVersionId: d2.id,
        expectedVersion: d2.version,
        patch: { [stage.id]: "won" },
      })
      yield* recordVersions.publishVersion({ recordVersionId: d2.id, expectedVersion: e2.version })

      // The head is "won": filtering by the OLD value must not resurrect v1.
      const open = yield* query.findRecords({ conceptId: c.id, where: { [stage.id]: "open" } })
      expect(open.length).toBe(0)
      const won = yield* query.findRecords({ conceptId: c.id, where: { [stage.id]: "won" } })
      expect(won.length).toBe(1)
      expect(won[0]!.id).toBe(d2.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("discardDraft removes an open draft and leaves the published head intact", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Doc" })
      yield* enableVersioning(concepts, c.id)
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const draft = yield* recordVersions.newVersion({ recordId: v1.recordId })

      yield* recordVersions.discardDraft({ recordVersionId: draft.id })
      // The draft row is gone; the head is still v1; a fresh draft can be opened.
      const gone = yield* recordVersions.get(draft.id).pipe(Effect.flip)
      expect(gone._tag).toBe("RecordVersionNotFound")
      const live = yield* query.findRecords({ conceptId: c.id })
      expect(live.map((x) => x.id)).toContain(v1.id)
      // The discarded draft's seq is freed: next version is head(seq 1) + 1 = 2.
      const again = yield* recordVersions.newVersion({ recordId: v1.recordId })
      expect(again.versionSeq).toBe(2)
      expect(again.versionStatus).toBe("draft")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("reach 'any': a published version is amendable in place, seq unchanged", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const events = yield* EventStore

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id, "any")
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const draft = yield* recordVersions.create({
        conceptId: c.id,
        fields: { [title.id]: "teh spec" },
      })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })

      // The typo fix lands on v1 itself — no v2, same seq, still published.
      const fixed = yield* recordVersions.update({
        recordVersionId: v1.id,
        expectedVersion: v1.version,
        patch: { [title.id]: "the spec" },
      })
      expect(fixed.state[title.id]).toBe("the spec")
      expect(fixed.versionSeq).toBe(1)
      expect(fixed.versionStatus).toBe("published")
      expect(fixed.publishedAt).not.toBeNull()
      expect(fixed.version).toBe(v1.version + 1)

      // The write is tagged as an amendment, not an ordinary edit.
      const stream = yield* events.readStream(v1.id)
      expect(stream.some((e) => e.eventType === "VersionAmended")).toBe(true)
      // The pre-publish draft edit is a plain RecordVersionUpdated; the amendment isn't.
      expect(stream.filter((e) => e.eventType === "VersionAmended").length).toBe(1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an amendment survives rebuild and getAsOf still shows the pre-fix value", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const events = yield* EventStore

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id, "any")
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const draft = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "old" } })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })
      yield* recordVersions.update({
        recordVersionId: v1.id,
        expectedVersion: v1.version,
        patch: { [title.id]: "new" },
      })

      // The reducer must fold VersionAmended on replay too, or the row stops loading.
      const rebuilt = yield* recordVersions.rebuild(v1.id)
      expect(rebuilt.state[title.id]).toBe("new")
      expect(rebuilt.versionStatus).toBe("published")
      expect(rebuilt.publishedAt).not.toBeNull()

      // Amendments are recoverable history: as-of the publish, the old value stands.
      const stream = yield* events.readStream(v1.id)
      const publishEvent = stream.find((e) => e.eventType === "VersionPublished")
      const asOf = yield* recordVersions.getAsOf(v1.id, publishEvent!.id)
      expect(asOf.state[title.id]).toBe("old")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("amending a superseded version doesn't move the head", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const query = yield* QueryService

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id, "any")
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "v1" } })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const d2 = yield* recordVersions.newVersion({ recordId: v1.recordId })
      const e2 = yield* recordVersions.update({
        recordVersionId: d2.id,
        expectedVersion: d2.version,
        patch: { [title.id]: "v2" },
      })
      const v2 = yield* recordVersions.publishVersion({
        recordVersionId: d2.id,
        expectedVersion: e2.version,
      })

      // Amend the OLD version: it's not the head, and amending must not make it one.
      yield* recordVersions.update({
        recordVersionId: v1.id,
        expectedVersion: v1.version,
        patch: { [title.id]: "v1 fixed" },
      })
      const head = yield* recordVersions.headOf(v1.recordId)
      expect(head?.id).toBe(v2.id)
      const live = yield* query.findRecords({ conceptId: c.id })
      expect(live.map((x) => x.id)).toEqual([v2.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("reach 'any' on a NON-versioned concept changes nothing (plain edit)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const events = yield* EventStore

      // Non-versioned rows are 'published' too, so the tag must key off versioning.
      const c = yield* concepts.create({ name: "Lead" })
      yield* concepts.update({ id: c.id, description: null, editReach: "any" })
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "a" } })
      yield* recordVersions.update({
        recordVersionId: inst.id,
        expectedVersion: inst.version,
        patch: { [title.id]: "b" },
      })
      const stream = yield* events.readStream(inst.id)
      expect(stream.some((e) => e.eventType === "RecordVersionUpdated")).toBe(true)
      expect(stream.some((e) => e.eventType === "VersionAmended")).toBe(false)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("reach 'any' → 'draft' re-freezes published versions", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id, "any")
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "v1" } })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const fixed = yield* recordVersions.update({
        recordVersionId: v1.id,
        expectedVersion: v1.version,
        patch: { [title.id]: "v1 fixed" },
      })

      // Downgrading reach is not "versioning in use" — that guard is versioning→off only.
      yield* enableVersioning(concepts, c.id, "draft")
      const frozen = yield* recordVersions
        .update({
          recordVersionId: v1.id,
          expectedVersion: fixed.version,
          patch: { [title.id]: "x" },
        })
        .pipe(Effect.flip)
      expect(frozen._tag).toBe("VersionFrozen")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "a published version's links follow reach: frozen under 'draft', open under 'any'",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const recordVersions = yield* RecordService
        const relations = yield* RelationService

        // Deal (versioned, the link SOURCE) → Account (the target).
        const account = yield* concepts.create({ name: "Account" })
        const deal = yield* concepts.create({ name: "Deal" })
        yield* enableVersioning(concepts, deal.id)
        const rel = yield* fields.addField({
          conceptId: deal.id,
          name: "account",
          kind: "relation",
          config: { target: account.id, cardinality: "many" },
        })
        const a = yield* recordVersions.create({ conceptId: account.id, fields: {} })
        const d1 = yield* recordVersions.create({ conceptId: deal.id, fields: {} })
        const v1 = yield* recordVersions.publishVersion({
          recordVersionId: d1.id,
          expectedVersion: d1.version,
        })

        // Under 'draft' the published source's links are frozen — an API-level guard,
        // not just a hidden button.
        const err = yield* relations
          .create({ fieldId: rel.id, fromId: v1.id, toRecordId: a.recordId })
          .pipe(Effect.flip)
        expect(err._tag).toBe("VersionFrozen")

        // Under 'any' the same calls go through, in both directions.
        yield* enableVersioning(concepts, deal.id, "any")
        const edge = yield* relations.create({
          fieldId: rel.id,
          fromId: v1.id,
          toRecordId: a.recordId,
        })
        yield* relations.remove({ relationId: edge.id })
        const left = yield* relations.listFrom(v1.id)
        expect(left.length).toBe(0)

        // Flipping back re-freezes removal too.
        const edge2 = yield* relations.create({
          fieldId: rel.id,
          fromId: v1.id,
          toRecordId: a.recordId,
        })
        yield* enableVersioning(concepts, deal.id, "draft")
        const rmErr = yield* relations.remove({ relationId: edge2.id }).pipe(Effect.flip)
        expect(rmErr._tag).toBe("VersionFrozen")
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an amended version still can't be re-published", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService

      const c = yield* concepts.create({ name: "Spec" })
      yield* enableVersioning(concepts, c.id, "any")
      const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const d1 = yield* recordVersions.create({ conceptId: c.id, fields: { [title.id]: "v1" } })
      const v1 = yield* recordVersions.publishVersion({
        recordVersionId: d1.id,
        expectedVersion: d1.version,
      })
      const fixed = yield* recordVersions.update({
        recordVersionId: v1.id,
        expectedVersion: v1.version,
        patch: { [title.id]: "v1 fixed" },
      })

      // Amendable ≠ unpublished: publish stays once-only, so publishedAt is stable.
      const err = yield* recordVersions
        .publishVersion({ recordVersionId: v1.id, expectedVersion: fixed.version })
        .pipe(Effect.flip)
      expect(err._tag).toBe("VersionFrozen")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
