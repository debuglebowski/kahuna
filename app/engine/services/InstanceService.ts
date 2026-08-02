import { PgClient } from "@effect/sql-pg"
import { Effect, Either } from "effect"
import { BlobStore } from "../blob/BlobStore"
import { isRichText, MAX_RICHTEXT_CHARS, richTextWalk } from "../domain/richtext"
import {
  type ConceptRef,
  type EngineEvent,
  type Field,
  type Instance,
  type InstanceState,
  LABELS_KEY,
} from "../domain/types"
import { canEditVersion, isAmendment } from "../domain/versioning"
import { canReadRestricted } from "../domain/visibility"
import {
  DraftAlreadyExists,
  FieldValidationError,
  IllegalTransition,
  InstanceInUse,
  InstanceNotFound,
  ItemNotFound,
  ItemNotPublished,
  SingleRecordConflict,
  SingleRecordProtected,
  VersionConflict,
  VersionFrozen,
} from "../errors"
import { foldEvents } from "../projection/fold"
import { applyEvent, type FoldState } from "../projection/reducer"
import { ComputedFields } from "./ComputedFields"
import { ConceptService } from "./ConceptService"
import { EventStore } from "./EventStore"
import { FieldService } from "./FieldService"
import { LabelService } from "./LabelService"
import { OrgContext } from "./OrgContext"
import { type InstanceRow, type ItemRow, type RelationRow, toInstance, toItem } from "./rows"

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
    case "richtext": {
      if (!isRichText(value)) return fail(`field "${def.name}" expects { doc, text } rich text`)
      if (JSON.stringify(value.doc).length > MAX_RICHTEXT_CHARS)
        return fail(`field "${def.name}" is too large`)
      const text: string[] = []
      richTextWalk(value.doc, text)
      return Effect.succeed({ doc: value.doc, text: text.join("") })
    }
    case "relation":
      return fail(`field "${def.name}" is a relation — use RelationService`)
    case "file":
      return fail(`field "${def.name}" is a file — use attachments`)
    case "computed":
      return fail(`field "${def.name}" is computed and cannot be set`)
  }
}

/** Validate a field value, fanning out over the array when `config.multiple`.
 *  An explicit `null` means "clear" (the reducer drops the key) — legal for any
 *  settable kind; relation/file/computed fall through to the per-kind rejection. */
const validateValue = (
  def: Field,
  value: unknown,
): Effect.Effect<unknown, FieldValidationError> => {
  if (value === null && def.kind !== "relation" && def.kind !== "file" && def.kind !== "computed")
    return Effect.succeed(null)
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

/** "No value" for requirement checks: unset, null, empty string, empty list,
 *  or a rich text doc with no text (a doc of only e.g. a rule counts as missing). */
const isMissing = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (isRichText(v) && v.text.trim() === "")

/** Enforce `requirement: "required"` over a state/patch. `keys: "all"` checks
 *  every required def (create/publish); `"present"` only the ones the payload
 *  touches (update — rows that predate the rule stay editable, but a required
 *  value can never be cleared). Relation/file/computed never carry a
 *  requirement (FieldService rejects the config). `flagged` never blocks. */
const checkRequired = (
  defs: ReadonlyArray<Field>,
  state: InstanceState,
  keys: "all" | "present",
): Effect.Effect<void, FieldValidationError> =>
  Effect.gen(function* () {
    for (const def of defs) {
      if (def.config.requirement !== "required") continue
      if (keys === "present" && !(def.id in state)) continue
      if (isMissing(state[def.id])) {
        return yield* Effect.fail(
          new FieldValidationError({
            message: `field "${def.name}" is required`,
            field: def.name,
          }),
        )
      }
    }
  })

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

/** Seed the reducer from an already-loaded instance, so an incremental fold
 *  reproduces exactly what a full replay would (carrying the version lifecycle). */
const seedFrom = (inst: Instance, archivedAt: Date | null): FoldState => ({
  state: inst.state,
  version: inst.version,
  archivedAt,
  versionStatus: inst.versionStatus,
  publishedAt: inst.publishedAt,
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
    const blob = yield* BlobStore

    /** Purge an emptied lineage: its files (rows now, blobs after commit — an
     *  orphan blob is harmless; a dangling row would not be) then the item row
     *  itself. Returns the blob refs for the post-commit sweep. */
    const purgeEmptiedItem = (orgId: string, itemId: string) =>
      Effect.gen(function* () {
        const refs = yield* sql<{ readonly content_ref: string }>`
          SELECT content_ref FROM attachments WHERE org_id = ${orgId} AND item_id = ${itemId}`
        yield* sql`DELETE FROM attachments WHERE org_id = ${orgId} AND item_id = ${itemId}`
        yield* sql`DELETE FROM items WHERE org_id = ${orgId} AND id = ${itemId}`
        return refs.map((r) => r.content_ref)
      })

    /** Best-effort blob removal AFTER the enclosing transaction committed. */
    const sweepBlobs = (refs: ReadonlyArray<string>) =>
      Effect.forEach(refs, (r) => blob.del(r).pipe(Effect.ignore), { discard: true })

    /** Enforce `config.unique` over a validated payload: no other item of the
     *  concept may hold the same value — archived rows included, so only a
     *  purge releases a value (a restore can never resurface a duplicate).
     *  Text compares case-insensitively; other kinds by jsonb equality on the
     *  validated, coerced value. `excludeItemId` skips the writer's own
     *  lineage — versions of one item share values freely. Missing values
     *  never conflict. Runs inside the write transaction; a concurrent
     *  same-value race is accepted (no DB index backs jsonb keys). */
    const checkUnique = (
      defs: ReadonlyArray<Field>,
      patch: InstanceState,
      conceptId: string,
      excludeItemId: string | null,
    ) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        for (const def of defs) {
          if (!def.config.unique || !(def.id in patch)) continue
          const value = patch[def.id]
          if (isMissing(value)) continue
          const notSelf = excludeItemId === null ? sql`` : sql` AND item_id <> ${excludeItemId}`
          // Serialized + cast text→jsonb: `sql.json` mis-encodes bare scalars.
          const taken =
            def.kind === "text"
              ? sql`lower(state->>${def.id}) = lower(${value as string})`
              : sql`state->${def.id} = ${JSON.stringify(value)}::jsonb`
          const clash = yield* sql<{ readonly id: string }>`
            SELECT id FROM instances
            WHERE org_id = ${orgId} AND concept_id = ${conceptId}
              AND ${taken}${notSelf}
            LIMIT 1`
          if (clash[0]) {
            return yield* Effect.fail(
              new FieldValidationError({
                message: `field "${def.name}" must be unique — this value is already in use`,
                field: def.name,
              }),
            )
          }
        }
      })

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

    /** Live (non-archived) `items` lineages of a concept. The single-record
     *  invariant is defined on ITEMS, not `instances`: a versioned concept
     *  legitimately holds N version rows on one lineage, so counting instances
     *  would refuse the second version of a perfectly valid single record. */
    const liveItemCountOf = (conceptId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<{ readonly count: number | string }>`
          SELECT COUNT(*)::int AS count FROM items
          WHERE org_id = ${orgId} AND concept_id = ${conceptId} AND archived_at IS NULL`
        return Number(rows[0]?.count ?? 0)
      })

    /** Refuse a destructive write against the sole record of a single-record
     *  concept — the concept guarantees the record exists, so archiving or
     *  purging it would break the invariant.
     *
     *  Deliberately BLUNT: it refuses on the flag alone, without checking whether
     *  this is the lineage's last live version. Being exact would mean modelling
     *  "is this the last thing standing" across four call paths (per-version
     *  archive, purge, lineage archive, draft discard) for a case the UI already
     *  hides. Turn the flag off to archive; delete the concept to delete both. */
    const assertRecordUnprotected = (conceptId: string, instanceId: string) =>
      Effect.gen(function* () {
        const concept = yield* concepts.getById(conceptId)
        if (concept.singleRecord) {
          return yield* Effect.fail(new SingleRecordProtected({ conceptId, instanceId }))
        }
      })

    const create = (input: ConceptRef & { readonly fields: Record<string, unknown> }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const concept =
            "conceptId" in input
              ? yield* concepts.getById(input.conceptId)
              : yield* concepts.getByName(input.conceptName)
          // A single-record concept admits exactly one lineage. This is the guard
          // integrations hit too (they call the engine directly, bypassing the
          // use-case layer), which is why it lives here and not in a use-case.
          if (concept.singleRecord) {
            const liveItems = yield* liveItemCountOf(concept.id)
            if (liveItems > 0) {
              return yield* Effect.fail(
                new SingleRecordConflict({ conceptId: concept.id, liveItemCount: liveItems }),
              )
            }
          }
          const defs = yield* fields.listFields(concept.id)
          const { rest, rawLabels } = splitLabels(input.fields)
          const validated = yield* validateFields(defs, rest)
          // An item cannot exist without its required values — drafts included.
          yield* checkRequired(defs, validated, "all")
          yield* checkUnique(defs, validated, concept.id, null)
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
          // Every instance belongs to an `items` lineage. A new item starts at
          // seq 1; on a versioned concept it's a `draft` (not referenceable until
          // published), otherwise a `published` row (the plain 1:1 model).
          const versionStatus = concept.versioningEnabled ? "draft" : "published"
          const itemRows = yield* sql<ItemRow>`
            INSERT INTO items (org_id, concept_id) VALUES (${orgId}, ${concept.id}) RETURNING *`
          const item = toItem(itemRows[0]!)
          const inserted = yield* sql<InstanceRow>`
            INSERT INTO instances (org_id, concept_id, item_id, state, version, version_status, version_seq)
            VALUES (${orgId}, ${concept.id}, ${item.id}, ${sql.json({})}, 0, ${versionStatus}, 1)
            RETURNING *`
          const created = toInstance(inserted[0]!)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: created.id,
            eventType: "InstanceCreated",
            payload: {
              _tag: "InstanceCreated",
              conceptId: concept.id,
              fields: fieldsWithLabels,
              itemId: item.id,
              versionSeq: 1,
              versionStatus,
            },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(null, event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances
            SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version},
                version_status = ${folded.right.versionStatus}, published_at = ${folded.right.publishedAt}
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
          // On a versioned concept a published version is frozen by default — edits
          // must go to a fresh draft (newVersion) — UNLESS the concept opts into
          // amendments (`editReach: "any"`). Non-versioned instances are 'published'
          // too but always stay editable; `canEditVersion` folds all three cases.
          if (!canEditVersion(concept, current)) {
            return yield* Effect.fail(new VersionFrozen({ instanceId: current.id }))
          }
          const { rest, rawLabels } = splitLabels(input.patch)
          const validated = yield* validateFields(defs, rest)
          // Clear-protection only: a patch may not blank a required field, but
          // rows that predate the rule stay editable on their other fields. Stays
          // "present" for an amendment too: it already refuses to blank a required
          // value, so an amendment can't INTRODUCE a gap — and escalating to "all"
          // would make a pre-existing gap (from a field made required after publish)
          // block the very edit that would fill it.
          yield* checkRequired(defs, validated, "present")
          yield* checkUnique(defs, validated, current.conceptId, current.itemId)
          yield* checkTransitions(defs, current.state, validated)
          let patch: InstanceState = validated
          if (rawLabels !== undefined) {
            const labelIds = yield* coerceLabelIds(rawLabels)
            yield* assertLabelsExist(labelIds)
            patch = { ...validated, [LABELS_KEY]: [...labelIds] }
          }
          // An edit to an already-published version is an AMENDMENT: same fold, but
          // a distinct tag so the activity feed can say "amended" and amendments stay
          // filterable. `getAsOf` at the preceding event still yields the old state.
          const tag = isAmendment(concept, current) ? "VersionAmended" : "InstanceUpdated"
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: tag,
            payload: { _tag: tag, patch },
            // Both ids ride the envelope: `conceptId` is what routes the live-sync
            // refetch AND what lets an automation's concept-scoped trigger match
            // without a DB read. Passing only the name left conceptId null, so a
            // scoped trigger could never fire on an edit.
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, null), event)
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
          if (concept.singleRecord) {
            return yield* Effect.fail(
              new SingleRecordProtected({ conceptId: concept.id, instanceId: current.id }),
            )
          }
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "InstanceArchived",
            payload: { _tag: "InstanceArchived" },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, null), event)
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
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, current.archivedAt), event)
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
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const instance = yield* loadAny(input.instanceId)
            const counts = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM relations
            WHERE org_id = ${orgId} AND archived_at IS NULL
              AND (from_id = ${instance.id} OR to_id = ${instance.id} OR to_version_id = ${instance.id})`
            const relationCount = Number(counts[0]?.count ?? 0)
            if (relationCount > 0) {
              return yield* Effect.fail(
                new InstanceInUse({ instanceId: instance.id, relationCount }),
              )
            }
            yield* assertRecordUnprotected(instance.conceptId, instance.id)
            const concept = yield* concepts.getById(instance.conceptId)
            yield* sql`DELETE FROM instances WHERE org_id = ${orgId} AND id = ${instance.id}`
            // Remove the lineage row when this was its last version — otherwise an
            // empty `items` row would linger and block the concept's purge via FK.
            // Files hang off the lineage, so they purge with it (not per version).
            const remaining = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM instances
            WHERE org_id = ${orgId} AND item_id = ${instance.itemId}`
            const blobRefs =
              Number(remaining[0]?.count ?? 0) === 0
                ? yield* purgeEmptiedItem(orgId, instance.itemId)
                : []
            // Tombstone — recorded AFTER the row is gone so the feed shows the delete.
            yield* events.append({
              subjectKind: "instance",
              subjectId: instance.id,
              eventType: "InstancePurged",
              payload: { _tag: "InstancePurged" },
              conceptId: concept.id,
              conceptName: concept.name,
            })
            return { instance, blobRefs }
          }),
        )
        .pipe(
          Effect.tap(({ blobRefs }) => sweepBlobs(blobRefs)),
          Effect.map(({ instance }) => instance),
        )

    /**
     * Read gate: fail as if the row does not exist when the caller's role may not
     * read its concept. Applied to every BY-ID read entry point below — the list
     * path is already covered because `QueryService` resolves the concept first.
     *
     * Fails `InstanceNotFound` (not a distinct 403) so a member cannot use the
     * error to confirm that a record exists in a concept they can't see.
     */
    const assertConceptVisible = (conceptId: string, instanceId: string) =>
      Effect.gen(function* () {
        const { role } = yield* OrgContext
        if (canReadRestricted(role)) return
        const rows = yield* sql<{ readonly visibility: string | null }>`
          SELECT visibility FROM concepts WHERE id = ${conceptId} LIMIT 1`
        // Unknown/absent reads as restricted — same fail-closed rule as toConcept.
        if (rows[0]?.visibility !== "visible")
          return yield* Effect.fail(new InstanceNotFound({ instanceId }))
      })

    const get = (instanceId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE id = ${instanceId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        yield* assertConceptVisible(row.concept_id, instanceId)
        return toInstance(row)
      })

    const getAsOf = (instanceId: string, eventId: number) =>
      Effect.gen(function* () {
        const meta = yield* loadAny(instanceId)
        // This one hand-builds its result and so never passes through `toInstance`.
        yield* assertConceptVisible(meta.conceptId, instanceId)
        const stream = yield* events.readStream(instanceId, { upToEventId: eventId })
        const folded = foldEvents(stream)
        if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
        const fs = folded.right
        if (!fs) return yield* Effect.fail(new InstanceNotFound({ instanceId }))
        return {
          id: meta.id,
          orgId: meta.orgId,
          conceptId: meta.conceptId,
          // Immutable lineage facts come from the row; the rest is folded.
          itemId: meta.itemId,
          state: fs.state,
          version: fs.version,
          versionStatus: fs.versionStatus,
          versionSeq: meta.versionSeq,
          publishedAt: fs.publishedAt,
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
            SET state = ${sql.json(fs.state)}, version = ${fs.version}, archived_at = ${fs.archivedAt},
                version_status = ${fs.versionStatus}, published_at = ${fs.publishedAt}
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
        // On a versioned concept, a superseded published version is a historical
        // snapshot — never recompute, so the clock alone can't rewrite an old
        // version's `__bands`. Deliberately NOT gated on `editReach`: amending is an
        // intentional act, whereas decay is time passing. The head published version
        // and the open draft still decay normally.
        const gateConcept = yield* concepts.getById(inst.conceptId)
        if (gateConcept.versioningEnabled && inst.versionStatus === "published") {
          const newer = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM instances
            WHERE org_id = ${orgId} AND item_id = ${inst.itemId}
              AND version_status = 'published' AND archived_at IS NULL AND version_seq > ${inst.versionSeq}`
          if (Number(newer[0]?.count ?? 0) > 0) return [] as EngineEvent[]
        }
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
              conceptId: concept.id,
              conceptName: concept.name,
            })
            const folded = applyEvent(seedFrom(current, null), event)
            if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
            yield* sql<InstanceRow>`
              UPDATE instances SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version}
              WHERE id = ${current.id} AND org_id = ${orgId}`
            return [event]
          }),
        )
      })

    /** Publish a draft version: draft → published (one-shot, permanent). After
     *  this the version is frozen and becomes the item's "Latest". */
    const publishVersion = (input: {
      readonly instanceId: string
      readonly expectedVersion: number
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
          if (current.versionStatus === "published") {
            return yield* Effect.fail(new VersionFrozen({ instanceId: current.id }))
          }
          // Publish gate: a draft may predate a field's `required` rule (the rule
          // was added/flipped after creation) — it can't become "Latest" incomplete.
          const defs = yield* fields.listFields(current.conceptId)
          yield* checkRequired(defs, current.state, "all")
          const concept = yield* concepts.getById(current.conceptId)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: current.id,
            eventType: "VersionPublished",
            payload: { _tag: "VersionPublished" },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, null), event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances
            SET version = ${folded.right.version}, version_status = ${folded.right.versionStatus},
                published_at = ${folded.right.publishedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toInstance(updated[0]!)
        }),
      )

    /** Open a new draft for an item by cloning its latest published version's
     *  state AND outbound relations. Fails if a draft is already open
     *  (one-draft-at-a-time) or the item has no published version to branch from. */
    const newVersion = (input: { readonly itemId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const itemRows = yield* sql<ItemRow>`
            SELECT * FROM items WHERE id = ${input.itemId} AND org_id = ${orgId} FOR UPDATE`
          const itemRow = itemRows[0]
          if (!itemRow) return yield* Effect.fail(new ItemNotFound({ itemId: input.itemId }))
          const item = toItem(itemRow)
          const drafts = yield* sql<InstanceRow>`
            SELECT * FROM instances
            WHERE org_id = ${orgId} AND item_id = ${item.id}
              AND version_status = 'draft' AND archived_at IS NULL LIMIT 1`
          if (drafts[0]) {
            return yield* Effect.fail(
              new DraftAlreadyExists({ itemId: item.id, draftInstanceId: drafts[0].id }),
            )
          }
          const heads = yield* sql<InstanceRow>`
            SELECT * FROM instances
            WHERE org_id = ${orgId} AND item_id = ${item.id}
              AND version_status = 'published' AND archived_at IS NULL
            ORDER BY version_seq DESC LIMIT 1`
          const head = heads[0]
          if (!head) return yield* Effect.fail(new ItemNotPublished({ itemId: item.id }))
          const source = toInstance(head)
          const concept = yield* concepts.getById(source.conceptId)
          // Allocate over ALL lineage rows (archived included), not the head's seq:
          // archiving the head must never free its number, or an archive→new→
          // publish→restore sequence yields two live versions with the same seq
          // (and an ambiguous "Latest"). Backstopped by instances_item_seq_uq.
          const maxRows = yield* sql<{ readonly max: number | string | null }>`
            SELECT MAX(version_seq) AS max FROM instances
            WHERE org_id = ${orgId} AND item_id = ${item.id}`
          const nextSeq = Number(maxRows[0]?.max ?? 0) + 1
          const inserted = yield* sql<InstanceRow>`
            INSERT INTO instances (org_id, concept_id, item_id, state, version, version_status, version_seq)
            VALUES (${orgId}, ${source.conceptId}, ${item.id}, ${sql.json({})}, 0, 'draft', ${nextSeq})
            RETURNING *`
          const draft = toInstance(inserted[0]!)
          const event = yield* events.append({
            subjectKind: "instance",
            subjectId: draft.id,
            eventType: "InstanceCreated",
            payload: {
              _tag: "InstanceCreated",
              conceptId: source.conceptId,
              fields: source.state,
              itemId: item.id,
              versionSeq: nextSeq,
              versionStatus: "draft",
            },
            conceptId: source.conceptId,
            conceptName: concept.name,
          })
          const folded = applyEvent(null, event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<InstanceRow>`
            UPDATE instances
            SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version},
                version_status = ${folded.right.versionStatus}, published_at = ${folded.right.publishedAt}
            WHERE id = ${draft.id} AND org_id = ${orgId} RETURNING *`
          // Clone the head's outbound relations onto the draft (targets verbatim,
          // so general/pinned refs carry over), each as its own RelationCreated.
          const headRels = yield* sql<RelationRow>`
            SELECT * FROM relations
            WHERE org_id = ${orgId} AND from_id = ${source.id} AND archived_at IS NULL`
          for (const r of headRels) {
            const ins = yield* sql<RelationRow>`
              INSERT INTO relations (org_id, field_id, from_id, to_item_id, to_version_id, to_id, properties)
              VALUES (${orgId}, ${r.field_id}, ${draft.id}, ${r.to_item_id}, ${r.to_version_id}, ${r.to_id}, ${sql.json(r.properties ?? {})})
              RETURNING *`
            const rel = ins[0]!
            yield* events.append({
              subjectKind: "relation",
              subjectId: rel.id,
              eventType: "RelationCreated",
              payload: {
                _tag: "RelationCreated",
                fieldId: rel.field_id,
                fromId: rel.from_id,
                toId: rel.to_id,
                toItemId: rel.to_item_id,
                toVersionId: rel.to_version_id,
                properties: rel.properties ?? {},
              },
            })
          }
          return toInstance(updated[0]!)
        }),
      )

    /** Discard an open draft: hard-delete the draft row + its (cloned/added)
     *  outbound edges. A draft is never referenceable, so nothing inbound can
     *  dangle. Files hang off the lineage and survive the discard — unless this
     *  was the item's only version (never published), where the now-empty
     *  lineage row purges with its files. */
    const discardDraft = (input: { readonly instanceId: string }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const instance = yield* loadAny(input.instanceId)
            if (instance.versionStatus !== "draft") {
              return yield* Effect.fail(new VersionFrozen({ instanceId: instance.id }))
            }
            // Discarding the only-ever draft purges the empty lineage below — which
            // on a single-record concept would delete the record the flag promises
            // exists. Freshly toggling a VERSIONED concept produces exactly that
            // state (its new record is a draft), so this is the common path, not a
            // corner: without this guard the record is one click from gone.
            yield* assertRecordUnprotected(instance.conceptId, instance.id)
            const concept = yield* concepts.getById(instance.conceptId)
            yield* sql`DELETE FROM relations WHERE org_id = ${orgId} AND from_id = ${instance.id}`
            yield* sql`DELETE FROM instances WHERE org_id = ${orgId} AND id = ${instance.id}`
            const remaining = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM instances
            WHERE org_id = ${orgId} AND item_id = ${instance.itemId}`
            const blobRefs =
              Number(remaining[0]?.count ?? 0) === 0
                ? yield* purgeEmptiedItem(orgId, instance.itemId)
                : []
            yield* events.append({
              subjectKind: "instance",
              subjectId: instance.id,
              eventType: "InstancePurged",
              payload: { _tag: "InstancePurged" },
              conceptId: concept.id,
              conceptName: concept.name,
            })
            return { instance, blobRefs }
          }),
        )
        .pipe(
          Effect.tap(({ blobRefs }) => sweepBlobs(blobRefs)),
          Effect.map(({ instance }) => instance),
        )

    /** Whole-item (lineage) archive: hides every version from head lists. Distinct
     *  from per-version `archive` (which hides one version). */
    const archiveItem = (input: { readonly itemId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // Read the lineage BEFORE writing: this is the guarded path for a
          // versioned single record (the header "Archive" archives the whole
          // lineage, not one version), and it's the one destructive path that
          // otherwise never loads the concept at all.
          const existing = yield* sql<ItemRow>`
            SELECT * FROM items WHERE org_id = ${orgId} AND id = ${input.itemId} LIMIT 1`
          if (!existing[0]) return yield* Effect.fail(new ItemNotFound({ itemId: input.itemId }))
          const concept = yield* concepts.getById(existing[0].concept_id)
          if (concept.singleRecord) {
            return yield* Effect.fail(
              new SingleRecordProtected({ conceptId: concept.id, instanceId: input.itemId }),
            )
          }
          const rows = yield* sql<ItemRow>`
            UPDATE items SET archived_at = COALESCE(archived_at, now())
            WHERE org_id = ${orgId} AND id = ${input.itemId} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new ItemNotFound({ itemId: input.itemId }))
          const item = toItem(row)
          yield* events.append({
            subjectKind: "item",
            subjectId: item.id,
            eventType: "ItemArchived",
            payload: { _tag: "ItemArchived" },
            conceptId: item.conceptId,
          })
          return item
        }),
      )

    const restoreItem = (input: { readonly itemId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<ItemRow>`
            UPDATE items SET archived_at = NULL
            WHERE org_id = ${orgId} AND id = ${input.itemId} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new ItemNotFound({ itemId: input.itemId }))
          const item = toItem(row)
          yield* events.append({
            subjectKind: "item",
            subjectId: item.id,
            eventType: "ItemRestored",
            payload: { _tag: "ItemRestored" },
            conceptId: item.conceptId,
          })
          return item
        }),
      )

    const getItem = (itemId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<ItemRow>`
          SELECT * FROM items WHERE id = ${itemId} AND org_id = ${orgId} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new ItemNotFound({ itemId }))
        yield* assertConceptVisible(row.concept_id, itemId)
        return toItem(row)
      })

    /** The item's current latest published, non-archived version — or null. Used to
     *  resolve a general ("Latest") reference at read time. */
    const headOf = (itemId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE org_id = ${orgId} AND item_id = ${itemId}
            AND version_status = 'published' AND archived_at IS NULL
          ORDER BY version_seq DESC LIMIT 1`
        const head = rows[0]
        if (!head) return null
        yield* assertConceptVisible(head.concept_id, head.id)
        return toInstance(head)
      })

    /**
     * The sole record of a single-record concept — its live lineage's current
     * version — or null if the concept has none.
     *
     * NOT `headOf` alone, and NOT `QueryService.findInstances(...)[0]`: both are
     * head-only (`version_status = 'published'`), so a freshly toggled VERSIONED
     * concept — whose one record is still a draft — would resolve to null and the
     * route would render "record missing" for a record that plainly exists. Step 3
     * exists for exactly that case; don't "simplify" it away.
     *
     * Oldest live lineage wins, so if the invariant is ever breached (a restore
     * racing a toggle) resolution stays deterministic rather than flip-flopping
     * with creation order.
     */
    const singleRecordOf = (conceptId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const itemRows = yield* sql<ItemRow>`
          SELECT * FROM items
          WHERE org_id = ${orgId} AND concept_id = ${conceptId} AND archived_at IS NULL
          ORDER BY created_at ASC LIMIT 1`
        const item = itemRows[0]
        // Gate on the concept asked about, before any row is returned. A restricted
        // single-record concept reads as absent rather than erroring, matching the
        // `null` a member already gets for a concept with no record yet.
        if (item) yield* assertConceptVisible(conceptId, item.id)
        if (!item) return null
        const head = yield* headOf(item.id)
        if (head) return head
        // Fall back to the newest version of ANY status (the draft-only case).
        const anyRows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE org_id = ${orgId} AND item_id = ${item.id} AND archived_at IS NULL
          ORDER BY version_seq DESC LIMIT 1`
        return anyRows[0] ? toInstance(anyRows[0]) : null
      })

    /**
     * Flip a concept's `singleRecord` flag, creating its record when switching on.
     *
     * Lives HERE, not on ConceptService (which can't call InstanceService — it's
     * already a dependency of this one) and not in a use-case (where composition
     * is NOT transactional: `UC`'s requirements exclude `PgClient`, so two service
     * calls are two independent transactions). One `withTransaction` here makes
     * the flag and the record atomic: the concept is never briefly "single-record
     * with nothing in it", and a rejected record leaves the flag untouched.
     *
     * `fields` supplies the new record's values, needed when the concept has
     * required fields — `create` runs the ordinary `checkRequired`, so a short
     * payload rolls the whole transaction back rather than getting a bypass.
     */
    const setConceptSingleRecord = (input: {
      readonly conceptId: string
      readonly singleRecord: boolean
      readonly fields?: Record<string, unknown>
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // Lock the concept row first: two concurrent toggles-on would otherwise
          // both read zero items and both create a record.
          yield* sql`
            SELECT id FROM concepts
            WHERE org_id = ${orgId} AND id = ${input.conceptId} FOR UPDATE`
          const concept = yield* concepts.getById(input.conceptId) // 404 / cross-org
          // Idempotent: re-toggling on must NOT create a second record.
          if (concept.singleRecord === input.singleRecord) return concept
          // Turning it OFF is always legal — the concept just becomes ordinary and
          // its record stays as a normal record.
          if (!input.singleRecord) {
            return yield* concepts.setSingleRecord(concept.id, false)
          }
          const liveItems = yield* liveItemCountOf(concept.id)
          // Which of several records would be "the" one isn't ours to guess.
          if (liveItems > 1) {
            return yield* Effect.fail(
              new SingleRecordConflict({ conceptId: concept.id, liveItemCount: liveItems }),
            )
          }
          // Flag BEFORE create, deliberately: `create` reads it to enforce the
          // one-lineage rule, and this ordering means the very first record is
          // written under the same guard as every later attempt. Reversing these
          // two statements silently disables the guard for the initial record.
          const updated = yield* concepts.setSingleRecord(concept.id, true)
          if (liveItems === 0) {
            yield* create({ conceptId: concept.id, fields: input.fields ?? {} })
          }
          return updated
        }),
      )

    /** All versions of an item (draft + published, including per-version archived),
     *  oldest first — for the item-detail version history panel. */
    const listVersions = (itemId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<InstanceRow>`
          SELECT * FROM instances
          WHERE org_id = ${orgId} AND item_id = ${itemId}
          ORDER BY version_seq ASC`
        // Every version of an item shares its concept, so one check covers them all.
        const first = rows[0]
        if (first) yield* assertConceptVisible(first.concept_id, first.id)
        return rows.map(toInstance)
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
      publishVersion,
      newVersion,
      discardDraft,
      archiveItem,
      restoreItem,
      getItem,
      headOf,
      singleRecordOf,
      setConceptSingleRecord,
      listVersions,
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
