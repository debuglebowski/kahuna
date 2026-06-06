import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Exit, TestClock } from "effect"
import { foldEvents } from "../projection/fold"
import { ComputedFields } from "../services/ComputedFields"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

type DecayValue = { readonly band: string; readonly days: number | null }
type MomentumValue = { readonly label: string; readonly recent: number; readonly prior: number }

/** Define a minimal Account / Interaction / Deal model (+ relations) in the current org. */
const setupDealModel = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const fields = yield* FieldService
  yield* concepts.create({ name: "Account" })
  const interaction = yield* concepts.create({ name: "Interaction" })
  const deal = yield* concepts.create({ name: "Deal" })
  yield* fields.addField({ conceptId: interaction.id, name: "occurred_on", kind: "date" })
  yield* fields.addField({
    conceptId: deal.id,
    name: "status",
    kind: "enum",
    config: {
      options: ["lead", "qualified", "won", "lost"],
      transitions: { lead: ["qualified", "lost"], qualified: ["won", "lost"], won: [], lost: [] },
    },
  })
  yield* fields.addField({
    conceptId: deal.id,
    name: "decay",
    kind: "computed",
    config: {
      computedKind: "decay",
      params: { forRelation: "for", onRelation: "on", dateField: "occurred_on" },
    },
  })
  yield* fields.addField({
    conceptId: deal.id,
    name: "momentum",
    kind: "computed",
    config: {
      computedKind: "momentum",
      params: { forRelation: "for", onRelation: "on", dateField: "occurred_on" },
    },
  })
})

describe("engine (integration)", () => {
  it.effect("replay == incremental projection", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const events = yield* EventStore

      const d0 = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      const d1 = yield* instances.update({
        instanceId: d0.id,
        expectedVersion: 0,
        patch: { status: "qualified" },
      })
      const d2 = yield* instances.transition({
        instanceId: d0.id,
        expectedVersion: d1.version,
        field: "status",
        to: "won",
      })

      const stream = yield* events.readStream(d0.id)
      const folded = foldEvents(stream)
      expect(Either.isRight(folded)).toBe(true)
      if (Either.isRight(folded) && folded.right) {
        expect(folded.right.state).toEqual(d2.state)
        expect(folded.right.version).toBe(d2.version)
      }
      const fresh = yield* instances.get(d0.id)
      expect(fresh.state).toEqual({ status: "won" })
      expect(fresh.version).toBe(2)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("stale-version write is rejected", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      yield* instances.update({
        instanceId: d.id,
        expectedVersion: 0,
        patch: { status: "qualified" },
      })
      const err = yield* instances
        .update({ instanceId: d.id, expectedVersion: 0, patch: { status: "lost" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("VersionConflict")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("concurrent writers: exactly one wins (FOR UPDATE)", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      const a = instances
        .update({ instanceId: d.id, expectedVersion: 0, patch: { status: "qualified" } })
        .pipe(Effect.either)
      const b = instances
        .update({ instanceId: d.id, expectedVersion: 0, patch: { status: "lost" } })
        .pipe(Effect.either)
      const results = yield* Effect.all([a, b], { concurrency: 2 })
      expect(results.filter(Either.isRight).length).toBe(1)
      expect(results.filter(Either.isLeft).length).toBe(1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("time-travel reconstructs past state", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const events = yield* EventStore
      const d = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      const v1 = yield* instances.update({
        instanceId: d.id,
        expectedVersion: 0,
        patch: { status: "qualified" },
      })
      yield* instances.transition({
        instanceId: d.id,
        expectedVersion: v1.version,
        field: "status",
        to: "won",
      })

      const stream = yield* events.readStream(d.id)
      const asCreate = yield* instances.getAsOf(d.id, stream[0]!.id)
      expect(asCreate.state).toEqual({ status: "lead" })
      expect(asCreate.version).toBe(0)
      const asUpdate = yield* instances.getAsOf(d.id, stream[1]!.id)
      expect(asUpdate.state).toEqual({ status: "qualified" })
      expect(asUpdate.version).toBe(1)

      const head = yield* instances.getAsOf(d.id, stream[2]!.id)
      const live = yield* instances.get(d.id)
      expect(head.state).toEqual(live.state)
      expect(head.version).toBe(live.version)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("illegal Deal transition rejected; legal one allowed", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      const err = yield* instances
        .transition({ instanceId: d.id, expectedVersion: 0, field: "status", to: "won" })
        .pipe(Effect.flip)
      expect(err._tag).toBe("IllegalTransition")
      const ok = yield* instances.transition({
        instanceId: d.id,
        expectedVersion: 0,
        field: "status",
        to: "qualified",
      })
      expect(ok.state.status).toBe("qualified")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rejects unknown and wrong-type fields", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const e1 = yield* instances
        .create({ conceptName: "Deal", fields: { nope: 1 } })
        .pipe(Effect.flip)
      expect(e1._tag).toBe("FieldValidationError")
      const e2 = yield* instances
        .create({ conceptName: "Deal", fields: { status: "bogus" } })
        .pipe(Effect.flip)
      expect(e2._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rebuild reproduces the incremental projection", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      const v1 = yield* instances.update({
        instanceId: d.id,
        expectedVersion: 0,
        patch: { status: "qualified" },
      })
      const live = yield* instances.transition({
        instanceId: d.id,
        expectedVersion: v1.version,
        field: "status",
        to: "won",
      })
      const rebuilt = yield* instances.rebuild(d.id)
      expect(rebuilt.state).toEqual(live.state)
      expect(rebuilt.version).toBe(live.version)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("decay and momentum reflect the current time (TestClock)", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const computed = yield* ComputedFields

      const base = new Date("2026-06-01T00:00:00Z").getTime()
      yield* TestClock.setTime(base)

      const account = yield* instances.create({ conceptName: "Account", fields: {} })
      const deal = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      yield* relations.create({ relationType: "for", fromId: deal.id, toId: account.id })
      const interaction = yield* instances.create({
        conceptName: "Interaction",
        fields: { occurred_on: new Date(base - 2 * 86_400_000).toISOString() },
      })
      yield* relations.create({ relationType: "on", fromId: interaction.id, toId: account.id })

      const atBase = yield* computed.decorate(deal)
      expect((atBase.state.decay as DecayValue).band).toBe("fresh")
      expect((atBase.state.decay as DecayValue).days).toBe(2)
      expect((atBase.state.momentum as MomentumValue).label).toBe("heating")

      // Move 20 days forward: interaction is now 22 days old -> cooling, and falls into the prior window -> cooling momentum.
      yield* TestClock.setTime(base + 20 * 86_400_000)
      const later = yield* computed.decorate(deal)
      expect((later.state.decay as DecayValue).band).toBe("cooling")
      expect((later.state.decay as DecayValue).days).toBe(22)
      expect((later.state.momentum as MomentumValue).label).toBe("cooling")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("back-dated interaction changes decay", () =>
    Effect.gen(function* () {
      yield* setupDealModel
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const computed = yield* ComputedFields
      const base = new Date("2026-06-01T00:00:00Z").getTime()
      yield* TestClock.setTime(base)

      const account = yield* instances.create({ conceptName: "Account", fields: {} })
      const deal = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      yield* relations.create({ relationType: "for", fromId: deal.id, toId: account.id })

      // No interactions yet -> falls back to deal age (just created -> fresh).
      const before = yield* computed.decorate(deal)
      expect((before.state.decay as DecayValue).band).toBe("fresh")

      // Add an interaction 40 days ago -> decay jumps to cold.
      const old = yield* instances.create({
        conceptName: "Interaction",
        fields: { occurred_on: new Date(base - 40 * 86_400_000).toISOString() },
      })
      yield* relations.create({ relationType: "on", fromId: old.id, toId: account.id })
      const after = yield* computed.decorate(deal)
      expect((after.state.decay as DecayValue).band).toBe("cold")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it("org A cannot see org B's data", async () => {
    const orgA = newOrgId()
    const orgB = newOrgId()

    const createdId = await Effect.runPromise(
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const instances = yield* InstanceService
        yield* concepts.create({ name: "Account" })
        const acc = yield* instances.create({ conceptName: "Account", fields: {} })
        return acc.id
      }).pipe(Effect.provide(testLayer(orgA))),
    )

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        return yield* instances.get(createdId)
      }).pipe(Effect.provide(testLayer(orgB))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
