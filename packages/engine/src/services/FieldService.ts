import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Field, FieldConfig, FieldKind } from "../domain/types"
import { FieldConfigInvalid, FieldInUse, FieldNameConflict, FieldNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type FieldRow, toField } from "./rows"

export interface AddFieldInput {
  readonly conceptId: string
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  readonly formula?: string
  /** Optional display glyph: literal emoji or `lucide:Name` (see `Field.icon`). */
  readonly icon?: string | null
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
    if (config.optionColors) {
      if (kind !== "enum") {
        return yield* invalid("config.optionColors is only valid on enum fields")
      }
      for (const [option, color] of Object.entries(config.optionColors)) {
        if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
          return yield* invalid(`optionColors["${option}"] is not a hex color`)
        }
      }
    }
    if (kind === "computed" && !config.computedKind) {
      return yield* invalid("computed field requires config.computedKind")
    }
    if (kind === "relation" && !config.target) {
      return yield* invalid("relation field requires config.target")
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
    if (
      config.multiple &&
      (kind === "relation" || kind === "file" || kind === "computed" || kind === "richtext")
    ) {
      return yield* invalid(
        "config.multiple is not valid on relation/file/computed/richtext fields",
      )
    }
    if (config.requirement && (kind === "relation" || kind === "file" || kind === "computed")) {
      return yield* invalid("config.requirement is not valid on relation/file/computed fields")
    }
  })

/** Manages field definitions on concepts (the schema-as-data). */
export class FieldService extends Effect.Service<FieldService>()("engine/FieldService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore

    /** A concept's field defs, in display order (`position` asc, ties by name).
     *  Archived (archived_at set) are excluded unless `includeArchived` — only the
     *  settings editor passes it; all read/validation paths keep the live-only
     *  default. */
    const listFields = (
      conceptId: string,
      opts: { readonly includeArchived?: boolean } = {},
    ): Effect.Effect<ReadonlyArray<Field>, never, OrgContext> =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
        const rows = yield* sql<FieldRow>`
          SELECT * FROM fields
          WHERE org_id = ${orgId} AND concept_id = ${conceptId}${liveOnly}
          ORDER BY position ASC, name ASC`
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
            SELECT id FROM fields
            WHERE concept_id = ${input.conceptId} AND name = ${input.name} AND archived_at IS NULL
            LIMIT 1`
          if (existing[0]) {
            return yield* Effect.fail(
              new FieldNameConflict({ conceptId: input.conceptId, name: input.name }),
            )
          }

          // Append to the end of the concept's field order.
          const max = yield* sql<{ readonly max: number | string | null }>`
            SELECT MAX(position) AS max FROM fields
            WHERE org_id = ${orgId} AND concept_id = ${input.conceptId}`
          const position = Number(max[0]?.max ?? -1) + 1
          const rows = yield* sql<FieldRow>`
            INSERT INTO fields (org_id, concept_id, name, kind, formula, config, icon, position)
            VALUES (${orgId}, ${input.conceptId}, ${input.name}, ${input.kind}, ${input.formula ?? null}, ${sql.json(config)}, ${input.icon ?? null}, ${position})
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
     * Edit a field's name (the decorative label), config and/or formula. Only
     * `kind` is immutable — changing it would invalidate already-persisted
     * values. The name is free to change because instance state is keyed by
     * `id`, not by name.
     */
    const update = (input: {
      readonly id: string
      readonly name?: string
      readonly config?: FieldConfig
      readonly formula?: string | null
      // Omitted → left unchanged; explicit null → cleared.
      readonly icon?: string | null
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const current = yield* getById(input.id)
          const name = input.name ?? current.name
          const config = input.config ?? current.config
          yield* validateConfig({ conceptId: current.conceptId, name }, current.kind, config)
          if (name !== current.name) {
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM fields
              WHERE concept_id = ${current.conceptId} AND name = ${name}
                AND archived_at IS NULL AND id <> ${input.id}
              LIMIT 1`
            if (clash[0]) {
              return yield* Effect.fail(
                new FieldNameConflict({ conceptId: current.conceptId, name }),
              )
            }
          }
          const formula = input.formula === undefined ? current.formula : input.formula
          const icon = input.icon === undefined ? current.icon : input.icon
          const rows = yield* sql<FieldRow>`
            UPDATE fields SET name = ${name}, config = ${sql.json(config)}, formula = ${formula}, icon = ${icon}
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
     * Archive a field def (soft, restorable). The row is retained (archived_at set)
     * so its id stays resolvable to a name for any orphaned `state` keys /
     * historical events / relation edges that still reference it. Existing
     * instance.state keeps the orphaned key harmlessly (validation is write-time).
     */
    const archive = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const field = yield* getById(id)
          const rows = yield* sql<FieldRow>`
            UPDATE fields SET archived_at = COALESCE(archived_at, now())
            WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          yield* events.append({
            subjectKind: "field",
            subjectId: id,
            eventType: "FieldArchived",
            payload: { _tag: "FieldArchived", conceptId: field.conceptId, name: field.name },
          })
          return toField(rows[0]!)
        }),
      )

    /** Restore an archived field. Fails FieldNameConflict if a live field on the
     *  same concept took its name meanwhile (the name index is partial). */
    const restore = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const field = yield* getById(id)
          const clash = yield* sql<{ readonly id: string }>`
            SELECT id FROM fields
            WHERE concept_id = ${field.conceptId} AND name = ${field.name}
              AND archived_at IS NULL AND id <> ${id} LIMIT 1`
          if (clash[0]) {
            return yield* Effect.fail(
              new FieldNameConflict({ conceptId: field.conceptId, name: field.name }),
            )
          }
          const rows = yield* sql<FieldRow>`
            UPDATE fields SET archived_at = NULL WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          yield* events.append({
            subjectKind: "field",
            subjectId: id,
            eventType: "FieldRestored",
            payload: { _tag: "FieldRestored", conceptId: field.conceptId, name: field.name },
          })
          return toField(rows[0]!)
        }),
      )

    /** Permanently delete a field def. Refused while relation edges still
     *  reference it (the FK would block it anyway) — archive instead. Orphaned
     *  instance.state keys for a purged field become unresolvable (raw id shows). */
    const purge = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const field = yield* getById(id)
          const counts = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM relations
            WHERE org_id = ${orgId} AND field_id = ${id}`
          const relationCount = Number(counts[0]?.count ?? 0)
          if (relationCount > 0) {
            return yield* Effect.fail(new FieldInUse({ field: field.name, relationCount }))
          }
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

    /** Batch-set field display positions (drag reorder in the concept settings
     *  editor). Scoped to one concept so an id from another concept can't be
     *  moved; returns the concept's refreshed field list (incl. archived, as the
     *  editor shows them). Pure presentation — no event is emitted. */
    const reorder = (
      conceptId: string,
      orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* Effect.forEach(
            orders,
            (o) =>
              sql`UPDATE fields SET position = ${o.position}
              WHERE org_id = ${orgId} AND concept_id = ${conceptId} AND id = ${o.id}`,
          )
          return yield* listFields(conceptId, { includeArchived: true })
        }),
      )

    return { addField, listFields, getById, update, archive, restore, purge, reorder } as const
  }),
  dependencies: [EventStore.Default],
}) {}
