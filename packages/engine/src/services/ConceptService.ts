import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { ConceptInUse, ConceptNameConflict, ConceptNotFound } from "../errors"
import { EventStore } from "./EventStore"
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

    const create = (input: { readonly name: string; readonly description?: string }) =>
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
            INSERT INTO concepts (org_id, slug, name, description)
            VALUES (${orgId}, ${slug}, ${input.name}, ${input.description ?? null})
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
     * Edit a concept's description and/or rename it. The app refers to concepts
     * by id, so renaming is safe; the (org, name) uniqueness constraint still
     * holds, so a clashing new name fails with ConceptNameConflict.
     */
    const update = (input: {
      readonly id: string
      readonly description: string | null
      readonly name?: string
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const name = input.name?.trim()
          if (name) {
            const clash = yield* sql<{ readonly id: string }>`
              SELECT id FROM concepts
              WHERE org_id = ${orgId} AND name = ${name} AND id <> ${input.id} LIMIT 1`
            if (clash[0]) return yield* Effect.fail(new ConceptNameConflict({ name }))
          }
          const rows = name
            ? yield* sql<ConceptRow>`
                UPDATE concepts SET description = ${input.description}, name = ${name}
                WHERE org_id = ${orgId} AND id = ${input.id}
                RETURNING *`
            : yield* sql<ConceptRow>`
                UPDATE concepts SET description = ${input.description}
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
  dependencies: [EventStore.Default],
}) {}
