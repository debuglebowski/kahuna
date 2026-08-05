import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { QueryService } from "../services/QueryService"
import { RecordService } from "../services/RecordService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

describe("recordVersion archive / restore / purge", () => {
  it.effect("archive hides from queries; includeArchived surfaces it; restore round-trips", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const query = yield* QueryService
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })

      const archived = yield* recordVersions.archive({
        recordVersionId: inst.id,
        expectedVersion: inst.version,
      })
      expect(archived.archivedAt).not.toBeNull()
      expect(archived.version).toBe(inst.version + 1)

      // Live query excludes it; get() 404s; includeArchived surfaces it.
      const live = yield* query.findRecords({ conceptId: c.id })
      expect(live.find((x) => x.id === inst.id)).toBeUndefined()
      const notFound = yield* recordVersions.get(inst.id).pipe(Effect.flip)
      expect(notFound._tag).toBe("RecordVersionNotFound")
      const all = yield* query.findRecords({ conceptId: c.id, includeArchived: true })
      expect(all.find((x) => x.id === inst.id)).toBeDefined()

      const restored = yield* recordVersions.restore({
        recordVersionId: inst.id,
        expectedVersion: archived.version,
      })
      expect(restored.archivedAt).toBeNull()
      expect(restored.version).toBe(archived.version + 1)
      const liveAgain = yield* query.findRecords({ conceptId: c.id })
      expect(liveAgain.find((x) => x.id === inst.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rebuild reproduces the archived→restored projection from the event stream", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Lead" })
      const f = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: { [f.id]: "hi" } })
      const a = yield* recordVersions.archive({
        recordVersionId: inst.id,
        expectedVersion: inst.version,
      })
      const r = yield* recordVersions.restore({
        recordVersionId: inst.id,
        expectedVersion: a.version,
      })

      const rebuilt = yield* recordVersions.rebuild(inst.id)
      expect(rebuilt.archivedAt).toBeNull()
      expect(rebuilt.version).toBe(r.version)
      expect(rebuilt.state).toEqual({ [f.id]: "hi" })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("restore on a live recordVersion fails RecordVersionNotFound", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const err = yield* recordVersions
        .restore({ recordVersionId: inst.id, expectedVersion: inst.version })
        .pipe(Effect.flip)
      expect(err._tag).toBe("RecordVersionNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purge removes the row permanently but keeps the event history", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const recordVersions = yield* RecordService
      const query = yield* QueryService
      const events = yield* EventStore
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      yield* recordVersions.purge({ recordVersionId: inst.id })
      const all = yield* query.findRecords({ conceptId: c.id, includeArchived: true })
      expect(all.find((x) => x.id === inst.id)).toBeUndefined()
      // The event log survives as an audit trail (RecordVersionCreated + RecordVersionPurged).
      const stream = yield* events.readStream(inst.id)
      expect(stream.length).toBeGreaterThanOrEqual(2)
      expect(stream.some((e) => e.eventType === "RecordVersionPurged")).toBe(true)
      // A second purge can't find the (now-gone) row.
      const gone = yield* recordVersions.purge({ recordVersionId: inst.id }).pipe(Effect.flip)
      expect(gone._tag).toBe("RecordVersionNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "purge is refused while a relation edge references the recordVersion (RecordVersionInUse)",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const recordVersions = yield* RecordService
        const relations = yield* RelationService
        const account = yield* concepts.create({ name: "Account" })
        const deal = yield* concepts.create({ name: "Deal" })
        const rel = yield* fields.addField({
          conceptId: deal.id,
          name: "account",
          kind: "relation",
          config: { target: account.id, cardinality: "one" },
        })
        const acc = yield* recordVersions.create({ conceptId: account.id, fields: {} })
        const d = yield* recordVersions.create({ conceptId: deal.id, fields: {} })
        yield* relations.create({ fieldId: rel.id, fromId: d.id, toId: acc.id })
        // `acc` is the `to` of a live relation → can't be purged.
        const err = yield* recordVersions.purge({ recordVersionId: acc.id }).pipe(Effect.flip)
        expect(err._tag).toBe("RecordVersionInUse")
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
