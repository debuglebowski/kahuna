import { describe, expect, it } from "@effect/vitest"
import type { Field as WireField } from "@kahunalabs/contract"
import { Effect } from "effect"
import { ConceptService, FieldService, RecordService } from "#engine"
import { parseFieldAssignments } from "../../cli/resolve.ts"
import { newOrgId, testLayer } from "../engine/test/harness"

/**
 * The CLI coerces `--field` text into wire values with no server in the loop;
 * this proves the engine ACCEPTS what it produces. The original bug was exactly
 * this seam: the CLI sent a raw string for richtext and a bare number for money,
 * and every write came back "A value was rejected by the field's rules".
 */
describe("CLI --field values against the engine's validation", () => {
  it.effect("richtext (markdown) and money (code / org default) are accepted as sent", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const records = yield* RecordService
      const c = yield* concepts.create({ name: "Policy" })
      const content = yield* fields.addField({ conceptId: c.id, name: "Content", kind: "richtext" })
      const cost = yield* fields.addField({ conceptId: c.id, name: "Annual cost", kind: "money" })
      const wire = [content, cost] as unknown as ReadonlyArray<WireField>

      const values = parseFieldAssignments(
        wire,
        [
          "Content=# Scope\n\nAll **laptops**:\n\n- [Intune](https://intune.example)\n- MDM",
          "Annual cost=1 200 sek",
        ],
        { defaultCurrency: null },
      )
      const v = yield* records.create({ conceptId: c.id, fields: values })
      expect(v.state[cost.id]).toEqual({ amount: 1200, currency: "SEK" })
      expect(v.state[content.id]).toEqual(values[content.id])

      const patch = parseFieldAssignments(wire, ["Annual cost=99.5", "Content=hello"], {
        defaultCurrency: "EUR",
      })
      const u = yield* records.update({
        recordVersionId: v.id,
        expectedVersion: v.version,
        patch,
      })
      expect(u.state[cost.id]).toEqual({ amount: 99.5, currency: "EUR" })
      expect((u.state[content.id] as { text: string }).text).toBe("hello")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
