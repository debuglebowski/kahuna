import { PgClient } from "@effect/sql-pg"
import { Effect, Either } from "effect"
import type { Field, Instance, InstanceState } from "../domain/types"
import {
  FieldValidationError,
  IllegalTransition,
  InstanceNotFound,
  VersionConflict,
} from "../errors"
import { foldEvents } from "../projection/fold"
import { applyEvent } from "../projection/reducer"
import { ConceptService } from "./ConceptService"
import { EventStore } from "./EventStore"
import { FieldService } from "./FieldService"
import { OrgContext } from "./OrgContext"
import { type InstanceRow, toInstance } from "./rows"

const validateValue = (
  def: Field,
  value: unknown,
): Effect.Effect<unknown, FieldValidationError> => {
  const fail = (message: string) =>
    Effect.fail(new FieldValidationError({ message, field: def.name }))
  switch (def.kind) {
    case "text":
      return typeof value === "string"
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects text`)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a number`)
    case "bool":
      return typeof value === "boolean"
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a boolean`)
    case "date":
      if (value instanceof Date) return Effect.succeed(value.toISOString())
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects an ISO date`)
    case "enum":
      return typeof value === "string" && (def.config.options ?? []).includes(value)
        ? Effect.succeed(value)
        : fail(`field "${def.name}" must be one of ${(def.config.options ?? []).join(", ")}`)
    case "relation":
      return fail(`field "${def.name}" is a relation — use RelationService`)
    case "file":
      return fail(`field "${def.name}" is a file — use attachments`)
    case "computed":
      return fail(`field "${def.name}" is computed and cannot be set`)
  }
}

const validateFields = (defs: ReadonlyArray<Field>, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const byName = new Map(defs.map((d) => [d.name, d]))
    const out: InstanceState = {}
    for (const [key, value] of Object.entries(input)) {
      const def = byName.get(key)
      if (!def)
        return yield* Effect.fail(
          new FieldValidationError({ message: `unknown field "${key}"`, field: key }),
        )
      out[key] = yield* validateValue(def, value)
    }
    return out
  })

const checkTransitions = (
  defs: ReadonlyArray<Field>,
  current: InstanceState,
  patch: InstanceState,
) =>
  Effect.gen(function* () {
    for (const def of defs) {
      if (def.kind !== "enum" || !def.config.transitions) continue
      if (!(def.name in patch)) continue
      const to = patch[def.name]
      const from = current[def.name]
      if (from === undefined || from === to) continue
      const allowed = def.config.transitions[String(from)] ?? []
      if (!allowed.includes(String(to))) {
        return yield* Effect.fail(
          new IllegalTransition({
            field: def.name,
            from: String(from),
            to: String(to),
            allowed: [...allowed],
          }),
        )
      }
    }
  })

/**
 * The heart of the engine: instance writes. Every write runs inside one
 * `sql.withTransaction` — validate → (lock + version check) → append event →
 * fold via the shared reducer → persist projection + bump version.
 */
export class InstanceService extends Effect.Service<InstanceService>()("engine/InstanceService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore
    const concepts = yield* ConceptService
    const fields = yield* FieldService

    const loadAny = (instanceId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances WHERE id = ${instanceId} AND org_id = ${orgId} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return toInstance(row)
      })

    const create = (input: {
      readonly conceptName: string
      readonly fields: Record<string, unknown>
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const concept = yield* concepts.getByName(input.conceptName)
          const defs = yield* fields.listFields(concept.id)
          const validated = yield* validateFields(defs, input.fields)
          const inserted = yield* sql<InstanceRow>`
            INSERT INTO instances (org_id, concept_id, state, version)
            VALUES (${orgId}, ${concept.id}, ${sql.json({})}, 0)
            RETURNING *`
          const created = toInstance(inserted[0]!)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: created.id,
            eventType: "InstanceCreated",
            payload: { _tag: "InstanceCreated", conceptId: concept.id, fields: validated },
          })
          const folded = applyEvent(null, event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version}
            WHERE id = ${created.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    const update = (input: {
      readonly instanceId: string
      readonly expectedVersion: number
      readonly patch: Record<string, unknown>
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<InstanceRow>`
            SELECT * FROM instances
            WHERE id = ${input.instanceId} AND org_id = ${orgId} AND deleted_at IS NULL
            FOR UPDATE`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(new InstanceNotFound({ instanceId: input.instanceId }))
          const current = toInstance(row)
          if (current.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new VersionConflict({
                instanceId: current.id,
                expected: input.expectedVersion,
                actual: current.version,
              }),
            )
          }
          const defs = yield* fields.listFields(current.conceptId)
          const validated = yield* validateFields(defs, input.patch)
          yield* checkTransitions(defs, current.state, validated)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "InstanceUpdated",
            payload: { _tag: "InstanceUpdated", patch: validated },
          })
          const folded = applyEvent(
            { state: current.state, version: current.version, deletedAt: null },
            event,
          )
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    const transition = (input: {
      readonly instanceId: string
      readonly expectedVersion: number
      readonly field: string
      readonly to: string
    }) =>
      update({
        instanceId: input.instanceId,
        expectedVersion: input.expectedVersion,
        patch: { [input.field]: input.to },
      })

    const softDelete = (input: { readonly instanceId: string; readonly expectedVersion: number }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<InstanceRow>`
            SELECT * FROM instances
            WHERE id = ${input.instanceId} AND org_id = ${orgId} AND deleted_at IS NULL
            FOR UPDATE`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(new InstanceNotFound({ instanceId: input.instanceId }))
          const current = toInstance(row)
          if (current.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new VersionConflict({
                instanceId: current.id,
                expected: input.expectedVersion,
                actual: current.version,
              }),
            )
          }
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "InstanceDeleted",
            payload: { _tag: "InstanceDeleted" },
          })
          const folded = applyEvent(
            { state: current.state, version: current.version, deletedAt: null },
            event,
          )
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances SET version = ${folded.right.version}, deleted_at = ${folded.right.deletedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    const get = (instanceId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE id = ${instanceId} AND org_id = ${orgId} AND deleted_at IS NULL LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return toInstance(row)
      })

    const getAsOf = (instanceId: string, eventId: number) =>
      Effect.gen(function* () {
        const meta = yield* loadAny(instanceId)
        const stream = yield* events.readStream(instanceId, { upToEventId: eventId })
        const folded = foldEvents(stream)
        if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
        const fs = folded.right
        if (!fs) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return {
          id: meta.id,
          orgId: meta.orgId,
          conceptId: meta.conceptId,
          state: fs.state,
          version: fs.version,
          createdAt: meta.createdAt,
          deletedAt: fs.deletedAt,
        } satisfies Instance
      })

    const rebuild = (instanceId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const meta = yield* loadAny(instanceId)
          const stream = yield* events.readStream(instanceId)
          const folded = foldEvents(stream)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const fs = folded.right
          if (!fs) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
          const updated = yield* sql<InstanceRow>`
            UPDATE instances
            SET state = ${sql.json(fs.state)}, version = ${fs.version}, deleted_at = ${fs.deletedAt}
            WHERE id = ${meta.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    return { create, update, transition, softDelete, get, getAsOf, rebuild } as const
  }),
  dependencies: [ConceptService.Default, FieldService.Default, EventStore.Default],
}) {}
