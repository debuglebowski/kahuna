import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { ConceptInUse, ConceptNameConflict, ConceptNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type ConceptRow, toConcept } from "./rows"

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
          const rows = yield* sql<ConceptRow>`
            INSERT INTO concepts (org_id, name, description)
            VALUES (${orgId}, ${input.name}, ${input.description ?? null})
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

    /** Edit a concept's description. Name is immutable (the app refs concepts by name). */
    const update = (input: { readonly id: string; readonly description: string | null }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<ConceptRow>`
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
            payload: { _tag: "ConceptUpdated", description: concept.description },
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

    return { create, getByName, getById, list, update, remove } as const
  }),
  dependencies: [EventStore.Default],
}) {}
