import { ConceptService, FieldService, TaskStatusService } from "@kingsmaker/engine"
import { Effect } from "effect"
import { type ConceptSpec, defaultTaskStatuses, kingsmakerSpec } from "./spec"

/** Get a concept by name, creating it if absent (idempotent). */
const ensureConcept = (concepts: ConceptService, spec: ConceptSpec) =>
  concepts.getByName(spec.name).pipe(
    Effect.catchTag("ConceptNotFound", () =>
      concepts.create({
        name: spec.name,
        pluralName: spec.pluralName,
        description: spec.description,
        icon: spec.icon,
      }),
    ),
  )

/**
 * Seed the Kingsmaker concepts + fields for the current org (OrgContext).
 * Two passes: create every concept first, then add fields — so `relation`
 * fields can resolve their `targetName` to a concept id. Idempotent: re-running
 * skips concepts/fields that already exist, and every create flows through the
 * engine's event-sourced append path.
 */
export const seedKingsmaker = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const fields = yield* FieldService
  const taskStatuses = yield* TaskStatusService

  // Annotation layer: seed the org's default task statuses (idempotent).
  yield* taskStatuses.ensureDefaults(defaultTaskStatuses)

  const idByName = new Map<string, string>()
  for (const spec of kingsmakerSpec) {
    const concept = yield* ensureConcept(concepts, spec)
    idByName.set(spec.name, concept.id)
  }

  for (const spec of kingsmakerSpec) {
    const conceptId = idByName.get(spec.name)!
    const existing = yield* fields.listFields(conceptId)
    const have = new Set(existing.map((f) => f.name))
    for (const field of spec.fields) {
      if (have.has(field.name)) continue
      const config =
        field.kind === "relation" && field.targetName
          ? { ...(field.config ?? {}), target: idByName.get(field.targetName) }
          : field.config
      yield* fields.addField({
        conceptId,
        name: field.name,
        kind: field.kind,
        config,
        icon: field.icon,
      })
    }
  }

  return { concepts: kingsmakerSpec.length }
})
