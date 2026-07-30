import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { QueryService } from "../services/QueryService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

describe("instance archive / restore / purge", () => {
  it.effect("archive hides from queries; includeArchived surfaces it; restore round-trips", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })

      const archived = yield* instances.archive({
        instanceId: inst.id,
        expectedVersion: inst.version,
      })
      expect(archived.archivedAt).not.toBeNull()
      expect(archived.version).toBe(inst.version + 1)

      // Live query excludes it; get() 404s; includeArchived surfaces it.
      const live = yield* query.findInstances({ conceptId: c.id })
      expect(live.find((x) => x.id === inst.id)).toBeUndefined()
      const notFound = yield* instances.get(inst.id).pipe(Effect.flip)
      expect(notFound._tag).toBe("InstanceNotFound")
      const all = yield* query.findInstances({ conceptId: c.id, includeArchived: true })
      expect(all.find((x) => x.id === inst.id)).toBeDefined()

      const restored = yield* instances.restore({
        instanceId: inst.id,
        expectedVersion: archived.version,
      })
      expect(restored.archivedAt).toBeNull()
      expect(restored.version).toBe(archived.version + 1)
      const liveAgain = yield* query.findInstances({ conceptId: c.id })
      expect(liveAgain.find((x) => x.id === inst.id)).toBeDefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rebuild reproduces the archived→restored projection from the event stream", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Lead" })
      const f = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
      const inst = yield* instances.create({ conceptId: c.id, fields: { [f.id]: "hi" } })
      const a = yield* instances.archive({ instanceId: inst.id, expectedVersion: inst.version })
      const r = yield* instances.restore({ instanceId: inst.id, expectedVersion: a.version })

      const rebuilt = yield* instances.rebuild(inst.id)
      expect(rebuilt.archivedAt).toBeNull()
      expect(rebuilt.version).toBe(r.version)
      expect(rebuilt.state).toEqual({ [f.id]: "hi" })
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("restore on a live instance fails InstanceNotFound", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      const err = yield* instances
        .restore({ instanceId: inst.id, expectedVersion: inst.version })
        .pipe(Effect.flip)
      expect(err._tag).toBe("InstanceNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purge removes the row permanently but keeps the event history", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService
      const events = yield* EventStore
      const c = yield* concepts.create({ name: "Lead" })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* instances.purge({ instanceId: inst.id })
      const all = yield* query.findInstances({ conceptId: c.id, includeArchived: true })
      expect(all.find((x) => x.id === inst.id)).toBeUndefined()
      // The event log survives as an audit trail (InstanceCreated + InstancePurged).
      const stream = yield* events.readStream(inst.id)
      expect(stream.length).toBeGreaterThanOrEqual(2)
      expect(stream.some((e) => e.eventType === "InstancePurged")).toBe(true)
      // A second purge can't find the (now-gone) row.
      const gone = yield* instances.purge({ instanceId: inst.id }).pipe(Effect.flip)
      expect(gone._tag).toBe("InstanceNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purge is refused while a relation edge references the instance (InstanceInUse)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const account = yield* concepts.create({ name: "Account" })
      const deal = yield* concepts.create({ name: "Deal" })
      const rel = yield* fields.addField({
        conceptId: deal.id,
        name: "account",
        kind: "relation",
        config: { target: account.id, cardinality: "one" },
      })
      const acc = yield* instances.create({ conceptId: account.id, fields: {} })
      const d = yield* instances.create({ conceptId: deal.id, fields: {} })
      yield* relations.create({ fieldId: rel.id, fromId: d.id, toId: acc.id })
      // `acc` is the `to` of a live relation → can't be purged.
      const err = yield* instances.purge({ instanceId: acc.id }).pipe(Effect.flip)
      expect(err._tag).toBe("InstanceInUse")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
