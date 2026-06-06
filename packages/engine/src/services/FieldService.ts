import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Field, FieldConfig, FieldKind } from "../domain/types"
import { FieldConfigInvalid, FieldNameConflict } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type FieldRow, toField } from "./rows"

export interface AddFieldInput {
  readonly conceptId: string
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  readonly formula?: string
}

/** Manages field definitions on concepts (the schema-as-data). */
export class FieldService extends Effect.Service<FieldService>()("engine/FieldService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore

    const listFields = (
      conceptId: string,
    ): Effect.Effect<ReadonlyArray<Field>, never, OrgContext> =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<FieldRow>`
          SELECT * FROM fields WHERE org_id = ${orgId} AND concept_id = ${conceptId} ORDER BY name ASC`
        return rows.map(toField)
      }).pipe(Effect.orDie)

    const addField = (input: AddFieldInput) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const config = input.config ?? {}

          // Validate the config shape against the kind (make invalid defs unrepresentable).
          const invalid = (reason: string) =>
            Effect.fail(
              new FieldConfigInvalid({ conceptId: input.conceptId, name: input.name, reason }),
            )
          if (input.kind === "enum" && (!config.options || config.options.length === 0)) {
            return yield* invalid("enum field requires non-empty config.options")
          }
          if (input.kind === "computed" && !config.computedKind) {
            return yield* invalid("computed field requires config.computedKind")
          }
          if (input.kind === "relation" && (!config.relationType || !config.target)) {
            return yield* invalid("relation field requires config.relationType and config.target")
          }

          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM fields WHERE concept_id = ${input.conceptId} AND name = ${input.name} LIMIT 1`
          if (existing[0]) {
            return yield* Effect.fail(
              new FieldNameConflict({ conceptId: input.conceptId, name: input.name }),
            )
          }

          const rows = yield* sql<FieldRow>`
            INSERT INTO fields (org_id, concept_id, name, kind, formula, config)
            VALUES (${orgId}, ${input.conceptId}, ${input.name}, ${input.kind}, ${input.formula ?? null}, ${sql.json(config)})
            RETURNING *`
          const field = toField(rows[0]!)
          yield* events.append({
            subjectKind: "field",
            subjectId: field.id,
            eventType: "FieldAdded",
            payload: {
              _tag: "FieldAdded",
              conceptId: input.conceptId,
              name: field.name,
              kind: field.kind,
            },
          })
          return field
        }),
      )

    return { addField, listFields } as const
  }),
  dependencies: [EventStore.Default],
}) {}
