import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { Id } from "../domain/types"
import { canEditVersion } from "../domain/versioning"
import { scopeCanReadConcept } from "../domain/visibility"
import {
  FieldNotFound,
  FieldValidationError,
  InstanceNotFound,
  ItemNotFound,
  ItemNotPublished,
  RelationNotFound,
  RelationPinToDraft,
  RelationTargetMismatch,
  VersionFrozen,
} from "../errors"
import { EventStore } from "./EventStore"
import { FieldService } from "./FieldService"
import { OrgContext } from "./OrgContext"
import { type RelationRow, toRelation, toVisibility } from "./rows"

export interface CreateRelationInput {
  /** The relation field def (kind=relation) this edge realises. */
  readonly fieldId: Id
  readonly fromId: Id
  /** Target — supply exactly one shape:
   *  - `toVersionId`: pin a specific PUBLISHED version.
   *  - `toItemId`: reference the item in general ("Latest" published).
   *  - `toId` (legacy): an instance id, treated as a general ref to its item. */
  readonly toItemId?: Id
  readonly toVersionId?: Id
  readonly toId?: Id
  readonly properties?: Record<string, unknown>
}

/** Typed graph edges between instances. Event-sourced like instances. */
export class RelationService extends Effect.Service<RelationService>()("engine/RelationService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore
    const fieldsSvc = yield* FieldService

    /**
     * The edge SOURCE: its concept plus what's needed to decide whether that
     * version's links may be rewritten. Links hang off a specific version row
     * (`relations.from_id`) and `newVersion` clones them onto each new draft, so a
     * frozen version's edges must be frozen too — otherwise the freeze leaks.
     *
     * Joined here in raw SQL rather than taking a `ConceptService` dep: it matches
     * this service's existing style and keeps it to one round-trip.
     */
    const sourceOf = (orgId: string, instanceId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly concept_id: string
          readonly version_status: string
          readonly versioning_enabled: boolean
          readonly edit_reach: string | null
        }>`
          SELECT i.concept_id, i.version_status, c.versioning_enabled, c.edit_reach
          FROM instances i JOIN concepts c ON c.id = i.concept_id AND c.org_id = i.org_id
          WHERE i.id = ${instanceId} AND i.org_id = ${orgId} AND i.archived_at IS NULL LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return {
          conceptId: row.concept_id,
          editable: canEditVersion(
            {
              versioningEnabled: row.versioning_enabled ?? false,
              editReach: row.edit_reach === "any" ? "any" : "draft",
            },
            { versionStatus: row.version_status === "draft" ? "draft" : "published" },
          ),
        }
      })

    /** Fail unless the source version's links may be rewritten. */
    const assertSourceEditable = (orgId: string, instanceId: string) =>
      Effect.flatMap(sourceOf(orgId, instanceId), (src) =>
        src.editable ? Effect.succeed(src) : Effect.fail(new VersionFrozen({ instanceId })),
      )

    const nameOfConcept = (orgId: string, conceptId: string) =>
      sql<{ readonly name: string }>`
        SELECT name FROM concepts WHERE id = ${conceptId} AND org_id = ${orgId} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.name ?? conceptId),
      )

    /** The id of an item's latest published, non-archived version (null if none). */
    const latestPublished = (orgId: string, itemId: string) =>
      sql<{ readonly id: string }>`
        SELECT id FROM instances
        WHERE org_id = ${orgId} AND item_id = ${itemId}
          AND version_status = 'published' AND archived_at IS NULL
        ORDER BY version_seq DESC LIMIT 1`.pipe(Effect.map((r) => r[0]?.id ?? null))

    /** Normalise a target into (itemId, versionId|null, conceptId, shadow toId). */
    /** Fail unless the caller may read `conceptId`. Without this a member could
     *  LINK into a restricted concept and then read the target's id (and its
     *  concept) straight back out of `listFrom`. Errors as if the target does not
     *  exist, so it is not an existence oracle either. */
    const assertTargetReadable = (conceptId: string, targetId: string) =>
      Effect.gen(function* () {
        const scope = yield* OrgContext
        const rows = yield* sql<{ readonly visibility: string | null }>`
          SELECT visibility FROM concepts WHERE id = ${conceptId} LIMIT 1`
        const _visibility = toVisibility(rows[0]?.visibility ?? null)
        if (!scopeCanReadConcept(scope, conceptId))
          return yield* Effect.fail(new InstanceNotFound({ instanceId: targetId }))
      })

    const resolveTargetRaw = (orgId: string, input: CreateRelationInput) =>
      Effect.gen(function* () {
        // Pinned: must reference a live, published version.
        if (input.toVersionId) {
          const rows = yield* sql<{
            readonly concept_id: string
            readonly item_id: string
            readonly version_status: string
            readonly archived_at: Date | null
          }>`
            SELECT concept_id, item_id, version_status, archived_at FROM instances
            WHERE id = ${input.toVersionId} AND org_id = ${orgId} LIMIT 1`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(new InstanceNotFound({ instanceId: input.toVersionId }))
          if (row.version_status !== "published" || row.archived_at !== null) {
            return yield* Effect.fail(new RelationPinToDraft({ versionId: input.toVersionId }))
          }
          return {
            itemId: row.item_id,
            versionId: input.toVersionId as string | null,
            conceptId: row.concept_id,
            shadowToId: input.toVersionId,
          }
        }
        // General: reference the item; resolve to its latest published head.
        if (input.toItemId) {
          const itemRows = yield* sql<{ readonly concept_id: string }>`
            SELECT concept_id FROM items WHERE id = ${input.toItemId} AND org_id = ${orgId} LIMIT 1`
          const it = itemRows[0]
          if (!it) return yield* Effect.fail(new ItemNotFound({ itemId: input.toItemId }))
          const head = yield* latestPublished(orgId, input.toItemId)
          if (!head) return yield* Effect.fail(new ItemNotPublished({ itemId: input.toItemId }))
          return {
            itemId: input.toItemId,
            versionId: null,
            conceptId: it.concept_id,
            shadowToId: head,
          }
        }
        // Legacy: an instance id ⇒ general ref to that instance's item.
        if (input.toId) {
          const rows = yield* sql<{ readonly concept_id: string; readonly item_id: string }>`
            SELECT concept_id, item_id FROM instances
            WHERE id = ${input.toId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId: input.toId }))
          const head = yield* latestPublished(orgId, row.item_id)
          if (!head) return yield* Effect.fail(new ItemNotPublished({ itemId: row.item_id }))
          return {
            itemId: row.item_id,
            versionId: null,
            conceptId: row.concept_id,
            shadowToId: head,
          }
        }
        return yield* Effect.fail(
          new FieldValidationError({
            message: "relation target required (toItemId, toVersionId, or toId)",
            field: "toId",
          }),
        )
      })

    /** `resolveTargetRaw` + the read gate — every target branch funnels through it. */
    const resolveTarget = (orgId: string, input: CreateRelationInput) =>
      Effect.gen(function* () {
        const target = yield* resolveTargetRaw(orgId, input)
        yield* assertTargetReadable(target.conceptId, target.itemId)
        return target
      })

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

          // Guard the SOURCE before the target: a frozen version accepts no new links.
          const { conceptId: fromConceptId } = yield* assertSourceEditable(orgId, input.fromId)
          const target = yield* resolveTarget(orgId, input)

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
          const declaredTarget = field.config.target
          if (declaredTarget && declaredTarget !== target.conceptId) {
            const [expectedName, actualName] = yield* Effect.all([
              nameOfConcept(orgId, declaredTarget),
              nameOfConcept(orgId, target.conceptId),
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
            INSERT INTO relations (org_id, field_id, from_id, to_item_id, to_version_id, to_id, properties)
            VALUES (${orgId}, ${input.fieldId}, ${input.fromId}, ${target.itemId}, ${target.versionId}, ${target.shadowToId}, ${sql.json(input.properties ?? {})})
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
              toItemId: relation.toItemId,
              toVersionId: relation.toVersionId,
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
          const existing = rows[0]
          if (!existing)
            return yield* Effect.fail(new RelationNotFound({ relationId: input.relationId }))
          // Removing an edge mutates the source version just as adding one does.
          yield* assertSourceEditable(orgId, existing.from_id)
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

    /** Inbound edges referencing the given instance's ITEM in general, plus any
     *  pinned to that specific version. Edges originating from an unpublished draft
     *  are excluded (a draft is private — never a public reference). */
    const listTo = (toId: Id, fieldId?: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const inst = yield* sql<{ readonly item_id: string }>`
          SELECT item_id FROM instances WHERE id = ${toId} AND org_id = ${orgId} LIMIT 1`
        const itemId = inst[0]?.item_id ?? toId
        const fieldFilter = fieldId ? sql` AND r.field_id = ${fieldId}` : sql``
        const rows = yield* sql<RelationRow>`
          SELECT r.* FROM relations r
          JOIN instances src ON src.id = r.from_id
            AND src.version_status = 'published' AND src.archived_at IS NULL
          WHERE r.org_id = ${orgId} AND r.archived_at IS NULL${fieldFilter}
            AND (r.to_item_id = ${itemId} OR r.to_version_id = ${toId})
          ORDER BY r.created_at ASC`
        return rows.map(toRelation)
      })

    return { create, remove, listFrom, listTo, latestPublished } as const
  }),
  dependencies: [EventStore.Default, FieldService.Default],
}) {}
