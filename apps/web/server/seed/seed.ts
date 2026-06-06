import { ConceptService, FieldService } from "@kingsmaker/engine"
import { Effect } from "effect"
import { type ConceptSpec, kingsmakerSpec } from "./spec"

/** Get a concept by name, creating it if absent (idempotent). */
const ensureConcept = (concepts: ConceptService, spec: ConceptSpec) =>
  concepts
    .getByName(spec.name)
    .pipe(
      Effect.catchTag("ConceptNotFound", () =>
        concepts.create({ name: spec.name, description: spec.description }),
      ),
    )

/**
 * Seed the Kingsmaker concepts + fields for the current org (OrgContext).
 * Idempotent: re-running skips concepts/fields that already exist, and every
 * create flows through the engine's event-sourced append path.
 */
export const seedKingsmaker = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const fields = yield* FieldService

  for (const spec of kingsmakerSpec) {
    const concept = yield* ensureConcept(concepts, spec)
    const existing = yield* fields.listFields(concept.id)
    const have = new Set(existing.map((f) => f.name))
    for (const field of spec.fields) {
      if (have.has(field.name)) continue
      yield* fields.addField({
        conceptId: concept.id,
        name: field.name,
        kind: field.kind,
        config: field.config,
      })
    }
  }

  return { concepts: kingsmakerSpec.length }
})
