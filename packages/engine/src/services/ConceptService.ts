import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { ConceptInUse, ConceptNameConflict, ConceptNotFound, LabelNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { LabelService } from "./LabelService"
import { OrgContext } from "./OrgContext"
import { type ConceptRow, toConcept } from "./rows"

/** Derive a stable system key from a display name (lowercase, alnum + underscore). */
const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "concept"

/** Manages concept definitions (the "types" — Account, Deal, …). */
export class ConceptService extends Effect.Service<ConceptService>()("engine/ConceptService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore
    const labels = yield* LabelService

    const getByName = (name: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} AND name = ${name} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: name }))
        return toConcept(row)
      })

    const getById = (id: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: id }))
        return toConcept(row)
      })

    /** Look up a concept by its stable slug (the handle the app pins by). */
    const getBySlug = (slug: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} AND slug = ${slug} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: slug }))
        return toConcept(row)
      })

    const list = () =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ConceptRow>`
          SELECT * FROM concepts WHERE org_id = ${orgId} ORDER BY name ASC`
        return rows.map(toConcept)
      })

    const create = (input: {
      readonly name: string
      // Optional plural display label; the UI create flow omits it (singular
      // only), but the seed supplies sensible plurals for the built-in concepts.
      readonly pluralName?: string | null
      readonly description?: string
      readonly icon?: string | null
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM concepts WHERE org_id = ${orgId} AND name = ${input.name} LIMIT 1`
          if (existing[0]) return yield* Effect.fail(new ConceptNameConflict({ name: input.name }))
          // Derive a stable, unique slug from the initial name (suffix on collision).
          const all = yield* sql<{ readonly slug: string }>`
            SELECT slug FROM concepts WHERE org_id = ${orgId}`
          const used = new Set(all.map((r) => r.slug))
          const base = slugify(input.name)
          let slug = base
          for (let n = 2; used.has(slug); n++) slug = `${base}_${n}`
          const rows = yield* sql<ConceptRow>`
            INSERT INTO concepts (org_id, slug, name, plural_name, description, icon)
            VALUES (${orgId}, ${slug}, ${input.name}, ${input.pluralName?.trim() || null}, ${input.description ?? null}, ${input.icon ?? null})
            RETURNING *`
          const concept = toConcept(rows[0]!)
          yield* events.append({
            subjectKind: "concept",
            subjectId: concept.id,
            eventType: "ConceptCreated",
            payload: { _tag: "ConceptCreated", name: concept.name },
          })
          return concept
        }),
      )

    /**
     * Edit a concept's description, rename it, and/or set its static/default
     * label-id sets. The app refers to concepts by id, so renaming is safe; the
     * (org, name) uniqueness constraint still holds, so a clashing new name
     * fails with ConceptNameConflict. Omitted label arrays are left unchanged
     * (so the name/description "Save" path never wipes the label sets).
     */
    const update = (input: {
      readonly id: string
      readonly description: string | null
      readonly name?: string
      // Omitted → left unchanged; explicit null / blank → cleared.
      readonly pluralName?: string | null
      // Omitted → left unchanged; explicit null → cleared.
      readonly icon?: string | null
      readonly staticLabelIds?: ReadonlyArray<string>
      readonly defaultLabelIds?: ReadonlyArray<string>
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const current = yield* getById(input.id)
          const name = input.name?.trim()
          if (name && name !== current.name) {
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM concepts
              WHERE org_id = ${orgId} AND name = ${name} AND id <> ${input.id} LIMIT 1`
            if (clash[0]) return yield* Effect.fail(new ConceptNameConflict({ name }))
          }
          // Reject any provided label id that isn't a live vocabulary entry.
          const provided = [...(input.staticLabelIds ?? []), ...(input.defaultLabelIds ?? [])]
          if (provided.length > 0) {
            const live = yield* labels.existingIds(provided)
            const missing = provided.find((id) => !live.has(id))
            if (missing) return yield* Effect.fail(new LabelNotFound({ labelId: missing }))
          }
          const finalName = name || current.name
          // Omitted → keep; provided → trim, treating blank as "cleared" (null).
          const pluralName =
            input.pluralName === undefined ? current.pluralName : input.pluralName?.trim() || null
          const icon = input.icon === undefined ? current.icon : input.icon
          const staticIds = [...new Set(input.staticLabelIds ?? current.staticLabelIds)]
          const defaultIds = [...new Set(input.defaultLabelIds ?? current.defaultLabelIds)]
          // Bind the id arrays as JSON text + cast: `sql.json` serialises a
          // top-level array as a Postgres array literal (`{…}`), not jsonb.
          const rows = yield* sql<ConceptRow>`
            UPDATE concepts
            SET description = ${input.description}, name = ${finalName},
                plural_name = ${pluralName}, icon = ${icon},
                static_label_ids = ${JSON.stringify(staticIds)}::jsonb,
                default_label_ids = ${JSON.stringify(defaultIds)}::jsonb
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new ConceptNotFound({ concept: input.id }))
          const concept = toConcept(row)
          yield* events.append({
            subjectKind: "concept",
            subjectId: concept.id,
            eventType: "ConceptUpdated",
            payload: {
              _tag: "ConceptUpdated",
              description: concept.description,
              ...(name ? { name: concept.name } : {}),
              ...(input.pluralName !== undefined ? { pluralName: concept.pluralName } : {}),
              ...(input.icon !== undefined ? { icon: concept.icon } : {}),
              ...(input.staticLabelIds ? { staticLabelIds: concept.staticLabelIds } : {}),
              ...(input.defaultLabelIds ? { defaultLabelIds: concept.defaultLabelIds } : {}),
            },
          })
          return concept
        }),
      )

    /** Delete a concept (and its field defs). Refused while any live instance exists. */
    const remove = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const concept = yield* getById(id)
          const counts = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM instances
            WHERE org_id = ${orgId} AND concept_id = ${id} AND deleted_at IS NULL`
          const instanceCount = Number(counts[0]?.count ?? 0)
          if (instanceCount > 0) {
            return yield* Effect.fail(new ConceptInUse({ concept: concept.name, instanceCount }))
          }
          yield* sql`DELETE FROM fields WHERE org_id = ${orgId} AND concept_id = ${id}`
          yield* sql`DELETE FROM concepts WHERE org_id = ${orgId} AND id = ${id}`
          yield* events.append({
            subjectKind: "concept",
            subjectId: id,
            eventType: "ConceptDeleted",
            payload: { _tag: "ConceptDeleted" },
          })
          return concept
        }),
      )

    return { create, getByName, getById, getBySlug, list, update, remove } as const
  }),
  dependencies: [EventStore.Default, LabelService.Default],
}) {}
