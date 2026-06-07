import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Id } from "../domain/types"
import { InstanceNotFound, RelationNotFound, RelationTargetMismatch } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type RelationRow, toRelation } from "./rows"

export interface CreateRelationInput {
  readonly relationType: string
  readonly fromId: Id
  readonly toId: Id
  readonly properties?: Record<string, unknown>
}

/** Typed graph edges between instances. Event-sourced like instances. */
export class RelationService extends Effect.Service<RelationService>()("engine/RelationService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore

    const conceptIdOf = (orgId: string, instanceId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly concept_id: string }>`
          SELECT concept_id FROM instances
          WHERE id = ${instanceId} AND org_id = ${orgId} AND deleted_at IS NULL LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return row.concept_id
      })

    const nameOfConcept = (orgId: string, conceptId: string) =>
      sql<{ readonly name: string }>`
        SELECT name FROM concepts WHERE id = ${conceptId} AND org_id = ${orgId} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.name ?? conceptId),
      )

    const create = (input: CreateRelationInput) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* conceptIdOf(orgId, input.fromId)
          const toConceptId = yield* conceptIdOf(orgId, input.toId)

          // If this relation type is declared (a kind=relation field with a target
          // concept id), enforce that the target's concept matches.
          const decl = yield* sql<{ readonly target: string | null }>`
            SELECT (config->>'target') AS target FROM fields
            WHERE org_id = ${orgId} AND kind = 'relation'
              AND (config->>'relationType') = ${input.relationType}
              AND (config->>'target') IS NOT NULL
            LIMIT 1`
          const expected = decl[0]?.target
          if (expected && expected !== toConceptId) {
            const [expectedName, actualName] = yield* Effect.all([
              nameOfConcept(orgId, expected),
              nameOfConcept(orgId, toConceptId),
            ])
            return yield* Effect.fail(
              new RelationTargetMismatch({
                relationType: input.relationType,
                expected: expectedName,
                actual: actualName,
              }),
            )
          }

          const rows = yield* sql<RelationRow>`
            INSERT INTO relations (org_id, relation_type, from_id, to_id, properties)
            VALUES (${orgId}, ${input.relationType}, ${input.fromId}, ${input.toId}, ${sql.json(input.properties ?? {})})
            RETURNING *`
          const relation = toRelation(rows[0]!)
          yield* events.append({
            subjectKind: "relation",
            subjectId: relation.id,
            eventType: "RelationCreated",
            payload: {
              _tag: "RelationCreated",
              relationType: relation.relationType,
              fromId: relation.fromId,
              toId: relation.toId,
              properties: relation.properties,
            },
          })
          return relation
        }),
      )

    const remove = (input: { readonly relationId: Id }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<RelationRow>`
            SELECT * FROM relations
            WHERE id = ${input.relationId} AND org_id = ${orgId} AND deleted_at IS NULL FOR UPDATE`
          if (!rows[0])
            return yield* Effect.fail(new RelationNotFound({ relationId: input.relationId }))
          const updated = yield* sql<RelationRow>`
            UPDATE relations SET deleted_at = now()
            WHERE id = ${input.relationId} AND org_id = ${orgId} RETURNING *`
          yield* events.append({
            subjectKind: "relation",
            subjectId: input.relationId,
            eventType: "RelationDeleted",
            payload: { _tag: "RelationDeleted", relationId: input.relationId },
          })
          return toRelation(updated[0]!)
        }),
      )

    const listFrom = (fromId: Id, relationType?: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = relationType
          ? yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND from_id = ${fromId} AND relation_type = ${relationType} AND deleted_at IS NULL
              ORDER BY created_at ASC`
          : yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND from_id = ${fromId} AND deleted_at IS NULL ORDER BY created_at ASC`
        return rows.map(toRelation)
      })

    const listTo = (toId: Id, relationType?: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = relationType
          ? yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND to_id = ${toId} AND relation_type = ${relationType} AND deleted_at IS NULL
              ORDER BY created_at ASC`
          : yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND to_id = ${toId} AND deleted_at IS NULL ORDER BY created_at ASC`
        return rows.map(toRelation)
      })

    return { create, remove, listFrom, listTo } as const
  }),
  dependencies: [EventStore.Default],
}) {}
