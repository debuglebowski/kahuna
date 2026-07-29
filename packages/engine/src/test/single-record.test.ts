import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { QueryService } from "../services/QueryService"
import { newOrgId, testLayer } from "./harness"

/** Turn a concept into a single-record one, creating its record in the same
 *  transaction. `fields` feeds that record, so a concept with required fields
 *  needs values here. */
const toggleOn = (
  instances: InstanceService,
  conceptId: string,
  fields: Record<string, unknown> = {},
) => instances.setConceptSingleRecord({ conceptId, singleRecord: true, fields })

describe("single-record concepts", () => {
  it.effect("toggling on creates the record; the flag and the record are both live", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Company Settings" })
      expect(c.singleRecord).toBe(false)

      const on = yield* toggleOn(instances, c.id)
      expect(on.singleRecord).toBe(true)
      const record = yield* instances.singleRecordOf(c.id)
      expect(record).not.toBeNull()
      expect(record?.conceptId).toBe(c.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("toggling on is idempotent — a second call creates no second record", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const query = yield* QueryService
      const c = yield* concepts.create({ name: "Settings" })
      yield* toggleOn(instances, c.id)
      const afterFirst = yield* instances.singleRecordOf(c.id)
      const again = yield* toggleOn(instances, c.id)
      expect(again.singleRecord).toBe(true)
      // Exactly one record, and the same one the first toggle made.
      const all = yield* query.findInstances({ conceptId: c.id })
      expect(all).toHaveLength(1)
      expect(all[0]?.id).toBe(afterFirst?.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("toggling on adopts the existing record when the concept already has one", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Settings" })
      const existing = yield* instances.create({ conceptId: c.id, fields: {} })
      yield* toggleOn(instances, c.id)
      const record = yield* instances.singleRecordOf(c.id)
      // Adopted, not duplicated.
      expect(record?.id).toBe(existing.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "toggling on with >1 live record is refused — which would survive isn't ours to pick",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const instances = yield* InstanceService
        const c = yield* concepts.create({ name: "Lead" })
        yield* instances.create({ conceptId: c.id, fields: {} })
        yield* instances.create({ conceptId: c.id, fields: {} })

        const err = yield* toggleOn(instances, c.id).pipe(Effect.flip)
        expect(err._tag).toBe("SingleRecordConflict")
        expect((err as { liveItemCount: number }).liveItemCount).toBe(2)
        // The refusal rolled the flag back with it.
        const after = yield* concepts.getById(c.id)
        expect(after.singleRecord).toBe(false)
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("creating a second record on a single-record concept is refused", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Settings" })
      yield* toggleOn(instances, c.id)

      const err = yield* instances.create({ conceptId: c.id, fields: {} }).pipe(Effect.flip)
      expect(err._tag).toBe("SingleRecordConflict")
      expect((err as { liveItemCount: number }).liveItemCount).toBe(1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("the sole record can be neither archived nor purged", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Settings" })
      yield* toggleOn(instances, c.id)
      const record = yield* instances.singleRecordOf(c.id)
      if (!record) throw new Error("expected a record")

      const archiveErr = yield* instances
        .archive({ instanceId: record.id, expectedVersion: record.version })
        .pipe(Effect.flip)
      expect(archiveErr._tag).toBe("SingleRecordProtected")

      const purgeErr = yield* instances.purge({ instanceId: record.id }).pipe(Effect.flip)
      expect(purgeErr._tag).toBe("SingleRecordProtected")

      // Still there after both refusals.
      const still = yield* instances.singleRecordOf(c.id)
      expect(still?.id).toBe(record.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("archiveItem is guarded too — the lineage path the record header uses", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Settings" })
      yield* toggleOn(instances, c.id)
      const record = yield* instances.singleRecordOf(c.id)
      if (!record) throw new Error("expected a record")

      const err = yield* instances.archiveItem({ itemId: record.itemId }).pipe(Effect.flip)
      expect(err._tag).toBe("SingleRecordProtected")
      const still = yield* instances.singleRecordOf(c.id)
      expect(still?.id).toBe(record.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "a versioned single record resolves while still a draft, and its draft can't be discarded",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const instances = yield* InstanceService
        const c = yield* concepts.create({ name: "Policy" })
        yield* concepts.update({ id: c.id, description: null, versioningEnabled: true })
        yield* toggleOn(instances, c.id)

        // Head-only resolution would miss this: a versioned concept's first record
        // is a draft, never published.
        const record = yield* instances.singleRecordOf(c.id)
        expect(record).not.toBeNull()
        expect(record?.versionStatus).toBe("draft")

        const err = yield* instances
          .discardDraft({ instanceId: record?.id ?? "" })
          .pipe(Effect.flip)
        expect(err._tag).toBe("SingleRecordProtected")
        const still = yield* instances.singleRecordOf(c.id)
        expect(still?.id).toBe(record?.id)
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("toggling off releases the guards and leaves the record an ordinary one", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Settings" })
      yield* toggleOn(instances, c.id)
      const record = yield* instances.singleRecordOf(c.id)
      if (!record) throw new Error("expected a record")

      const off = yield* instances.setConceptSingleRecord({
        conceptId: c.id,
        singleRecord: false,
      })
      expect(off.singleRecord).toBe(false)
      // The record survives the toggle, and is now archivable like any other.
      const archived = yield* instances.archive({
        instanceId: record.id,
        expectedVersion: record.version,
      })
      expect(archived.archivedAt).not.toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "the record's required fields are validated — a short payload rolls the flag back",
    () =>
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const instances = yield* InstanceService
        const c = yield* concepts.create({ name: "Settings" })
        yield* fields.addField({
          conceptId: c.id,
          name: "orgName",
          kind: "text",
          config: { requirement: "required" },
        })

        const err = yield* toggleOn(instances, c.id).pipe(Effect.flip)
        expect(err._tag).toBe("FieldValidationError")
        // One transaction: no flag, no half-made record.
        const after = yield* concepts.getById(c.id)
        expect(after.singleRecord).toBe(false)
        const record = yield* instances.singleRecordOf(c.id)
        expect(record).toBeNull()
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("restore is deliberately unguarded — it's how you recover a bad state", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Settings" })
      const record = yield* instances.create({ conceptId: c.id, fields: {} })
      const archived = yield* instances.archive({
        instanceId: record.id,
        expectedVersion: record.version,
      })
      // An archived record doesn't count as live, so the toggle is legal.
      yield* toggleOn(instances, c.id)
      const created = yield* instances.singleRecordOf(c.id)
      expect(created?.id).not.toBe(record.id)
      // Restoring the old one still works while the flag is on.
      const restored = yield* instances.restore({
        instanceId: record.id,
        expectedVersion: archived.version,
      })
      expect(restored.archivedAt).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
