import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Id } from "../domain/types"
import {
  FieldNotFound,
  FieldValidationError,
  InstanceNotFound,
  RelationNotFound,
  RelationTargetMismatch,
} from "../errors"
import { EventStore } from "./EventStore"
import { FieldService } from "./FieldService"
import { OrgContext } from "./OrgContext"
import { type RelationRow, toRelation } from "./rows"

export interface CreateRelationInput {
  /** The relation field def (kind=relation) this edge realises. */
  readonly fieldId: Id
  readonly fromId: Id
  readonly toId: Id
  readonly properties?: Record<string, unknown>
}

/** Typed graph edges between instances. Event-sourced like instances. */
export class RelationService extends Effect.Service<RelationService>()("engine/RelationService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore
    const fieldsSvc = yield* FieldService

    const conceptIdOf = (orgId: string, instanceId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly concept_id: string }>`
          SELECT concept_id FROM instances
          WHERE id = ${instanceId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
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
          const field = yield* fieldsSvc.getById(input.fieldId)
          if (field.archivedAt !== null)
            return yield* Effect.fail(new FieldNotFound({ fieldId: input.fieldId }))
          if (field.kind !== "relation")
            return yield* Effect.fail(
              new FieldValidationError({
                message: `field "${field.name}" is not a relation`,
                field: field.name,
              }),
            )

          const fromConceptId = yield* conceptIdOf(orgId, input.fromId)
          const toConceptId = yield* conceptIdOf(orgId, input.toId)

          // `from` must be an instance of the concept that declares this field.
          if (fromConceptId !== field.conceptId) {
            const [expectedName, actualName] = yield* Effect.all([
              nameOfConcept(orgId, field.conceptId),
              nameOfConcept(orgId, fromConceptId),
            ])
            return yield* Effect.fail(
              new RelationTargetMismatch({
                relationType: field.name,
                expected: expectedName,
                actual: actualName,
              }),
            )
          }
          // `to` must match the field's declared target concept (if any).
          const target = field.config.target
          if (target && target !== toConceptId) {
            const [expectedName, actualName] = yield* Effect.all([
              nameOfConcept(orgId, target),
              nameOfConcept(orgId, toConceptId),
            ])
            return yield* Effect.fail(
              new RelationTargetMismatch({
                relationType: field.name,
                expected: expectedName,
                actual: actualName,
              }),
            )
          }

          const rows = yield* sql<RelationRow>`
            INSERT INTO relations (org_id, field_id, from_id, to_id, properties)
            VALUES (${orgId}, ${input.fieldId}, ${input.fromId}, ${input.toId}, ${sql.json(input.properties ?? {})})
            RETURNING *`
          const relation = toRelation(rows[0]!)
          yield* events.append({
            subjectKind: "relation",
            subjectId: relation.id,
            eventType: "RelationCreated",
            payload: {
              _tag: "RelationCreated",
              fieldId: relation.fieldId,
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
            WHERE id = ${input.relationId} AND org_id = ${orgId} AND archived_at IS NULL FOR UPDATE`
          if (!rows[0])
            return yield* Effect.fail(new RelationNotFound({ relationId: input.relationId }))
          const updated = yield* sql<RelationRow>`
            UPDATE relations SET archived_at = now()
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

    const listFrom = (fromId: Id, fieldId?: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = fieldId
          ? yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND from_id = ${fromId} AND field_id = ${fieldId} AND archived_at IS NULL
              ORDER BY created_at ASC`
          : yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND from_id = ${fromId} AND archived_at IS NULL ORDER BY created_at ASC`
        return rows.map(toRelation)
      })

    const listTo = (toId: Id, fieldId?: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = fieldId
          ? yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND to_id = ${toId} AND field_id = ${fieldId} AND archived_at IS NULL
              ORDER BY created_at ASC`
          : yield* sql<RelationRow>`
              SELECT * FROM relations
              WHERE org_id = ${orgId} AND to_id = ${toId} AND archived_at IS NULL ORDER BY created_at ASC`
        return rows.map(toRelation)
      })

    return { create, remove, listFrom, listTo } as const
  }),
  dependencies: [EventStore.Default, FieldService.Default],
}) {}
