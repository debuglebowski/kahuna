import { PgClient } from "@effect/sql-pg"
import { Effect, Either } from "effect"
import {
  type ConceptRef,
  type EngineEvent,
  type Field,
  type Instance,
  type InstanceState,
  LABELS_KEY,
} from "../domain/types"
import {
  FieldValidationError,
  IllegalTransition,
  InstanceInUse,
  InstanceNotFound,
  VersionConflict,
} from "../errors"
import { foldEvents } from "../projection/fold"
import { applyEvent } from "../projection/reducer"
import { ComputedFields } from "./ComputedFields"
import { ConceptService } from "./ConceptService"
import { EventStore } from "./EventStore"
import { FieldService } from "./FieldService"
import { LabelService } from "./LabelService"
import { OrgContext } from "./OrgContext"
import { type InstanceRow, toInstance } from "./rows"

/** Built-in `config.format` validators for text / number scalars. */
const TEXT_FORMATS: Record<string, (v: string) => boolean> = {
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  url: (v) => /^https?:\/\/\S+$/.test(v),
  phone: (v) => /^\+?[0-9][0-9 ().-]{4,}$/.test(v),
  slug: (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v),
  color: (v) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v),
}
const NUMBER_FORMATS: Record<string, (v: number) => boolean> = {
  percent: (v) => v >= 0 && v <= 100,
}

const isMoney = (v: unknown): v is { readonly amount: number; readonly currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount?: unknown }).amount === "number" &&
  Number.isFinite((v as { amount: number }).amount) &&
  typeof (v as { currency?: unknown }).currency === "string" &&
  /^[A-Z]{3}$/.test((v as { currency: string }).currency)

/** Validate a single (non-array) value against a field def. */
const validateScalar = (
  def: Field,
  value: unknown,
): Effect.Effect<unknown, FieldValidationError> => {
  const fail = (message: string) =>
    Effect.fail(new FieldValidationError({ message, field: def.name }))
  switch (def.kind) {
    case "text": {
      if (typeof value !== "string") return fail(`field "${def.name}" expects text`)
      const fmt = def.config.format
      if (fmt && TEXT_FORMATS[fmt] && !TEXT_FORMATS[fmt](value))
        return fail(`field "${def.name}" must be a valid ${fmt}`)
      return Effect.succeed(value)
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return fail(`field "${def.name}" expects a number`)
      const fmt = def.config.format
      if (fmt && NUMBER_FORMATS[fmt] && !NUMBER_FORMATS[fmt](value))
        return fail(`field "${def.name}" must be a valid ${fmt}`)
      return Effect.succeed(value)
    }
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
    // A reference to a real org member (bauth_user.id). The engine only checks
    // shape here — actual membership is enforced at the app boundary, exactly
    // like the org_id / actor logical FKs the engine never validates itself.
    case "user":
      return typeof value === "string" && value.length > 0
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a user id`)
    case "json":
      return value !== undefined
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a value`)
    case "money":
      return isMoney(value)
        ? Effect.succeed({ amount: value.amount, currency: value.currency })
        : fail(`field "${def.name}" expects { amount, currency }`)
    case "relation":
      return fail(`field "${def.name}" is a relation — use RelationService`)
    case "file":
      return fail(`field "${def.name}" is a file — use attachments`)
    case "computed":
      return fail(`field "${def.name}" is computed and cannot be set`)
  }
}

/** Validate a field value, fanning out over the array when `config.multiple`. */
const validateValue = (
  def: Field,
  value: unknown,
): Effect.Effect<unknown, FieldValidationError> => {
  if (def.config.multiple) {
    if (!Array.isArray(value))
      return Effect.fail(
        new FieldValidationError({
          message: `field "${def.name}" expects a list`,
          field: def.name,
        }),
      )
    return Effect.forEach(value, (v) => validateScalar(def, v))
  }
  return validateScalar(def, value)
}

const validateFields = (defs: ReadonlyArray<Field>, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const byId = new Map(defs.map((d) => [d.id, d]))
    const out: InstanceState = {}
    for (const [key, value] of Object.entries(input)) {
      const def = byId.get(key)
      if (!def)
        return yield* Effect.fail(
          new FieldValidationError({ message: `unknown field "${key}"`, field: key }),
        )
      out[key] = yield* validateValue(def, value)
    }
    return out
  })

/** Split the synthetic `__labels` key out of a write payload (it isn't a field,
 *  so it must bypass `validateFields`; it re-enters the event payload after). */
const splitLabels = (input: Record<string, unknown>) => {
  const { [LABELS_KEY]: rawLabels, ...rest } = input
  return { rest, rawLabels }
}

/** Coerce/validate a `__labels` value into a deduped label-id array. */
const coerceLabelIds = (
  raw: unknown,
): Effect.Effect<ReadonlyArray<string>, FieldValidationError> => {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    return Effect.fail(
      new FieldValidationError({
        message: "__labels must be an array of label ids",
        field: LABELS_KEY,
      }),
    )
  }
  return Effect.succeed([...new Set(raw as string[])])
}

const checkTransitions = (
  defs: ReadonlyArray<Field>,
  current: InstanceState,
  patch: InstanceState,
) =>
  Effect.gen(function* () {
    for (const def of defs) {
      if (def.kind !== "enum" || !def.config.transitions) continue
      if (!(def.id in patch)) continue
      const to = patch[def.id]
      const from = current[def.id]
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
    const computed = yield* ComputedFields
    const labels = yield* LabelService

    /** Reject any label id that isn't a live vocabulary entry. */
    const assertLabelsExist = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (ids.length === 0) return
        const live = yield* labels.existingIds(ids)
        const missing = ids.find((id) => !live.has(id))
        if (missing)
          return yield* Effect.fail(
            new FieldValidationError({
              message: `unknown label id "${missing}"`,
              field: LABELS_KEY,
            }),
          )
      })

    const loadAny = (instanceId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances WHERE id = ${instanceId} AND org_id = ${orgId} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return toInstance(row)
      })

    const create = (input: ConceptRef & { readonly fields: Record<string, unknown> }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const concept =
            "conceptId" in input
              ? yield* concepts.getById(input.conceptId)
              : yield* concepts.getByName(input.conceptName)
          const defs = yield* fields.listFields(concept.id)
          const { rest, rawLabels } = splitLabels(input.fields)
          const validated = yield* validateFields(defs, rest)
          // Per-item labels: use the caller's set if given, else snapshot the
          // concept's defaults (dropping any since soft-deleted). Static labels
          // are NOT written here — they're inherited at read time.
          let labelIds: ReadonlyArray<string>
          if (rawLabels === undefined) {
            const live = yield* labels.existingIds(concept.defaultLabelIds)
            labelIds = concept.defaultLabelIds.filter((id) => live.has(id))
          } else {
            labelIds = yield* coerceLabelIds(rawLabels)
            yield* assertLabelsExist(labelIds)
          }
          const fieldsWithLabels: InstanceState =
            labelIds.length > 0 ? { ...validated, [LABELS_KEY]: [...labelIds] } : validated
          const inserted = yield* sql<InstanceRow>`
            INSERT INTO instances (org_id, concept_id, state, version)
            VALUES (${orgId}, ${concept.id}, ${sql.json({})}, 0)
            RETURNING *`
          const created = toInstance(inserted[0]!)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: created.id,
            eventType: "InstanceCreated",
            payload: { _tag: "InstanceCreated", conceptId: concept.id, fields: fieldsWithLabels },
            conceptId: concept.id,
            conceptName: concept.name,
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
            WHERE id = ${input.instanceId} AND org_id = ${orgId} AND archived_at IS NULL
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
          const concept = yield* concepts.getById(current.conceptId)
          const { rest, rawLabels } = splitLabels(input.patch)
          const validated = yield* validateFields(defs, rest)
          yield* checkTransitions(defs, current.state, validated)
          let patch: InstanceState = validated
          if (rawLabels !== undefined) {
            const labelIds = yield* coerceLabelIds(rawLabels)
            yield* assertLabelsExist(labelIds)
            patch = { ...validated, [LABELS_KEY]: [...labelIds] }
          }
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "InstanceUpdated",
            payload: { _tag: "InstanceUpdated", patch },
            conceptName: concept.name,
          })
          const folded = applyEvent(
            { state: current.state, version: current.version, archivedAt: null },
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

    /** Archive an instance (soft, restorable) — event-sourced like every write:
     *  appends `InstanceArchived`, which the reducer folds to a set `archivedAt`. */
    const archive = (input: { readonly instanceId: string; readonly expectedVersion: number }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<InstanceRow>`
            SELECT * FROM instances
            WHERE id = ${input.instanceId} AND org_id = ${orgId} AND archived_at IS NULL
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
          const concept = yield* concepts.getById(current.conceptId)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "InstanceArchived",
            payload: { _tag: "InstanceArchived" },
            conceptName: concept.name,
          })
          const folded = applyEvent(
            { state: current.state, version: current.version, archivedAt: null },
            event,
          )
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances SET version = ${folded.right.version}, archived_at = ${folded.right.archivedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    /** Restore an archived instance — appends `InstanceRestored`, which the
     *  reducer folds to clear `archivedAt`. Refuses if not currently archived. */
    const restore = (input: { readonly instanceId: string; readonly expectedVersion: number }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<InstanceRow>`
            SELECT * FROM instances
            WHERE id = ${input.instanceId} AND org_id = ${orgId} AND archived_at IS NOT NULL
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
          const concept = yield* concepts.getById(current.conceptId)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "InstanceRestored",
            payload: { _tag: "InstanceRestored" },
            conceptName: concept.name,
          })
          const folded = applyEvent(
            { state: current.state, version: current.version, archivedAt: current.archivedAt },
            event,
          )
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances SET version = ${folded.right.version}, archived_at = ${folded.right.archivedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    /**
     * Permanently delete an instance row + its attachments. Refused while relation
     * edges still reference it (archive instead).
     *
     * The event stream is deliberately KEPT as an immutable audit trail: in an
     * event-sourced engine the log is the system of record, so a hard delete drops
     * the live projection (the row) without rewriting history. The events become
     * orphans of a now-gone subject — safe here because nothing replays the whole
     * log into instances (`rebuild` is per-id and never called for a purged id),
     * and `events` has no FK to `instances`. A `InstancePurged` tombstone records
     * the deletion itself in the feed. (For true erasure / GDPR, add an explicit
     * payload-scrubbing redaction — never a blind `DELETE FROM events`.)
     */
    const purge = (input: { readonly instanceId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const instance = yield* loadAny(input.instanceId)
          const counts = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM relations
            WHERE org_id = ${orgId} AND (from_id = ${instance.id} OR to_id = ${instance.id})`
          const relationCount = Number(counts[0]?.count ?? 0)
          if (relationCount > 0) {
            return yield* Effect.fail(new InstanceInUse({ instanceId: instance.id, relationCount }))
          }
          const concept = yield* concepts.getById(instance.conceptId)
          yield* sql`DELETE FROM attachments WHERE org_id = ${orgId} AND instance_id = ${instance.id}`
          yield* sql`DELETE FROM instances WHERE org_id = ${orgId} AND id = ${instance.id}`
          // Tombstone — recorded AFTER the row is gone so the feed shows the delete.
          yield* events.append({
            subjectKind: "instance",
            subjectId: instance.id,
            eventType: "InstancePurged",
            payload: { _tag: "InstancePurged" },
            conceptName: concept.name,
          })
          return instance
        }),
      )

    const get = (instanceId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE id = ${instanceId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
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
          archivedAt: fs.archivedAt,
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
            SET state = ${sql.json(fs.state)}, version = ${fs.version}, archived_at = ${fs.archivedAt}
            WHERE id = ${meta.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    /**
     * Server decay tick: if this instance's decay band has crossed since the
     * last marker, append a `ComputedBandChanged` event (which fans out over
     * SSE + is an automation hook). Read-then-conditionally-lock — the common
     * no-op path takes no lock and no write. Idempotent. Returns emitted events.
     */
    const recomputeBands = (instanceId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const inst = yield* get(instanceId)
        const defs = yield* fields.listFields(inst.conceptId)
        const decayField = defs.find(
          (d) => d.kind === "computed" && d.config.computedKind === "decay",
        )
        if (!decayField) return [] as EngineEvent[] // concept has no decay computed field
        const bandKey = decayField.id
        const decorated = yield* computed.decorate(inst)
        const band = (decorated.state[bandKey] as { band?: string } | undefined)?.band
        if (!band) return [] as EngineEvent[]
        const stored = (inst.state.__bands as Record<string, string> | undefined)?.[bandKey]
        if (band === stored) return [] as EngineEvent[] // no crossing → no lock, no write

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<InstanceRow>`
              SELECT * FROM instances
              WHERE id = ${instanceId} AND org_id = ${orgId} AND archived_at IS NULL
              FOR UPDATE`
            const row = rows[0]
            if (!row) return [] as EngineEvent[]
            const current = toInstance(row)
            const recheck = yield* computed.decorate(current)
            const bandNow = (recheck.state[bandKey] as { band?: string } | undefined)?.band
            const storedNow = (current.state.__bands as Record<string, string> | undefined)?.[
              bandKey
            ]
            if (!bandNow || bandNow === storedNow) return [] as EngineEvent[]
            const concept = yield* concepts.getById(current.conceptId)
            const event = yield* events.append({
              subjectKind: "instance",
              subjectId: current.id,
              eventType: "ComputedBandChanged",
              payload: {
                _tag: "ComputedBandChanged",
                field: bandKey,
                kind: "decay",
                from: storedNow ?? null,
                to: bandNow,
              },
              conceptName: concept.name,
            })
            const folded = applyEvent(
              { state: current.state, version: current.version, archivedAt: null },
              event,
            )
            if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
            yield* sql<InstanceRow>`
              UPDATE instances SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version}
              WHERE id = ${current.id} AND org_id = ${orgId}`
            return [event]
          }),
        )
      })

    return {
      create,
      update,
      transition,
      archive,
      restore,
      purge,
      get,
      getAsOf,
      rebuild,
      recomputeBands,
    } as const
  }),
  dependencies: [
    ConceptService.Default,
    FieldService.Default,
    EventStore.Default,
    ComputedFields.Default,
    LabelService.Default,
  ],
}) {}
