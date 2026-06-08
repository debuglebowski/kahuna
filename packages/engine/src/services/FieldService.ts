import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Field, FieldConfig, FieldKind } from "../domain/types"
import { FieldConfigInvalid, FieldNameConflict, FieldNotFound } from "../errors"
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

/** Recognised `config.format` names per kind (value validators live in InstanceService). */
const TEXT_FORMATS = new Set(["email", "url", "phone", "slug", "color"])
const NUMBER_FORMATS = new Set(["percent"])

/** Validate a field's config shape against its kind (make invalid defs unrepresentable). */
const validateConfig = (
  ctx: { readonly conceptId: string; readonly name: string },
  kind: FieldKind,
  config: FieldConfig,
) =>
  Effect.gen(function* () {
    const invalid = (reason: string) =>
      Effect.fail(new FieldConfigInvalid({ conceptId: ctx.conceptId, name: ctx.name, reason }))
    if (kind === "enum" && (!config.options || config.options.length === 0)) {
      return yield* invalid("enum field requires non-empty config.options")
    }
    if (kind === "computed" && !config.computedKind) {
      return yield* invalid("computed field requires config.computedKind")
    }
    if (kind === "relation" && (!config.relationType || !config.target)) {
      return yield* invalid("relation field requires config.relationType and config.target")
    }
    if (config.format) {
      if (kind === "text" && !TEXT_FORMATS.has(config.format)) {
        return yield* invalid(`unknown text format "${config.format}"`)
      }
      if (kind === "number" && !NUMBER_FORMATS.has(config.format)) {
        return yield* invalid(`unknown number format "${config.format}"`)
      }
      if (kind !== "text" && kind !== "number") {
        return yield* invalid("config.format is only valid on text/number fields")
      }
    }
    if (config.multiple && (kind === "relation" || kind === "file" || kind === "computed")) {
      return yield* invalid("config.multiple is not valid on relation/file/computed fields")
    }
  })

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

    const getById = (id: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<FieldRow>`
          SELECT * FROM fields WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new FieldNotFound({ fieldId: id }))
        return toField(row)
      })

    const addField = (input: AddFieldInput) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const config = input.config ?? {}
          yield* validateConfig(
            { conceptId: input.conceptId, name: input.name },
            input.kind,
            config,
          )

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

    /**
     * Edit a field's config and/or formula. Name and kind are immutable: stored
     * instance state is keyed by field name, and changing kind would invalidate
     * already-persisted values.
     */
    const update = (input: {
      readonly id: string
      readonly config?: FieldConfig
      readonly formula?: string | null
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const current = yield* getById(input.id)
          const config = input.config ?? current.config
          yield* validateConfig(
            { conceptId: current.conceptId, name: current.name },
            current.kind,
            config,
          )
          const formula = input.formula === undefined ? current.formula : input.formula
          const rows = yield* sql<FieldRow>`
            UPDATE fields SET config = ${sql.json(config)}, formula = ${formula}
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING *`
          const field = toField(rows[0]!)
          yield* events.append({
            subjectKind: "field",
            subjectId: field.id,
            eventType: "FieldUpdated",
            payload: {
              _tag: "FieldUpdated",
              conceptId: field.conceptId,
              name: field.name,
              kind: field.kind,
            },
          })
          return field
        }),
      )

    /**
     * Delete a field def. Existing instance.state keeps any orphaned key
     * harmlessly (field validation is write-time only).
     */
    const remove = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const field = yield* getById(id)
          yield* sql`DELETE FROM fields WHERE org_id = ${orgId} AND id = ${id}`
          yield* events.append({
            subjectKind: "field",
            subjectId: id,
            eventType: "FieldDeleted",
            payload: { _tag: "FieldDeleted", conceptId: field.conceptId, name: field.name },
          })
          return field
        }),
      )

    return { addField, listFields, getById, update, remove } as const
  }),
  dependencies: [EventStore.Default],
}) {}
