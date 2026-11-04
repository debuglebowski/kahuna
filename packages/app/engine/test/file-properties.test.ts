import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { unrestrictedPolicy } from "../domain/access"
import { AttachmentService, sweepExpiredStaged } from "../services/AttachmentService"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { OrgContext } from "../services/OrgContext"
import { RecordService } from "../services/RecordService"
import { newOrgId, testLayer } from "./harness"

/**
 * File properties: a `kind: "file"` field whose values are the record's own
 * attachments (linked by `attachments.field_id`), not a second storage location.
 */

const bytes = (s: string) => new TextEncoder().encode(s)

/** A concept with one multi-file and one single-file property, plus a record. */
const seed = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const fields = yield* FieldService
  const records = yield* RecordService
  const concept = yield* concepts.create({ name: "Policy" })
  yield* fields.addField({ conceptId: concept.id, name: "Title", kind: "text" })
  const many = yield* fields.addField({
    conceptId: concept.id,
    name: "Attachments",
    kind: "file",
    config: { multiple: true },
  })
  const one = yield* fields.addField({ conceptId: concept.id, name: "Signed copy", kind: "file" })
  const rv = yield* records.create({ conceptName: "Policy", fields: {} })
  return { concept, many, one, rv }
})

describe("file properties", () => {
  it.effect("multiple is valid on file fields (still not on relation/computed/richtext)", () =>
    Effect.gen(function* () {
      const { many } = yield* seed
      expect(many.config.multiple).toBe(true)
      const fields = yield* FieldService
      const bad = yield* Effect.result(
        fields.addField({
          conceptId: many.conceptId,
          name: "Doc",
          kind: "richtext",
          config: { multiple: true },
        }),
      )
      expect(Result.isFailure(bad)).toBe(true)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a multi-file property takes any number of files, appended in order", () =>
    Effect.gen(function* () {
      const { many, rv } = yield* seed
      const att = yield* AttachmentService
      const up = (name: string) =>
        att.upload({
          owner: { recordId: rv.recordId, fieldId: many.id },
          filename: name,
          data: bytes(name),
        })
      const a = yield* up("a.pdf")
      const b = yield* up("b.pdf")
      const c = yield* up("c.pdf")
      expect([a.fieldId, b.fieldId, c.fieldId]).toEqual([many.id, many.id, many.id])
      expect([a.position, b.position, c.position]).toEqual([0, 1, 2])

      const index = yield* att.fieldFiles({ recordIds: [rv.recordId] })
      expect(
        index
          .get(rv.recordId)
          ?.get(many.id)
          ?.map((f) => f.filename),
      ).toEqual(["a.pdf", "b.pdf", "c.pdf"])
      // Same storage as the Files panel: they're record files, listed there too.
      expect((yield* att.list({ recordId: rv.recordId })).length).toBe(3)

      // The event names the property.
      const events = yield* EventStore
      const stream = yield* events.readStream(a.id)
      expect(stream[0]?.payload).toMatchObject({ _tag: "AttachmentAdded", fieldId: many.id })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("reorder puts the listed ids first; unlisted ones keep their order after", () =>
    Effect.gen(function* () {
      const { many, rv } = yield* seed
      const att = yield* AttachmentService
      const up = (name: string) =>
        att.upload({
          owner: { recordId: rv.recordId, fieldId: many.id },
          filename: name,
          data: bytes(name),
        })
      const a = yield* up("a")
      const b = yield* up("b")
      const c = yield* up("c")
      const out = yield* att.reorder(rv.recordId, many.id, [c.id, a.id])
      expect(out.map((f) => f.filename)).toEqual(["c", "a", "b"])
      const index = yield* att.fieldFiles({ conceptId: rv.conceptId })
      expect(
        index
          .get(rv.recordId)
          ?.get(many.id)
          ?.map((f) => f.id),
      ).toEqual([c.id, a.id, b.id])

      // A file that isn't this property's is refused.
      const loose = yield* att.upload({
        owner: { recordId: rv.recordId },
        filename: "x",
        data: bytes("x"),
      })
      const bad = yield* Effect.result(att.reorder(rv.recordId, many.id, [loose.id]))
      expect(Result.isFailure(bad) && bad.failure._tag).toBe("AttachmentNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a single-file property replaces: the old value is archived, restore swaps back", () =>
    Effect.gen(function* () {
      const { one, rv } = yield* seed
      const att = yield* AttachmentService
      const v1 = yield* att.upload({
        owner: { recordId: rv.recordId, fieldId: one.id },
        filename: "v1.pdf",
        data: bytes("1"),
      })
      const v2 = yield* att.upload({
        owner: { recordId: rv.recordId, fieldId: one.id },
        filename: "v2.pdf",
        data: bytes("2"),
      })
      const live = yield* att.fieldFiles({ recordIds: [rv.recordId] })
      expect(
        live
          .get(rv.recordId)
          ?.get(one.id)
          ?.map((f) => f.id),
      ).toEqual([v2.id])
      // Soft, not lost.
      const all = yield* att.list({ recordId: rv.recordId, includeArchived: true })
      expect(all.find((f) => f.id === v1.id)?.archivedAt).not.toBeNull()

      yield* att.restore(v1.id)
      const after = yield* att.fieldFiles({ recordIds: [rv.recordId] })
      expect(
        after
          .get(rv.recordId)
          ?.get(one.id)
          ?.map((f) => f.id),
      ).toEqual([v1.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("move: loose → property, property → loose; into a single-file property replaces", () =>
    Effect.gen(function* () {
      const { many, one, rv } = yield* seed
      const att = yield* AttachmentService
      const loose = yield* att.upload({
        owner: { recordId: rv.recordId },
        filename: "l",
        data: bytes("l"),
      })
      expect(loose.fieldId).toBeNull()

      const moved = yield* att.move(loose.id, many.id)
      expect(moved.fieldId).toBe(many.id)
      const events = yield* EventStore
      const tags = (yield* events.readStream(loose.id)).map((e) => e.payload)
      expect(tags.at(-1)).toMatchObject({
        _tag: "AttachmentMoved",
        fieldId: many.id,
        fromFieldId: null,
        subjectId: rv.recordId,
      })

      const back = yield* att.move(loose.id, null)
      expect(back.fieldId).toBeNull()

      const current = yield* att.upload({
        owner: { recordId: rv.recordId, fieldId: one.id },
        filename: "cur",
        data: bytes("c"),
      })
      yield* att.move(loose.id, one.id)
      const all = yield* att.list({ recordId: rv.recordId, includeArchived: true })
      expect(all.find((f) => f.id === current.id)?.archivedAt).not.toBeNull()
      expect(all.find((f) => f.id === loose.id)?.archivedAt).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("refuses a field that isn't a live file property of the record's concept", () =>
    Effect.gen(function* () {
      const { concept, rv } = yield* seed
      const fields = yield* FieldService
      const concepts = yield* ConceptService
      const att = yield* AttachmentService
      const tryUpload = (fieldId: string) =>
        Effect.result(
          att.upload({
            owner: { recordId: rv.recordId, fieldId },
            filename: "f",
            data: bytes("f"),
          }),
        )

      const all = yield* fields.listFields(concept.id)
      const title = all.find((f) => f.name === "Title")!
      const notFile = yield* tryUpload(title.id)
      expect(Result.isFailure(notFile) && notFile.failure._tag).toBe("FieldValidationError")

      const other = yield* concepts.create({ name: "Vendor" })
      const foreign = yield* fields.addField({ conceptId: other.id, name: "Docs", kind: "file" })
      const wrongConcept = yield* tryUpload(foreign.id)
      expect(Result.isFailure(wrongConcept) && wrongConcept.failure._tag).toBe("FieldNotFound")

      const synced = yield* fields.addField({
        conceptId: concept.id,
        name: "Synced",
        kind: "file",
        managedBy: "linear",
      })
      const managed = yield* tryUpload(synced.id)
      expect(Result.isFailure(managed) && managed.failure._tag).toBe("FieldValidationError")

      const gone = yield* fields.addField({ conceptId: concept.id, name: "Gone", kind: "file" })
      yield* fields.archive(gone.id)
      const archived = yield* tryUpload(gone.id)
      expect(Result.isFailure(archived) && archived.failure._tag).toBe("FieldNotFound")

      // Nothing leaked into the Files panel from the refused uploads.
      expect((yield* att.list({ recordId: rv.recordId })).length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("file fields stay unwritable through record state", () =>
    Effect.gen(function* () {
      const { many, rv } = yield* seed
      const records = yield* RecordService
      const res = yield* Effect.result(
        records.update({
          recordVersionId: rv.id,
          expectedVersion: rv.version,
          patch: { [many.id]: ["x"] },
        }),
      )
      expect(Result.isFailure(res) && res.failure._tag).toBe("FieldValidationError")
      // An empty list too — it has no element for a per-item check to reject.
      const empty = yield* Effect.result(
        records.update({
          recordVersionId: rv.id,
          expectedVersion: rv.version,
          patch: { [many.id]: [] },
        }),
      )
      expect(Result.isFailure(empty) && empty.failure._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("multiple → single is refused while a record holds more than one file", () =>
    Effect.gen(function* () {
      const { many, rv } = yield* seed
      const att = yield* AttachmentService
      const fields = yield* FieldService
      const a = yield* att.upload({
        owner: { recordId: rv.recordId, fieldId: many.id },
        filename: "a",
        data: bytes("a"),
      })
      yield* att.upload({
        owner: { recordId: rv.recordId, fieldId: many.id },
        filename: "b",
        data: bytes("b"),
      })
      const refused = yield* Effect.result(fields.update({ id: many.id, config: {} }))
      expect(Result.isFailure(refused) && refused.failure._tag).toBe("FieldConfigInvalid")

      yield* att.archive(a.id)
      const ok = yield* fields.update({ id: many.id, config: {} })
      expect(ok.config.multiple).toBeUndefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purging a file property keeps its files, as loose record files", () =>
    Effect.gen(function* () {
      const { many, rv } = yield* seed
      const att = yield* AttachmentService
      const fields = yield* FieldService
      const a = yield* att.upload({
        owner: { recordId: rv.recordId, fieldId: many.id },
        filename: "a",
        data: bytes("a"),
      })
      yield* fields.purge(many.id)
      const files = yield* att.list({ recordId: rv.recordId })
      expect(files.map((f) => [f.id, f.fieldId])).toEqual([[a.id, null]])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  describe("staged uploads + required", () => {
    const stage = (name: string) =>
      Effect.flatMap(AttachmentService, (a) =>
        a.upload({ owner: { staged: true }, filename: name, data: bytes(name) }),
      )
    /** Same org, another person. OrgContext is read per call, so this re-scopes it. */
    const asOther = <A, E, R>(orgId: string, eff: Effect.Effect<A, E, R>) =>
      Effect.provideService(eff, OrgContext, {
        orgId,
        actor: "other",
        role: "system",
        policy: unrestrictedPolicy("other"),
      })
    const requiredConcept = Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const c = yield* concepts.create({ name: "Agreement" })
      const docs = yield* fields.addField({
        conceptId: c.id,
        name: "Contract",
        kind: "file",
        config: { multiple: true, requirement: "required" },
      })
      return { c, docs }
    })

    it.effect(
      "a required file property blocks a create without files and accepts staged ones",
      () =>
        Effect.gen(function* () {
          const { c, docs } = yield* requiredConcept
          const records = yield* RecordService
          const att = yield* AttachmentService

          const bare = yield* Effect.result(records.create({ conceptId: c.id, fields: {} }))
          expect(Result.isFailure(bare) && bare.failure._tag).toBe("FieldValidationError")

          const a = yield* stage("a.pdf")
          const b = yield* stage("b.pdf")
          expect(a.stagedUntil).not.toBeNull()
          expect(a.recordId).toBeNull()
          const rv = yield* records.create({
            conceptId: c.id,
            fields: {},
            files: { [docs.id]: [b.id, a.id] },
          })
          const index = yield* att.fieldFiles({ recordIds: [rv.recordId] })
          expect(
            index
              .get(rv.recordId)
              ?.get(docs.id)
              ?.map((f) => f.filename),
          ).toEqual(["b.pdf", "a.pdf"])
          const claimed = (yield* att.list({ recordId: rv.recordId }))[0]!
          expect(claimed.stagedUntil).toBeNull()

          // The feed gets AttachmentAdded only now, with the record as subject.
          const events = yield* EventStore
          const stream = yield* events.readStream(a.id)
          expect(stream.map((e) => e.payload)).toEqual([
            expect.objectContaining({
              _tag: "AttachmentAdded",
              subjectId: rv.recordId,
              fieldId: docs.id,
            }),
          ])
        }).pipe(Effect.provide(testLayer(newOrgId()))),
    )

    it.effect("the last file of a required property can't be archived, purged or moved out", () =>
      Effect.gen(function* () {
        const { c, docs } = yield* requiredConcept
        const records = yield* RecordService
        const att = yield* AttachmentService
        const a = yield* stage("a.pdf")
        const rv = yield* records.create({
          conceptId: c.id,
          fields: {},
          files: { [docs.id]: [a.id] },
        })

        for (const attempt of [att.archive(a.id), att.purge(a.id), att.move(a.id, null)]) {
          const r = yield* Effect.result(attempt)
          expect(Result.isFailure(r) && r.failure._tag).toBe("FieldValidationError")
        }
        // With a second file, the first may go.
        yield* att.upload({
          owner: { recordId: rv.recordId, fieldId: docs.id },
          filename: "b",
          data: bytes("b"),
        })
        yield* att.archive(a.id)
      }).pipe(Effect.provide(testLayer(newOrgId()))),
    )

    it.effect("publish refuses a draft whose required file property is empty", () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const records = yield* RecordService
        const att = yield* AttachmentService
        const c = yield* concepts.create({ name: "Runbook" })
        yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
        const draft = yield* records.create({ conceptId: c.id, fields: {} })
        // The rule arrives after the draft — publish is where it bites.
        const docs = yield* fields.addField({
          conceptId: c.id,
          name: "Procedure",
          kind: "file",
          config: { requirement: "required" },
        })
        const refused = yield* Effect.result(
          records.publishVersion({ recordVersionId: draft.id, expectedVersion: draft.version }),
        )
        expect(Result.isFailure(refused) && refused.failure._tag).toBe("FieldValidationError")
        yield* att.upload({
          owner: { recordId: draft.recordId, fieldId: docs.id },
          filename: "p",
          data: bytes("p"),
        })
        const published = yield* records.publishVersion({
          recordVersionId: draft.id,
          expectedVersion: draft.version,
        })
        expect(published.versionStatus).toBe("published")
      }).pipe(Effect.provide(testLayer(newOrgId()))),
    )

    it.effect(
      "a staged upload is its uploader's alone: unlisted, unreadable and unclaimable by others",
      () => {
        const orgId = newOrgId()
        return Effect.gen(function* () {
          const { c, docs } = yield* requiredConcept
          const records = yield* RecordService
          const att = yield* AttachmentService
          const mine = yield* stage("mine.pdf")

          expect((yield* att.list()).map((f) => f.id)).not.toContain(mine.id)
          const peek = yield* Effect.result(asOther(orgId, att.get(mine.id)))
          expect(Result.isFailure(peek) && peek.failure._tag).toBe("AttachmentNotFound")
          const fetch = yield* Effect.result(asOther(orgId, att.download(mine.id)))
          expect(Result.isFailure(fetch)).toBe(true)

          const stolen = yield* Effect.result(
            asOther(
              orgId,
              records.create({ conceptId: c.id, fields: {}, files: { [docs.id]: [mine.id] } }),
            ),
          )
          expect(Result.isFailure(stolen) && stolen.failure._tag).toBe("AttachmentNotFound")
          // Rolled back whole: no record was left behind, the upload is still staged.
          const sql = yield* PgClient.PgClient
          const left = yield* sql<{
            n: number
          }>`SELECT COUNT(*)::int AS n FROM records WHERE concept_id = ${c.id}`
          expect(left[0]?.n).toBe(0)
          expect((yield* att.get(mine.id)).stagedUntil).not.toBeNull()
        }).pipe(Effect.provide(testLayer(orgId)))
      },
    )

    it.effect("an expired staged upload can't be claimed, and the sweep removes it", () =>
      Effect.gen(function* () {
        const { c, docs } = yield* requiredConcept
        const records = yield* RecordService
        const att = yield* AttachmentService
        const sql = yield* PgClient.PgClient
        const old = yield* stage("old.pdf")
        yield* sql`UPDATE attachments SET staged_until = now() - interval '1 minute' WHERE id = ${old.id}`

        const late = yield* Effect.result(
          records.create({ conceptId: c.id, fields: {}, files: { [docs.id]: [old.id] } }),
        )
        expect(Result.isFailure(late) && late.failure._tag).toBe("AttachmentNotFound")

        const fresh = yield* stage("fresh.pdf")
        expect(yield* sweepExpiredStaged()).toBeGreaterThanOrEqual(1)
        expect(Result.isFailure(yield* Effect.result(att.get(old.id)))).toBe(true)
        expect((yield* att.get(fresh.id)).id).toBe(fresh.id)
      }).pipe(Effect.provide(testLayer(newOrgId()))),
    )

    it.effect("a single-file property takes at most one staged file", () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const records = yield* RecordService
        const c = yield* concepts.create({ name: "Vendor" })
        const one = yield* fields.addField({ conceptId: c.id, name: "Signed", kind: "file" })
        const a = yield* stage("a")
        const b = yield* stage("b")
        const r = yield* Effect.result(
          records.create({ conceptId: c.id, fields: {}, files: { [one.id]: [a.id, b.id] } }),
        )
        expect(Result.isFailure(r) && r.failure._tag).toBe("FieldValidationError")
      }).pipe(Effect.provide(testLayer(newOrgId()))),
    )
  })
})
