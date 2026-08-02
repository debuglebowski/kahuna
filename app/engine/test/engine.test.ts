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

/**
 * Define a minimal Account / Interaction / Deal model (+ relations) in the
 * current org. Returns the concepts and a map of field **ids** — instance state,
 * transitions, relations and computed params are all keyed by id, not name.
 */
const setupDealModel = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const fields = yield* FieldService
  const account = yield* concepts.create({ name: "Account" })
  const interaction = yield* concepts.create({ name: "Interaction" })
  const deal = yield* concepts.create({ name: "Deal" })

  const occurredOn = yield* fields.addField({
    conceptId: interaction.id,
    name: "occurred_on",
    kind: "date",
  })
  const onField = yield* fields.addField({
    conceptId: interaction.id,
    name: "on",
    kind: "relation",
    config: { target: account.id, cardinality: "many" },
  })
  const status = yield* fields.addField({
    conceptId: deal.id,
    name: "status",
    kind: "enum",
    config: {
      options: ["lead", "qualified", "won", "lost"],
      transitions: { lead: ["qualified", "lost"], qualified: ["won", "lost"], won: [], lost: [] },
    },
  })
  const forField = yield* fields.addField({
    conceptId: deal.id,
    name: "for",
    kind: "relation",
    config: { target: account.id, cardinality: "one" },
  })
  const decay = yield* fields.addField({
    conceptId: deal.id,
    name: "decay",
    kind: "computed",
    config: {
      computedKind: "decay",
      params: { forRelation: forField.id, onRelation: onField.id, dateField: occurredOn.id },
    },
  })
  const momentum = yield* fields.addField({
    conceptId: deal.id,
    name: "momentum",
    kind: "computed",
    config: {
      computedKind: "momentum",
      params: { forRelation: forField.id, onRelation: onField.id, dateField: occurredOn.id },
    },
  })

  return {
    account,
    interaction,
    deal,
    f: {
      status: status.id,
      decay: decay.id,
      momentum: momentum.id,
      occurredOn: occurredOn.id,
      for: forField.id,
      on: onField.id,
    },
  }
})

describe("engine (integration)", () => {
  it.effect("replay == incremental projection", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const events = yield* EventStore

      const d0 = yield* instances.create({ conceptName: "Deal", fields: { [m.f.status]: "lead" } })
      const d1 = yield* instances.update({
        instanceId: d0.id,
        expectedVersion: 0,
        patch: { [m.f.status]: "qualified" },
      })
      const d2 = yield* instances.transition({
        instanceId: d0.id,
        expectedVersion: d1.version,
        field: m.f.status,
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
      expect(fresh.state).toEqual({ [m.f.status]: "won" })
      expect(fresh.version).toBe(2)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("stale-version write is rejected", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { [m.f.status]: "lead" } })
      yield* instances.update({
        instanceId: d.id,
        expectedVersion: 0,
        patch: { [m.f.status]: "qualified" },
      })
      const err = yield* instances
        .update({ instanceId: d.id, expectedVersion: 0, patch: { [m.f.status]: "lost" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("VersionConflict")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("concurrent writers: exactly one wins (FOR UPDATE)", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { [m.f.status]: "lead" } })
      const a = instances
        .update({ instanceId: d.id, expectedVersion: 0, patch: { [m.f.status]: "qualified" } })
        .pipe(Effect.either)
      const b = instances
        .update({ instanceId: d.id, expectedVersion: 0, patch: { [m.f.status]: "lost" } })
        .pipe(Effect.either)
      const results = yield* Effect.all([a, b], { concurrency: 2 })
      expect(results.filter(Either.isRight).length).toBe(1)
      expect(results.filter(Either.isLeft).length).toBe(1)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("time-travel reconstructs past state", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const events = yield* EventStore
      const d = yield* instances.create({ conceptName: "Deal", fields: { [m.f.status]: "lead" } })
      const v1 = yield* instances.update({
        instanceId: d.id,
        expectedVersion: 0,
        patch: { [m.f.status]: "qualified" },
      })
      yield* instances.transition({
        instanceId: d.id,
        expectedVersion: v1.version,
        field: m.f.status,
        to: "won",
      })

      const stream = yield* events.readStream(d.id)
      const asCreate = yield* instances.getAsOf(d.id, stream[0]!.id)
      expect(asCreate.state).toEqual({ [m.f.status]: "lead" })
      expect(asCreate.version).toBe(0)
      const asUpdate = yield* instances.getAsOf(d.id, stream[1]!.id)
      expect(asUpdate.state).toEqual({ [m.f.status]: "qualified" })
      expect(asUpdate.version).toBe(1)

      const head = yield* instances.getAsOf(d.id, stream[2]!.id)
      const live = yield* instances.get(d.id)
      expect(head.state).toEqual(live.state)
      expect(head.version).toBe(live.version)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("illegal Deal transition rejected; legal one allowed", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { [m.f.status]: "lead" } })
      const err = yield* instances
        .transition({ instanceId: d.id, expectedVersion: 0, field: m.f.status, to: "won" })
        .pipe(Effect.flip)
      expect(err._tag).toBe("IllegalTransition")
      const ok = yield* instances.transition({
        instanceId: d.id,
        expectedVersion: 0,
        field: m.f.status,
        to: "qualified",
      })
      expect(ok.state[m.f.status]).toBe("qualified")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rejects unknown and wrong-type fields", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const e1 = yield* instances
        .create({ conceptName: "Deal", fields: { nope: 1 } })
        .pipe(Effect.flip)
      expect(e1._tag).toBe("FieldValidationError")
      const e2 = yield* instances
        .create({ conceptName: "Deal", fields: { [m.f.status]: "bogus" } })
        .pipe(Effect.flip)
      expect(e2._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rebuild reproduces the incremental projection", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const d = yield* instances.create({ conceptName: "Deal", fields: { [m.f.status]: "lead" } })
      const v1 = yield* instances.update({
        instanceId: d.id,
        expectedVersion: 0,
        patch: { [m.f.status]: "qualified" },
      })
      const live = yield* instances.transition({
        instanceId: d.id,
        expectedVersion: v1.version,
        field: m.f.status,
        to: "won",
      })
      const rebuilt = yield* instances.rebuild(d.id)
      expect(rebuilt.state).toEqual(live.state)
      expect(rebuilt.version).toBe(live.version)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("decay and momentum reflect the current time (TestClock)", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const computed = yield* ComputedFields

      const base = new Date("2026-06-01T00:00:00Z").getTime()
      yield* TestClock.setTime(base)

      const account = yield* instances.create({ conceptName: "Account", fields: {} })
      const deal = yield* instances.create({
        conceptName: "Deal",
        fields: { [m.f.status]: "lead" },
      })
      yield* relations.create({ fieldId: m.f.for, fromId: deal.id, toId: account.id })
      const interaction = yield* instances.create({
        conceptName: "Interaction",
        fields: { [m.f.occurredOn]: new Date(base - 2 * 86_400_000).toISOString() },
      })
      yield* relations.create({ fieldId: m.f.on, fromId: interaction.id, toId: account.id })

      const atBase = yield* computed.decorate(deal)
      // Passing pre-loaded defs (what `listInstances` does, to avoid a lookup per
      // row) must produce exactly the same result as letting `decorate` fetch them.
      const fields = yield* FieldService
      const preloaded = yield* computed.decorate(deal, yield* fields.listFields(deal.conceptId))
      expect(preloaded.state).toEqual(atBase.state)
      expect((atBase.state[m.f.decay] as DecayValue).band).toBe("fresh")
      expect((atBase.state[m.f.decay] as DecayValue).days).toBe(2)
      expect((atBase.state[m.f.momentum] as MomentumValue).label).toBe("heating")

      // Move 20 days forward: interaction is now 22 days old -> cooling, and falls into the prior window -> cooling momentum.
      yield* TestClock.setTime(base + 20 * 86_400_000)
      const later = yield* computed.decorate(deal)
      expect((later.state[m.f.decay] as DecayValue).band).toBe("cooling")
      expect((later.state[m.f.decay] as DecayValue).days).toBe(22)
      expect((later.state[m.f.momentum] as MomentumValue).label).toBe("cooling")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("back-dated interaction changes decay", () =>
    Effect.gen(function* () {
      const m = yield* setupDealModel
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const computed = yield* ComputedFields
      const base = new Date("2026-06-01T00:00:00Z").getTime()
      yield* TestClock.setTime(base)

      const account = yield* instances.create({ conceptName: "Account", fields: {} })
      const deal = yield* instances.create({
        conceptName: "Deal",
        fields: { [m.f.status]: "lead" },
      })
      yield* relations.create({ fieldId: m.f.for, fromId: deal.id, toId: account.id })

      // No interactions yet -> falls back to deal age (just created -> fresh).
      const before = yield* computed.decorate(deal)
      expect((before.state[m.f.decay] as DecayValue).band).toBe("fresh")

      // Add an interaction 40 days ago -> decay jumps to cold.
      const old = yield* instances.create({
        conceptName: "Interaction",
        fields: { [m.f.occurredOn]: new Date(base - 40 * 86_400_000).toISOString() },
      })
      yield* relations.create({ fieldId: m.f.on, fromId: old.id, toId: account.id })
      const after = yield* computed.decorate(deal)
      expect((after.state[m.f.decay] as DecayValue).band).toBe("cold")
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

describe("field primitives (user / json / money / multiple / format)", () => {
  it.effect("user field stores a member id; multiple wants a list", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const team = yield* concepts.create({ name: "Team" })
      const owner = yield* fields.addField({ conceptId: team.id, name: "owner", kind: "user" })
      const reviewers = yield* fields.addField({
        conceptId: team.id,
        name: "reviewers",
        kind: "user",
        config: { multiple: true },
      })

      const t = yield* instances.create({
        conceptId: team.id,
        fields: { [owner.id]: "user-1", [reviewers.id]: ["user-2", "user-3"] },
      })
      expect(t.state[owner.id]).toBe("user-1")
      expect(t.state[reviewers.id]).toEqual(["user-2", "user-3"])

      // a `multiple` field rejects a non-array value
      const err = yield* instances
        .create({ conceptId: team.id, fields: { [reviewers.id]: "user-2" } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("json stores arbitrary structure; money wants { amount, currency }", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Doc" })
      const meta = yield* fields.addField({ conceptId: c.id, name: "meta", kind: "json" })
      const price = yield* fields.addField({ conceptId: c.id, name: "price", kind: "money" })

      const ok = yield* instances.create({
        conceptId: c.id,
        fields: {
          [meta.id]: { a: 1, tags: ["x"] },
          [price.id]: { amount: 99.5, currency: "USD" },
        },
      })
      expect(ok.state[meta.id]).toEqual({ a: 1, tags: ["x"] })
      expect(ok.state[price.id]).toEqual({ amount: 99.5, currency: "USD" })

      const err = yield* instances
        .create({ conceptId: c.id, fields: { [price.id]: { amount: 10 } } })
        .pipe(Effect.flip)
      expect(err._tag).toBe("FieldValidationError")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("text format validates values; unknown format is rejected at config time", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const instances = yield* InstanceService
      const c = yield* concepts.create({ name: "Person" })
      const email = yield* fields.addField({
        conceptId: c.id,
        name: "email",
        kind: "text",
        config: { format: "email" },
      })

      const ok = yield* instances.create({ conceptId: c.id, fields: { [email.id]: "a@b.com" } })
      expect(ok.state[email.id]).toBe("a@b.com")
      const badValue = yield* instances
        .create({ conceptId: c.id, fields: { [email.id]: "nope" } })
        .pipe(Effect.flip)
      expect(badValue._tag).toBe("FieldValidationError")

      const badConfig = yield* fields
        .addField({ conceptId: c.id, name: "weird", kind: "text", config: { format: "bogus" } })
        .pipe(Effect.flip)
      expect(badConfig._tag).toBe("FieldConfigInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
