import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { ConceptNameConflict, ConceptNotFound } from "../errors"
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

    return { create, getByName, getById, list } as const
  }),
  dependencies: [EventStore.Default],
}) {}
