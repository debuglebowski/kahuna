import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { LABELS_KEY } from "../domain/types"
import { ConceptService } from "../services/ConceptService"
import { InstanceService } from "../services/InstanceService"
import { LabelService } from "../services/LabelService"
import { newOrgId, testLayer } from "./harness"

const labelsOf = (state: Record<string, unknown>): ReadonlyArray<string> =>
  Array.isArray(state[LABELS_KEY]) ? (state[LABELS_KEY] as string[]) : []

describe("label vocabulary (LabelService)", () => {
  it.effect("create + list; duplicate name conflicts; name reusable after delete", () =>
    Effect.gen(function* () {
      const labels = yield* LabelService
      const urgent = yield* labels.create({ name: "Urgent", color: "#e11d48" })
      expect(urgent.name).toBe("Urgent")
      expect(urgent.color).toBe("#e11d48")

      const dup = yield* labels.create({ name: "Urgent" }).pipe(Effect.flip)
      expect(dup._tag).toBe("LabelNameConflict")

      // Soft-delete frees the name for reuse.
      yield* labels.archive(urgent.id)
      const list = yield* labels.list()
      expect(list.find((l) => l.id === urgent.id)).toBeUndefined()
      const reused = yield* labels.create({ name: "Urgent" })
      expect(reused.id).not.toBe(urgent.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rename + recolor propagate by id; getById resolves a soft-deleted label", () =>
    Effect.gen(function* () {
      const labels = yield* LabelService
      const l = yield* labels.create({ name: "Legal", color: "#2563eb" })
      const renamed = yield* labels.rename({ id: l.id, name: "Compliance", color: "#7c3aed" })
      expect(renamed.id).toBe(l.id)
      expect(renamed.name).toBe("Compliance")
      expect(renamed.color).toBe("#7c3aed")

      yield* labels.archive(l.id)
      // Stays resolvable by id (mirrors soft-deleted fields), but drops from list.
      const got = yield* labels.getById(l.id)
      expect(got.deletedAt).not.toBeNull()
      const live = yield* labels.list()
      expect(live.length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("resolve returns live labels in input order, dropping missing/deleted", () =>
    Effect.gen(function* () {
      const labels = yield* LabelService
      const a = yield* labels.create({ name: "A" })
      const b = yield* labels.create({ name: "B" })
      yield* labels.archive(b.id)
      const resolved = yield* labels.resolve([b.id, a.id, randomUUID()])
      expect(resolved.map((l) => l.id)).toEqual([a.id]) // b deleted, random missing
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("archive then restore round-trips; purge removes permanently", () =>
    Effect.gen(function* () {
      const labels = yield* LabelService
      const l = yield* labels.create({ name: "Hot" })
      yield* labels.archive(l.id)
      expect((yield* labels.list()).length).toBe(0)
      expect((yield* labels.list({ includeArchived: true })).length).toBe(1)

      const restored = yield* labels.restore(l.id)
      expect(restored.deletedAt).toBeNull()
      expect((yield* labels.list()).length).toBe(1)

      yield* labels.purge(l.id)
      expect((yield* labels.list({ includeArchived: true })).length).toBe(0)
      const gone = yield* labels.getById(l.id).pipe(Effect.flip)
      expect(gone._tag).toBe("LabelNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("primary flag defaults false, is settable on create, and toggles on rename", () =>
    Effect.gen(function* () {
      const labels = yield* LabelService
      const plain = yield* labels.create({ name: "Plain" })
      expect(plain.primary).toBe(false)
      const p = yield* labels.create({ name: "Crowned", primary: true })
      expect(p.primary).toBe(true)
      // rename leaving primary undefined keeps it; explicit false clears it.
      const recolored = yield* labels.rename({ id: p.id, color: "#000000" })
      expect(recolored.primary).toBe(true)
      const off = yield* labels.rename({ id: p.id, primary: false })
      expect(off.primary).toBe(false)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("concept static / default labels", () => {
  it.effect("updateConcept sets static + default; omitted arrays are left unchanged", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const labels = yield* LabelService
      const c = yield* concepts.create({ name: "Account" })
      const s = yield* labels.create({ name: "Internal" })
      const d = yield* labels.create({ name: "New" })

      const set = yield* concepts.update({
        id: c.id,
        description: null,
        staticLabelIds: [s.id],
        defaultLabelIds: [d.id],
      })
      expect(set.staticLabelIds).toEqual([s.id])
      expect(set.defaultLabelIds).toEqual([d.id])

      // A name/description-only update must NOT wipe the label sets.
      const renamed = yield* concepts.update({ id: c.id, name: "Company", description: "hub" })
      expect(renamed.staticLabelIds).toEqual([s.id])
      expect(renamed.defaultLabelIds).toEqual([d.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("updateConcept rejects a non-existent label id with LabelNotFound", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const c = yield* concepts.create({ name: "Account" })
      const err = yield* concepts
        .update({ id: c.id, description: null, staticLabelIds: [randomUUID()] })
        .pipe(Effect.flip)
      expect(err._tag).toBe("LabelNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("per-item labels (InstanceService)", () => {
  it.effect("create snapshots the concept's default labels onto __labels", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const labels = yield* LabelService
      const instances = yield* InstanceService
      const d = yield* labels.create({ name: "Default" })
      const c = yield* concepts.create({ name: "Account" })
      yield* concepts.update({ id: c.id, description: null, defaultLabelIds: [d.id] })

      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      expect(labelsOf(inst.state)).toEqual([d.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("create with explicit __labels overrides the defaults", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const labels = yield* LabelService
      const instances = yield* InstanceService
      const d = yield* labels.create({ name: "Default" })
      const x = yield* labels.create({ name: "Chosen" })
      const c = yield* concepts.create({ name: "Account" })
      yield* concepts.update({ id: c.id, description: null, defaultLabelIds: [d.id] })

      const inst = yield* instances.create({ conceptId: c.id, fields: { [LABELS_KEY]: [x.id] } })
      expect(labelsOf(inst.state)).toEqual([x.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("create drops a since-deleted default from the snapshot", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const labels = yield* LabelService
      const instances = yield* InstanceService
      const live = yield* labels.create({ name: "Live" })
      const gone = yield* labels.create({ name: "Gone" })
      const c = yield* concepts.create({ name: "Account" })
      yield* concepts.update({ id: c.id, description: null, defaultLabelIds: [live.id, gone.id] })
      yield* labels.archive(gone.id)

      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      expect(labelsOf(inst.state)).toEqual([live.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("update edits __labels, bumps version, and rebuild reproduces it", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const labels = yield* LabelService
      const instances = yield* InstanceService
      const a = yield* labels.create({ name: "A" })
      const b = yield* labels.create({ name: "B" })
      const c = yield* concepts.create({ name: "Account" })

      const inst = yield* instances.create({ conceptId: c.id, fields: { [LABELS_KEY]: [a.id] } })
      expect(inst.version).toBe(0)
      const updated = yield* instances.update({
        instanceId: inst.id,
        expectedVersion: 0,
        patch: { [LABELS_KEY]: [a.id, b.id] },
      })
      expect(updated.version).toBe(1)
      expect(labelsOf(updated.state)).toEqual([a.id, b.id])

      // Event-sourcing correctness: rebuilding from the stream reproduces __labels.
      const rebuilt = yield* instances.rebuild(inst.id)
      expect(labelsOf(rebuilt.state)).toEqual([a.id, b.id])
      expect(rebuilt.version).toBe(1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("update rejects an unknown label id (FieldValidationError)", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Account" })
      const inst = yield* instances.create({ conceptId: c.id, fields: {} })
      const err = yield* instances
        .update({
          instanceId: inst.id,
          expectedVersion: 0,
          patch: { [LABELS_KEY]: [randomUUID()] },
        })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
