import { describe, expect, it } from "@effect/vitest"
import { Effect, TestClock } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

const DAY = 86_400_000

/** Minimal Account / Interaction / Deal(+decay) model; returns field ids. */
const setup = Effect.gen(function* () {
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
    config: { options: ["lead", "won", "lost"], transitions: { lead: ["won", "lost"] } },
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
  return {
    f: {
      status: status.id,
      decay: decay.id,
      occurredOn: occurredOn.id,
      for: forField.id,
      on: onField.id,
    },
  }
})

describe("decay tick (recomputeBands)", () => {
  it.effect("emits ComputedBandChanged on a crossing, no version bump, idempotent", () =>
    Effect.gen(function* () {
      const m = yield* setup
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const base = new Date("2026-06-01T00:00:00Z").getTime()
      yield* TestClock.setTime(base)

      const account = yield* instances.create({ conceptName: "Account", fields: {} })
      const deal = yield* instances.create({
        conceptName: "Deal",
        fields: { [m.f.status]: "lead" },
      })
      yield* relations.create({ fieldId: m.f.for, fromId: deal.id, toId: account.id })
      // Interaction 8 days before `base` -> warm (bands 7/14/30).
      const inter = yield* instances.create({
        conceptName: "Interaction",
        fields: { [m.f.occurredOn]: new Date(base - 8 * DAY).toISOString() },
      })
      yield* relations.create({ fieldId: m.f.on, fromId: inter.id, toId: account.id })

      // First recompute: no stored marker yet -> materialises null -> warm.
      const e1 = yield* instances.recomputeBands(deal.id)
      expect(e1.length).toBe(1)
      const p1 = e1[0]!.payload
      if (p1._tag === "ComputedBandChanged") expect(p1.to).toBe("warm")

      // +8 days: interaction now 16 days old -> cooling.
      yield* TestClock.setTime(base + 8 * DAY)
      const e2 = yield* instances.recomputeBands(deal.id)
      expect(e2.length).toBe(1)
      const p2 = e2[0]!.payload
      if (p2._tag === "ComputedBandChanged") {
        expect(p2.from).toBe("warm")
        expect(p2.to).toBe("cooling")
      }

      // No further time change -> no crossing -> no event (idempotent).
      const e3 = yield* instances.recomputeBands(deal.id)
      expect(e3.length).toBe(0)

      // Marker persisted (keyed by the decay field id); version NOT bumped.
      const fresh = yield* instances.get(deal.id)
      expect((fresh.state.__bands as Record<string, string>)[m.f.decay]).toBe("cooling")
      expect(fresh.version).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
