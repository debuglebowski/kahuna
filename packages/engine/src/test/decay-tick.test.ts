import { describe, expect, it } from "@effect/vitest"
import { Effect, TestClock } from "effect"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { InstanceService } from "../services/InstanceService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

const DAY = 86_400_000

/** Minimal Account / Interaction / Deal(+decay) model. */
const setup = Effect.gen(function* () {
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
    config: { options: ["lead", "won", "lost"], transitions: { lead: ["won", "lost"] } },
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
})

describe("decay tick (recomputeBands)", () => {
  it.effect("emits ComputedBandChanged on a crossing, no version bump, idempotent", () =>
    Effect.gen(function* () {
      yield* setup
      const instances = yield* InstanceService
      const relations = yield* RelationService
      const base = new Date("2026-06-01T00:00:00Z").getTime()
      yield* TestClock.setTime(base)

      const account = yield* instances.create({ conceptName: "Account", fields: {} })
      const deal = yield* instances.create({ conceptName: "Deal", fields: { status: "lead" } })
      yield* relations.create({ relationType: "for", fromId: deal.id, toId: account.id })
      // Interaction 8 days before `base` -> warm (bands 7/14/30).
      const inter = yield* instances.create({
        conceptName: "Interaction",
        fields: { occurred_on: new Date(base - 8 * DAY).toISOString() },
      })
      yield* relations.create({ relationType: "on", fromId: inter.id, toId: account.id })

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

      // Marker persisted; version NOT bumped (deal was created at v0, never user-edited).
      const fresh = yield* instances.get(deal.id)
      expect((fresh.state.__bands as Record<string, string>).decay).toBe("cooling")
      expect(fresh.version).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
