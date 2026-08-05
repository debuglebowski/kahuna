import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { ConceptVisibility, Field, FieldConfig, FieldKind } from "../domain/types"
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
  /** Integration ownership marker (see `Field.managedBy`): set by a connector
   *  sync for a read-only synced field; omit (→ null) for a user-added field. */
  readonly managedBy?: string | null
}

/** Recognised `config.format` names per kind (value validators live in RecordService). */
const TEXT_FORMATS = new Set(["email", "url", "phone", "slug", "color"])
const NUMBER_FORMATS = new Set(["percent"])

/** Kinds whose values have a meaningful equality for `config.unique`. Excludes
 *  bool (two records max), json/richtext (deep-equality on blobs), and the
 *  non-settable kinds (relation/file/computed). */
const UNIQUE_KINDS = new Set<FieldKind>(["text", "number", "date", "enum", "user", "money"])

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
    if ((config.inverseName || config.inversePluralName) && kind !== "relation") {
      return yield* invalid("config.inverseName is only valid on relation fields")
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
    if (config.unique) {
      if (!UNIQUE_KINDS.has(kind)) {
        return yield* invalid(
          "config.unique is only valid on text/number/date/enum/user/money fields",
        )
      }
      if (config.multiple) {
        return yield* invalid("config.unique cannot be combined with config.multiple")
      }
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

    /** Live relation fields (across all concepts) whose declared target is the
     *  given concept — the inbound side of its connections. Fields on archived
     *  concepts are excluded (their edges are dormant alongside the concept). */
    const listRelationFieldsTargeting = (
      conceptId: string,
    ): Effect.Effect<ReadonlyArray<Field>, never, OrgContext> =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<FieldRow>`
          SELECT f.* FROM fields f
          JOIN concepts c ON c.id = f.concept_id AND c.archived_at IS NULL
          WHERE f.org_id = ${orgId} AND f.kind = 'relation' AND f.archived_at IS NULL
            AND f.config->>'target' = ${conceptId}
          ORDER BY f.position ASC, f.name ASC`
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
            INSERT INTO fields (org_id, concept_id, name, kind, formula, config, managed_by, icon, position)
            VALUES (${orgId}, ${input.conceptId}, ${input.name}, ${input.kind}, ${input.formula ?? null}, ${sql.json(config)}, ${input.managedBy ?? null}, ${input.icon ?? null}, ${position})
            RETURNING *`
          const field = toField(rows[0]!)
          // Auto-designate the first scalar field as the concept's title (display
          // label) when none is set yet — so every concept carries an explicit
          // title field instead of relying on a runtime heuristic. Only when null
          // (idempotent); relation/file fields can't be a title. A managed
          // provision overrides this with its declared title key afterward.
          if (field.kind !== "relation" && field.kind !== "file") {
            yield* sql`
              UPDATE concepts SET title_field_id = ${field.id}
              WHERE org_id = ${orgId} AND id = ${input.conceptId} AND title_field_id IS NULL`
          }
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
     * values. The name is free to change because record version state is keyed by
     * `id`, not by name.
     */
    /** Set who may READ this field's values. A narrow setter (like
     *  `ConceptService.setVisibility`) rather than part of `update`'s batched patch:
     *  it is a security control, so it must not ride along with a rename. */
    const setVisibility = (id: string, visibility: ConceptVisibility) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* getById(id) // 404 if missing / cross-org
          const rows = yield* sql<FieldRow>`
            UPDATE fields SET visibility = ${visibility}
            WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new FieldNotFound({ fieldId: id }))
          const field = toField(row)
          yield* events.append({
            subjectKind: "field",
            subjectId: field.id,
            eventType: "FieldUpdated",
            payload: {
              _tag: "FieldUpdated",
              conceptId: field.conceptId,
              name: field.name,
              kind: field.kind,
              visibility: field.visibility,
            },
          })
          return field
        }),
      )

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
          // Flipping `unique` ON must not grandfather existing duplicates — the
          // write-time check would silently never fire for them. Versions of one
          // record share values, so only cross-ITEM duplicates block the flip.
          // Archived rows count too: a value is only released by a purge.
          if (config.unique && !current.config.unique) {
            // Text dedupes case-insensitively (mirrors RecordService.checkUnique).
            const valueExpr =
              current.kind === "text" ? sql`lower(state->>${input.id})` : sql`state->${input.id}`
            const dupes = yield* sql<{ readonly count: number | string }>`
              SELECT COUNT(*)::int AS count FROM (
                SELECT 1 FROM record_versions
                WHERE org_id = ${orgId} AND concept_id = ${current.conceptId}
                  AND state->${input.id} IS NOT NULL
                  AND state->${input.id} NOT IN ('null'::jsonb, '""'::jsonb)
                GROUP BY ${valueExpr}
                HAVING COUNT(DISTINCT record_id) > 1
              ) AS dupes`
            const count = Number(dupes[0]?.count ?? 0)
            if (count > 0) {
              return yield* Effect.fail(
                new FieldConfigInvalid({
                  conceptId: current.conceptId,
                  name,
                  reason: `cannot enable unique: ${count} value(s) are duplicated across records`,
                }),
              )
            }
          }
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
     * record version.state keeps the orphaned key harmlessly (validation is write-time).
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
     *  record version.state keys for a purged field become unresolvable (raw id shows). */
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

    return {
      addField,
      listFields,
      listRelationFieldsTargeting,
      getById,
      update,
      setVisibility,
      archive,
      restore,
      purge,
      reorder,
    } as const
  }),
  dependencies: [EventStore.Default],
}) {}
