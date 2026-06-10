import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { AnnotationField, AnnotationType, FieldConfig, FieldKind } from "../domain/types"
import {
  AnnotationFieldConfigInvalid,
  AnnotationFieldNameConflict,
  AnnotationFieldNotFound,
} from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AnnotationFieldRow, toAnnotationField } from "./rows"

export interface AddAnnotationFieldInput {
  readonly annotationType: AnnotationType
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  readonly icon?: string | null
}

const TEXT_FORMATS = new Set(["email", "url", "phone", "slug", "color"])
const NUMBER_FORMATS = new Set(["percent"])
/** Custom fields on annotations are scalars only — relation/computed/file make no
 *  sense in a flat per-row bag. */
const SCALAR_KINDS = new Set<FieldKind>([
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "user",
  "json",
  "money",
])

const validateConfig = (
  ctx: { readonly annotationType: string; readonly name: string },
  kind: FieldKind,
  config: FieldConfig,
) =>
  Effect.gen(function* () {
    const invalid = (reason: string) =>
      Effect.fail(
        new AnnotationFieldConfigInvalid({
          annotationType: ctx.annotationType,
          name: ctx.name,
          reason,
        }),
      )
    if (!SCALAR_KINDS.has(kind)) {
      return yield* invalid(`kind "${kind}" is not allowed on annotation custom fields`)
    }
    if (kind === "enum" && (!config.options || config.options.length === 0)) {
      return yield* invalid("enum field requires non-empty config.options")
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
  })

/**
 * Custom-field DEFINITIONS for the annotation layer — the schema-as-data for
 * notes/tasks, scoped by `annotationType` instead of a concept. A near-clone of
 * `FieldService`, restricted to scalar kinds. Admin-gated at the RPC boundary.
 */
export class AnnotationFieldService extends Effect.Service<AnnotationFieldService>()(
  "engine/AnnotationFieldService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore

      const list = (
        annotationType: AnnotationType,
        opts: { readonly includeArchived?: boolean } = {},
      ): Effect.Effect<ReadonlyArray<AnnotationField>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
          const rows = yield* sql<AnnotationFieldRow>`
            SELECT * FROM annotation_fields
            WHERE org_id = ${orgId} AND annotation_type = ${annotationType}${liveOnly}
            ORDER BY position ASC, name ASC`
          return rows.map(toAnnotationField)
        }).pipe(Effect.orDie)

      const getById = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AnnotationFieldRow>`
            SELECT * FROM annotation_fields WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AnnotationFieldNotFound({ fieldId: id }))
          return toAnnotationField(row)
        })

      const add = (input: AddAnnotationFieldInput) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const config = input.config ?? {}
            yield* validateConfig(
              { annotationType: input.annotationType, name: input.name },
              input.kind,
              config,
            )
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM annotation_fields
              WHERE org_id = ${orgId} AND annotation_type = ${input.annotationType}
                AND name = ${input.name} AND archived_at IS NULL LIMIT 1`
            if (existing[0]) {
              return yield* Effect.fail(
                new AnnotationFieldNameConflict({
                  annotationType: input.annotationType,
                  name: input.name,
                }),
              )
            }
            const max = yield* sql<{ readonly max: number | string | null }>`
              SELECT MAX(position) AS max FROM annotation_fields
              WHERE org_id = ${orgId} AND annotation_type = ${input.annotationType}`
            const position = Number(max[0]?.max ?? -1) + 1
            const rows = yield* sql<AnnotationFieldRow>`
              INSERT INTO annotation_fields (org_id, annotation_type, name, kind, config, icon, position)
              VALUES (${orgId}, ${input.annotationType}, ${input.name}, ${input.kind}, ${sql.json(config)}, ${input.icon ?? null}, ${position})
              RETURNING *`
            const field = toAnnotationField(rows[0]!)
            yield* events.append({
              subjectKind: "annotationField",
              subjectId: field.id,
              eventType: "AnnotationFieldAdded",
              payload: {
                _tag: "AnnotationFieldAdded",
                annotationType: field.annotationType,
                name: field.name,
                kind: field.kind,
              },
            })
            return field
          }),
        )

      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly config?: FieldConfig
        readonly icon?: string | null
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const current = yield* getById(input.id)
            const name = input.name ?? current.name
            const config = input.config ?? current.config
            yield* validateConfig(
              { annotationType: current.annotationType, name },
              current.kind,
              config,
            )
            if (name !== current.name) {
              const clash = yield* sql<{ readonly id: string }>`
                SELECT id FROM annotation_fields
                WHERE org_id = ${orgId} AND annotation_type = ${current.annotationType}
                  AND name = ${name} AND archived_at IS NULL AND id <> ${input.id} LIMIT 1`
              if (clash[0]) {
                return yield* Effect.fail(
                  new AnnotationFieldNameConflict({
                    annotationType: current.annotationType,
                    name,
                  }),
                )
              }
            }
            const icon = input.icon === undefined ? current.icon : input.icon
            const rows = yield* sql<AnnotationFieldRow>`
              UPDATE annotation_fields SET name = ${name}, config = ${sql.json(config)}, icon = ${icon}
              WHERE org_id = ${orgId} AND id = ${input.id} RETURNING *`
            const field = toAnnotationField(rows[0]!)
            yield* events.append({
              subjectKind: "annotationField",
              subjectId: field.id,
              eventType: "AnnotationFieldUpdated",
              payload: {
                _tag: "AnnotationFieldUpdated",
                annotationType: field.annotationType,
                name: field.name,
                kind: field.kind,
              },
            })
            return field
          }),
        )

      const archive = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const field = yield* getById(id)
            const rows = yield* sql<AnnotationFieldRow>`
              UPDATE annotation_fields SET archived_at = COALESCE(archived_at, now())
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "annotationField",
              subjectId: id,
              eventType: "AnnotationFieldArchived",
              payload: { _tag: "AnnotationFieldArchived", annotationType: field.annotationType },
            })
            return toAnnotationField(rows[0]!)
          }),
        )

      const restore = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const field = yield* getById(id)
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM annotation_fields
              WHERE org_id = ${orgId} AND annotation_type = ${field.annotationType}
                AND name = ${field.name} AND archived_at IS NULL AND id <> ${id} LIMIT 1`
            if (clash[0]) {
              return yield* Effect.fail(
                new AnnotationFieldNameConflict({
                  annotationType: field.annotationType,
                  name: field.name,
                }),
              )
            }
            const rows = yield* sql<AnnotationFieldRow>`
              UPDATE annotation_fields SET archived_at = NULL
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "annotationField",
              subjectId: id,
              eventType: "AnnotationFieldRestored",
              payload: { _tag: "AnnotationFieldRestored", annotationType: field.annotationType },
            })
            return toAnnotationField(rows[0]!)
          }),
        )

      const reorder = (
        annotationType: AnnotationType,
        orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* Effect.forEach(
              orders,
              (o) =>
                sql`UPDATE annotation_fields SET position = ${o.position}
                  WHERE org_id = ${orgId} AND annotation_type = ${annotationType} AND id = ${o.id}`,
            )
            yield* events.append({
              subjectKind: "annotationField",
              subjectId: orders[0]?.id ?? annotationType,
              eventType: "AnnotationFieldReordered",
              payload: { _tag: "AnnotationFieldReordered", annotationType },
            })
            return yield* list(annotationType, { includeArchived: true })
          }),
        )

      return { list, getById, add, update, archive, restore, reorder } as const
    }),
    dependencies: [EventStore.Default],
  },
) {}
