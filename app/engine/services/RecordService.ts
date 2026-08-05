import { PgClient } from "@effect/sql-pg"
import { Effect, Either } from "effect"
import { BlobStore } from "../blob/BlobStore"
import { decideRecord, recordRulesForConcept } from "../domain/access"
import { extractMentions, isUuid } from "../domain/mentions"
import { isRichText, MAX_RICHTEXT_CHARS, richTextWalk } from "../domain/richtext"
import {
  type ConceptRef,
  type EngineEvent,
  type Field,
  LABELS_KEY,
  type RecordState,
  type RecordVersion,
} from "../domain/types"
import { canEditVersion, isAmendment } from "../domain/versioning"
import { scopeCanReadConcept, scopeConceptRead } from "../domain/visibility"
import {
  DraftAlreadyExists,
  FieldValidationError,
  IllegalTransition,
  RecordNotFound,
  RecordNotPublished,
  RecordVersionInUse,
  RecordVersionNotFound,
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
import {
  type RecordRow,
  type RecordVersionRow,
  type RelationRow,
  toRecord,
  toRecordVersion,
} from "./rows"

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
  state: RecordState,
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
    const out: RecordState = {}
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

const checkTransitions = (defs: ReadonlyArray<Field>, current: RecordState, patch: RecordState) =>
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

/** Seed the reducer from an already-loaded record version, so an incremental fold
 *  reproduces exactly what a full replay would (carrying the version lifecycle). */
const seedFrom = (inst: RecordVersion, archivedAt: Date | null): FoldState => ({
  state: inst.state,
  version: inst.version,
  archivedAt,
  versionStatus: inst.versionStatus,
  publishedAt: inst.publishedAt,
})

/**
 * The heart of the engine: record version writes. Every write runs inside one
 * `sql.withTransaction` — validate → (lock + version check) → append event →
 * fold via the shared reducer → persist projection + bump version.
 */
export class RecordService extends Effect.Service<RecordService>()("engine/RecordService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const events = yield* EventStore
    const concepts = yield* ConceptService
    const fields = yield* FieldService
    const computed = yield* ComputedFields
    const labels = yield* LabelService
    const blob = yield* BlobStore

    /**
     * Rebuild the `mentions` index for ONE record version version, from its richtext
     * fields. Delete-then-insert rather than diff: the row count per document is
     * tiny and a rebuild cannot drift from the doc the way a diff can.
     *
     * MUST be handed the FOLDED state, never a patch. An update carries only the
     * fields being written, so re-indexing from a patch would delete every mention
     * row for this record version and re-insert only the touched field's — silently
     * dropping the other fields' backlinks.
     */
    const reindexRecordVersionMentions = (
      orgId: string,
      recordVersionId: string,
      state: RecordState,
      defs: ReadonlyArray<Field>,
    ) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM mentions WHERE org_id = ${orgId} AND from_version_id = ${recordVersionId}`
        const rows: Array<{ fieldId: string; kind: string; targetId: string }> = []
        for (const def of defs) {
          if (def.kind !== "richtext") continue
          const value = state[def.id]
          if (!isRichText(value)) continue
          for (const m of extractMentions(value.doc))
            rows.push({ fieldId: def.id, kind: m.kind, targetId: m.targetId })
        }
        if (rows.length === 0) return

        // `target_record_id` carries an FK, so a mention of a since-purged record
        // would fail the insert. Resolve which record targets actually exist and
        // null the column for the rest: the row still records what was meant, it
        // just stops producing a backlink — which is right, the target is gone.
        const candidates = [
          ...new Set(
            rows.filter((r) => r.kind === "record" && isUuid(r.targetId)).map((r) => r.targetId),
          ),
        ]
        const live = new Set<string>()
        if (candidates.length > 0) {
          const found = yield* sql<{ readonly id: string }>`
            SELECT id FROM records WHERE org_id = ${orgId} AND ${sql.in("id", candidates)}`
          for (const f of found) live.add(f.id)
        }
        for (const r of rows) {
          const targetRecordId = r.kind === "record" && live.has(r.targetId) ? r.targetId : null
          yield* sql`
            INSERT INTO mentions (org_id, from_version_id, from_field_id, kind, target_id, target_record_id)
            VALUES (${orgId}, ${recordVersionId}, ${r.fieldId}, ${r.kind}, ${r.targetId}, ${targetRecordId})`
        }
      })

    /** Purge an emptied lineage: its files (rows now, blobs after commit — an
     *  orphan blob is harmless; a dangling row would not be) then the record row
     *  itself. Returns the blob refs for the post-commit sweep. */
    const purgeEmptiedRecord = (orgId: string, recordId: string) =>
      Effect.gen(function* () {
        const refs = yield* sql<{ readonly content_ref: string }>`
          SELECT content_ref FROM attachments WHERE org_id = ${orgId} AND record_id = ${recordId}`
        yield* sql`DELETE FROM attachments WHERE org_id = ${orgId} AND record_id = ${recordId}`
        // INBOUND mentions of this lineage: the `target_record_id` FK would block the
        // record delete below. (Outbound rows are keyed by record version id and are gone
        // with the record version rows already.)
        yield* sql`DELETE FROM mentions WHERE org_id = ${orgId} AND target_record_id = ${recordId}`
        yield* sql`DELETE FROM records WHERE org_id = ${orgId} AND id = ${recordId}`
        return refs.map((r) => r.content_ref)
      })

    /** Best-effort blob removal AFTER the enclosing transaction committed. */
    const sweepBlobs = (refs: ReadonlyArray<string>) =>
      Effect.forEach(refs, (r) => blob.del(r).pipe(Effect.ignore), { discard: true })

    /** Enforce `config.unique` over a validated payload: no other record of the
     *  concept may hold the same value — archived rows included, so only a
     *  purge releases a value (a restore can never resurface a duplicate).
     *  Text compares case-insensitively; other kinds by jsonb equality on the
     *  validated, coerced value. `excludeItemId` skips the writer's own
     *  lineage — versions of one record share values freely. Missing values
     *  never conflict. Runs inside the write transaction; a concurrent
     *  same-value race is accepted (no DB index backs jsonb keys). */
    const checkUnique = (
      defs: ReadonlyArray<Field>,
      patch: RecordState,
      conceptId: string,
      excludeItemId: string | null,
    ) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        for (const def of defs) {
          if (!def.config.unique || !(def.id in patch)) continue
          const value = patch[def.id]
          if (isMissing(value)) continue
          const notSelf = excludeItemId === null ? sql`` : sql` AND record_id <> ${excludeItemId}`
          // Serialized + cast text→jsonb: `sql.json` mis-encodes bare scalars.
          const taken =
            def.kind === "text"
              ? sql`lower(state->>${def.id}) = lower(${value as string})`
              : sql`state->${def.id} = ${JSON.stringify(value)}::jsonb`
          const clash = yield* sql<{ readonly id: string }>`
            SELECT id FROM record_versions
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

    const loadAny = (recordVersionId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<RecordVersionRow>`
          SELECT * FROM record_versions WHERE id = ${recordVersionId} AND org_id = ${orgId} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new RecordVersionNotFound({ recordVersionId }))
        return toRecordVersion(row)
      })

    /** Live (non-archived) `records` lineages of a concept. The single-record
     *  invariant is defined on ITEMS, not `record_versions`: a versioned concept
     *  legitimately holds N version rows on one lineage, so counting record versions
     *  would refuse the second version of a perfectly valid single record. */
    const liveRecordCountOf = (conceptId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<{ readonly count: number | string }>`
          SELECT COUNT(*)::int AS count FROM records
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
    const assertRecordUnprotected = (conceptId: string, recordVersionId: string) =>
      Effect.gen(function* () {
        const concept = yield* concepts.getById(conceptId)
        if (concept.singleRecord) {
          return yield* Effect.fail(new SingleRecordProtected({ conceptId, recordVersionId }))
        }
      })

    const create = (input: ConceptRef & { readonly fields: Record<string, unknown> }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const concept =
            "conceptId" in input
              ? yield* concepts.getById(input.conceptId)
              : yield* concepts.getByName(input.conceptName)
          // A single-record concept admits exactly one lineage. This is the guard
          // integrations hit too (they call the engine directly, bypassing the
          // use-case layer), which is why it lives here and not in a use-case.
          if (concept.singleRecord) {
            const liveItems = yield* liveRecordCountOf(concept.id)
            if (liveItems > 0) {
              return yield* Effect.fail(
                new SingleRecordConflict({ conceptId: concept.id, liveItemCount: liveItems }),
              )
            }
          }
          const defs = yield* fields.listFields(concept.id)
          const { rest, rawLabels } = splitLabels(input.fields)
          const validated = yield* validateFields(defs, rest)
          // A record cannot exist without its required values — drafts included.
          yield* checkRequired(defs, validated, "all")
          yield* checkUnique(defs, validated, concept.id, null)
          // Per-record labels: use the caller's set if given, else snapshot the
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
          const fieldsWithLabels: RecordState =
            labelIds.length > 0 ? { ...validated, [LABELS_KEY]: [...labelIds] } : validated
          // Every record version belongs to an `records` lineage. A new record starts at
          // seq 1; on a versioned concept it's a `draft` (not referenceable until
          // published), otherwise a `published` row (the plain 1:1 model).
          const versionStatus = concept.versioningEnabled ? "draft" : "published"
          // `created_by` is stamped on the LINEAGE, once, at creation: publishing a
          // new version must never reassign who made the record. It is what the
          // `actorIs: "creator"` access condition filters on ("records I created").
          const recordRows = yield* sql<RecordRow>`
            INSERT INTO records (org_id, concept_id, created_by)
            VALUES (${orgId}, ${concept.id}, ${actor})
            RETURNING *`
          const record = toRecord(recordRows[0]!)
          const inserted = yield* sql<RecordVersionRow>`
            INSERT INTO record_versions (org_id, concept_id, record_id, state, version, version_status, version_seq)
            VALUES (${orgId}, ${concept.id}, ${record.id}, ${sql.json({})}, 0, ${versionStatus}, 1)
            RETURNING *`
          const created = toRecordVersion(inserted[0]!)
          const event = yield* events.append({
            subjectKind: "recordVersion",
            subjectId: created.id,
            eventType: "RecordVersionCreated",
            payload: {
              _tag: "RecordVersionCreated",
              conceptId: concept.id,
              fields: fieldsWithLabels,
              recordId: record.id,
              versionSeq: 1,
              versionStatus,
            },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(null, event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions
            SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version},
                version_status = ${folded.right.versionStatus}, published_at = ${folded.right.publishedAt}
            WHERE id = ${created.id} AND org_id = ${orgId} RETURNING *`
          yield* reindexRecordVersionMentions(orgId, created.id, folded.right.state, defs)
          return toRecordVersion(updated[0]!)
        }),
      )

    const update = (input: {
      readonly recordVersionId: string
      readonly expectedVersion: number
      readonly patch: Record<string, unknown>
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<RecordVersionRow>`
            SELECT * FROM record_versions
            WHERE id = ${input.recordVersionId} AND org_id = ${orgId} AND archived_at IS NULL
            FOR UPDATE`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(
              new RecordVersionNotFound({ recordVersionId: input.recordVersionId }),
            )
          // See THE WRITE GATE: reads refusing this record must mean writes do too.
          yield* assertRecordWritable(
            row.concept_id,
            row.record_id,
            input.recordVersionId,
            row.state,
          )
          const current = toRecordVersion(row)
          if (current.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new VersionConflict({
                recordVersionId: current.id,
                expected: input.expectedVersion,
                actual: current.version,
              }),
            )
          }
          const defs = yield* fields.listFields(current.conceptId)
          const concept = yield* concepts.getById(current.conceptId)
          // On a versioned concept a published version is frozen by default — edits
          // must go to a fresh draft (newVersion) — UNLESS the concept opts into
          // amendments (`editReach: "any"`). Non-versioned record versions are 'published'
          // too but always stay editable; `canEditVersion` folds all three cases.
          if (!canEditVersion(concept, current)) {
            return yield* Effect.fail(new VersionFrozen({ recordVersionId: current.id }))
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
          yield* checkUnique(defs, validated, current.conceptId, current.recordId)
          yield* checkTransitions(defs, current.state, validated)
          let patch: RecordState = validated
          if (rawLabels !== undefined) {
            const labelIds = yield* coerceLabelIds(rawLabels)
            yield* assertLabelsExist(labelIds)
            patch = { ...validated, [LABELS_KEY]: [...labelIds] }
          }
          // An edit to an already-published version is an AMENDMENT: same fold, but
          // a distinct tag so the activity feed can say "amended" and amendments stay
          // filterable. `getAsOf` at the preceding event still yields the old state.
          const tag = isAmendment(concept, current) ? "VersionAmended" : "RecordVersionUpdated"
          const event = yield* events.append({
            subjectKind: "recordVersion",
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
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          // The FOLDED state, not `validated`: an update patches a subset of the
          // fields, and re-indexing from the patch would drop the other fields'
          // mentions along with this record version's rows.
          yield* reindexRecordVersionMentions(orgId, current.id, folded.right.state, defs)
          return toRecordVersion(updated[0]!)
        }),
      )

    const transition = (input: {
      readonly recordVersionId: string
      readonly expectedVersion: number
      readonly field: string
      readonly to: string
    }) =>
      update({
        recordVersionId: input.recordVersionId,
        expectedVersion: input.expectedVersion,
        patch: { [input.field]: input.to },
      })

    /** Archive an record version (soft, restorable) — event-sourced like every write:
     *  appends `RecordVersionArchived`, which the reducer folds to a set `archivedAt`. */
    const archive = (input: {
      readonly recordVersionId: string
      readonly expectedVersion: number
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<RecordVersionRow>`
            SELECT * FROM record_versions
            WHERE id = ${input.recordVersionId} AND org_id = ${orgId} AND archived_at IS NULL
            FOR UPDATE`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(
              new RecordVersionNotFound({ recordVersionId: input.recordVersionId }),
            )
          // See THE WRITE GATE: reads refusing this record must mean writes do too.
          yield* assertRecordWritable(
            row.concept_id,
            row.record_id,
            input.recordVersionId,
            row.state,
          )
          const current = toRecordVersion(row)
          if (current.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new VersionConflict({
                recordVersionId: current.id,
                expected: input.expectedVersion,
                actual: current.version,
              }),
            )
          }
          const concept = yield* concepts.getById(current.conceptId)
          if (concept.singleRecord) {
            return yield* Effect.fail(
              new SingleRecordProtected({ conceptId: concept.id, recordVersionId: current.id }),
            )
          }
          const event = yield* events.append({
            subjectKind: "recordVersion",
            subjectId: current.id,
            eventType: "RecordVersionArchived",
            payload: { _tag: "RecordVersionArchived" },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, null), event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions SET version = ${folded.right.version}, archived_at = ${folded.right.archivedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toRecordVersion(updated[0]!)
        }),
      )

    /** Restore an archived record version — appends `RecordVersionRestored`, which the
     *  reducer folds to clear `archivedAt`. Refuses if not currently archived. */
    const restore = (input: {
      readonly recordVersionId: string
      readonly expectedVersion: number
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<RecordVersionRow>`
            SELECT * FROM record_versions
            WHERE id = ${input.recordVersionId} AND org_id = ${orgId} AND archived_at IS NOT NULL
            FOR UPDATE`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(
              new RecordVersionNotFound({ recordVersionId: input.recordVersionId }),
            )
          // See THE WRITE GATE: reads refusing this record must mean writes do too.
          yield* assertRecordWritable(
            row.concept_id,
            row.record_id,
            input.recordVersionId,
            row.state,
          )
          const current = toRecordVersion(row)
          if (current.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new VersionConflict({
                recordVersionId: current.id,
                expected: input.expectedVersion,
                actual: current.version,
              }),
            )
          }
          const concept = yield* concepts.getById(current.conceptId)
          const event = yield* events.append({
            subjectKind: "recordVersion",
            subjectId: current.id,
            eventType: "RecordVersionRestored",
            payload: { _tag: "RecordVersionRestored" },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, current.archivedAt), event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions SET version = ${folded.right.version}, archived_at = ${folded.right.archivedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toRecordVersion(updated[0]!)
        }),
      )

    /**
     * Permanently delete an record version row + its attachments. Refused while relation
     * edges still reference it (archive instead).
     *
     * The event stream is deliberately KEPT as an immutable audit trail: in an
     * event-sourced engine the log is the system of record, so a hard delete drops
     * the live projection (the row) without rewriting history. The events become
     * orphans of a now-gone subject — safe here because nothing replays the whole
     * log into record versions (`rebuild` is per-id and never called for a purged id),
     * and `events` has no FK to `record_versions`. A `RecordVersionPurged` tombstone records
     * the deletion itself in the feed. (For true erasure / GDPR, add an explicit
     * payload-scrubbing redaction — never a blind `DELETE FROM events`.)
     */
    const purge = (input: { readonly recordVersionId: string }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const recordVersion = yield* loadAny(input.recordVersionId)
            // `loadAny` is deliberately ungated (rebuild/replay need it), so the gate
            // goes here at the mutation.
            yield* assertRecordWritable(
              recordVersion.conceptId,
              recordVersion.recordId,
              input.recordVersionId,
              recordVersion.state,
            )
            const counts = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM relations
            WHERE org_id = ${orgId} AND archived_at IS NULL
              AND (from_id = ${recordVersion.id} OR to_id = ${recordVersion.id} OR to_version_id = ${recordVersion.id})`
            const relationCount = Number(counts[0]?.count ?? 0)
            if (relationCount > 0) {
              return yield* Effect.fail(
                new RecordVersionInUse({ recordVersionId: recordVersion.id, relationCount }),
              )
            }
            yield* assertRecordUnprotected(recordVersion.conceptId, recordVersion.id)
            const concept = yield* concepts.getById(recordVersion.conceptId)
            // Outbound mention rows hang off this version and hold an FK to it.
            yield* sql`DELETE FROM mentions WHERE org_id = ${orgId} AND from_version_id = ${recordVersion.id}`
            yield* sql`DELETE FROM record_versions WHERE org_id = ${orgId} AND id = ${recordVersion.id}`
            // Remove the lineage row when this was its last version — otherwise an
            // empty `records` row would linger and block the concept's purge via FK.
            // Files hang off the lineage, so they purge with it (not per version).
            const remaining = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM record_versions
            WHERE org_id = ${orgId} AND record_id = ${recordVersion.recordId}`
            const blobRefs =
              Number(remaining[0]?.count ?? 0) === 0
                ? yield* purgeEmptiedRecord(orgId, recordVersion.recordId)
                : []
            // Tombstone — recorded AFTER the row is gone so the feed shows the delete.
            yield* events.append({
              subjectKind: "recordVersion",
              subjectId: recordVersion.id,
              eventType: "RecordVersionPurged",
              payload: { _tag: "RecordVersionPurged" },
              conceptId: concept.id,
              conceptName: concept.name,
            })
            return { recordVersion, blobRefs }
          }),
        )
        .pipe(
          Effect.tap(({ blobRefs }) => sweepBlobs(blobRefs)),
          Effect.map(({ recordVersion }) => recordVersion),
        )

    /**
     * Read gate: fail as if the row does not exist when the caller's role may not
     * read its concept. Applied to every BY-ID read entry point below — the list
     * path is already covered because `QueryService` resolves the concept first.
     *
     * Fails `RecordVersionNotFound` (not a distinct 403) so a member cannot use the
     * error to confirm that a record exists in a concept they can't see.
     */
    const assertConceptVisible = (conceptId: string, recordVersionId: string) =>
      Effect.gen(function* () {
        const scope = yield* OrgContext
        // NO early return for privileged roles: a DENY rule must be able to close a
        // concept even for an admin, and only `scopeCanReadConcept` knows that.
        //
        // No column read either — the decision is entirely in the caller's resolved
        // rules, which the request already carries. This used to SELECT
        // `concepts.visibility` on every by-id record read; that row is gone from the
        // hot path.
        if (!scopeCanReadConcept(scope, conceptId))
          return yield* Effect.fail(new RecordVersionNotFound({ recordVersionId }))
      })

    /**
     * Record-level read gate, layered on the concept gate above.
     *
     * THE LIST/DETAIL AGREEMENT: `QueryService` compiles the same rules into SQL for
     * lists. This is the by-id half, and the two must answer identically — otherwise
     * a member opens a record their list correctly hid, or sees a row they cannot
     * open. `matchesCondition` and `compileCondition` are held in step by
     * `access-sql.test.ts`; this function is what puts the by-id side on that path.
     *
     * Keyed by ITEM id (the lineage), like every record rule: a share must survive
     * publishing a new version.
     *
     * Fast path: no record rules ⇒ nothing to decide, and no query is issued. That is
     * the overwhelmingly common case, so a by-id read costs exactly what it did
     * before this feature.
     */
    const assertRecordReadable = (
      conceptId: string,
      recordId: string,
      failId: string,
      // Passed when the caller already holds the row, to save a fetch.
      knownState?: Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const scope = yield* OrgContext
        if (!scope.policy || scope.policy.unrestricted) return
        const rules = recordRulesForConcept(scope.policy, "view", conceptId)
        if (rules.length === 0) return
        // Only reached when a record rule exists. `created_by` lives on the lineage;
        // `state` comes from the head version when the caller didn't supply it.
        // No join to `concepts` any more: the record decision reads the caller's
        // rules, and only `created_by` + the published state are needed for a
        // condition to evaluate against.
        const rows = yield* sql<{
          readonly created_by: string | null
          readonly state: Record<string, unknown> | null
        }>`
          SELECT i.created_by,
                 (SELECT state FROM record_versions
                  WHERE record_id = i.id AND version_status = 'published' AND archived_at IS NULL
                  ORDER BY version_seq DESC LIMIT 1) AS state
          FROM records i
          WHERE i.id = ${recordId} LIMIT 1`
        const record = {
          state: knownState ?? rows[0]?.state ?? {},
          createdBy: rows[0]?.created_by ?? null,
        }
        // THE FALLBACK MUST MATCH THE LIST'S. `QueryService` passes
        // `recordsByDefault` from the same function; passing `true` here instead would
        // let a share-only caller open ANY record of the concept while their list
        // correctly showed one. Same inputs, same answer.
        const { recordsByDefault } = scopeConceptRead(scope, conceptId)
        if (
          !decideRecord(
            scope.policy,
            "view",
            { type: "record", id: recordId, conceptId },
            recordsByDefault,
            record,
          )
        )
          return yield* Effect.fail(new RecordVersionNotFound({ recordVersionId: failId }))
      })

    /**
     * ── THE WRITE GATE ──────────────────────────────────────────────────────
     *
     * A caller who cannot READ a record must not be able to write it either.
     *
     * Both halves are needed, and this is why they are wrapped together rather than
     * called separately at each mutation: `assertConceptVisible` covers the concept
     * DEFAULT (an `admin`-only or `none` concept), while `assertRecordReadable` covers
     * per-record rules — and it deliberately no-ops when the caller holds no record
     * rules at all, so on its own it lets an empty-policy member through.
     *
     * That combination was the hole: `update` and `archive` both SUCCEEDED against a
     * record the very same caller got `RecordVersionNotFound` for on read. Verified before
     * and after, and pinned by "THE WRITE GATE" in test/visibility.test.ts.
     *
     * Fails `RecordVersionNotFound`, like the read gates — a write must not become an
     * existence oracle for a record reads refuse to confirm.
     */
    const assertRecordWritable = (
      conceptId: string,
      recordId: string,
      failId: string,
      knownState?: Record<string, unknown>,
    ) =>
      assertConceptVisible(conceptId, failId).pipe(
        Effect.zipRight(assertRecordReadable(conceptId, recordId, failId, knownState)),
      )

    const get = (recordVersionId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<RecordVersionRow>`
          SELECT * FROM record_versions
          WHERE id = ${recordVersionId} AND org_id = ${orgId} AND archived_at IS NULL LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new RecordVersionNotFound({ recordVersionId }))
        yield* assertConceptVisible(row.concept_id, recordVersionId)
        yield* assertRecordReadable(row.concept_id, row.record_id, recordVersionId, row.state)
        return toRecordVersion(row)
      })

    const getAsOf = (recordVersionId: string, eventId: number) =>
      Effect.gen(function* () {
        const meta = yield* loadAny(recordVersionId)
        // This one hand-builds its result and so never passes through `toRecordVersion`.
        yield* assertConceptVisible(meta.conceptId, recordVersionId)
        yield* assertRecordReadable(meta.conceptId, meta.recordId, recordVersionId)
        const stream = yield* events.readStream(recordVersionId, { upToEventId: eventId })
        const folded = foldEvents(stream)
        if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
        const fs = folded.right
        if (!fs) return yield* Effect.fail(new RecordVersionNotFound({ recordVersionId }))
        return {
          id: meta.id,
          orgId: meta.orgId,
          conceptId: meta.conceptId,
          // Immutable lineage facts come from the row; the rest is folded.
          recordId: meta.recordId,
          state: fs.state,
          version: fs.version,
          versionStatus: fs.versionStatus,
          versionSeq: meta.versionSeq,
          publishedAt: fs.publishedAt,
          createdAt: meta.createdAt,
          archivedAt: fs.archivedAt,
        } satisfies RecordVersion
      })

    const rebuild = (recordVersionId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const meta = yield* loadAny(recordVersionId)
          const stream = yield* events.readStream(recordVersionId)
          const folded = foldEvents(stream)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const fs = folded.right
          if (!fs) return yield* Effect.fail(new RecordVersionNotFound({ recordVersionId }))
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions
            SET state = ${sql.json(fs.state)}, version = ${fs.version}, archived_at = ${fs.archivedAt},
                version_status = ${fs.versionStatus}, published_at = ${fs.publishedAt}
            WHERE id = ${meta.id} AND org_id = ${orgId} RETURNING *`
          return toRecordVersion(updated[0]!)
        }),
      )

    /**
     * Server decay tick: if this record version's decay band has crossed since the
     * last marker, append a `ComputedBandChanged` event (which fans out over
     * SSE + is an automation hook). Read-then-conditionally-lock — the common
     * no-op path takes no lock and no write. Idempotent. Returns emitted events.
     */
    const recomputeBands = (recordVersionId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const inst = yield* get(recordVersionId)
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
            SELECT COUNT(*)::int AS count FROM record_versions
            WHERE org_id = ${orgId} AND record_id = ${inst.recordId}
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
            const rows = yield* sql<RecordVersionRow>`
              SELECT * FROM record_versions
              WHERE id = ${recordVersionId} AND org_id = ${orgId} AND archived_at IS NULL
              FOR UPDATE`
            const row = rows[0]
            if (!row) return [] as EngineEvent[]
            const current = toRecordVersion(row)
            const recheck = yield* computed.decorate(current)
            const bandNow = (recheck.state[bandKey] as { band?: string } | undefined)?.band
            const storedNow = (current.state.__bands as Record<string, string> | undefined)?.[
              bandKey
            ]
            if (!bandNow || bandNow === storedNow) return [] as EngineEvent[]
            const concept = yield* concepts.getById(current.conceptId)
            const event = yield* events.append({
              subjectKind: "recordVersion",
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
            yield* sql<RecordVersionRow>`
              UPDATE record_versions SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version}
              WHERE id = ${current.id} AND org_id = ${orgId}`
            return [event]
          }),
        )
      })

    /** Publish a draft version: draft → published (one-shot, permanent). After
     *  this the version is frozen and becomes the record's "Latest". */
    const publishVersion = (input: {
      readonly recordVersionId: string
      readonly expectedVersion: number
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<RecordVersionRow>`
            SELECT * FROM record_versions
            WHERE id = ${input.recordVersionId} AND org_id = ${orgId} AND archived_at IS NULL
            FOR UPDATE`
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(
              new RecordVersionNotFound({ recordVersionId: input.recordVersionId }),
            )
          // See THE WRITE GATE: reads refusing this record must mean writes do too.
          yield* assertRecordWritable(
            row.concept_id,
            row.record_id,
            input.recordVersionId,
            row.state,
          )
          const current = toRecordVersion(row)
          if (current.version !== input.expectedVersion) {
            return yield* Effect.fail(
              new VersionConflict({
                recordVersionId: current.id,
                expected: input.expectedVersion,
                actual: current.version,
              }),
            )
          }
          if (current.versionStatus === "published") {
            return yield* Effect.fail(new VersionFrozen({ recordVersionId: current.id }))
          }
          // Publish gate: a draft may predate a field's `required` rule (the rule
          // was added/flipped after creation) — it can't become "Latest" incomplete.
          const defs = yield* fields.listFields(current.conceptId)
          yield* checkRequired(defs, current.state, "all")
          const concept = yield* concepts.getById(current.conceptId)
          const event = yield* events.append({
            subjectKind: "recordVersion",
            subjectId: current.id,
            eventType: "VersionPublished",
            payload: { _tag: "VersionPublished" },
            conceptId: concept.id,
            conceptName: concept.name,
          })
          const folded = applyEvent(seedFrom(current, null), event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions
            SET version = ${folded.right.version}, version_status = ${folded.right.versionStatus},
                published_at = ${folded.right.publishedAt}
            WHERE id = ${current.id} AND org_id = ${orgId} RETURNING *`
          return toRecordVersion(updated[0]!)
        }),
      )

    /** Open a new draft for an record by cloning its latest published version's
     *  state AND outbound relations. Fails if a draft is already open
     *  (one-draft-at-a-time) or the record has no published version to branch from. */
    const newVersion = (input: { readonly recordId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const recordRows = yield* sql<RecordRow>`
            SELECT * FROM records WHERE id = ${input.recordId} AND org_id = ${orgId} FOR UPDATE`
          const recordRow = recordRows[0]
          if (!recordRow)
            return yield* Effect.fail(new RecordNotFound({ recordId: input.recordId }))
          yield* assertRecordWritable(recordRow.concept_id, input.recordId, input.recordId)
          const record = toRecord(recordRow)
          const drafts = yield* sql<RecordVersionRow>`
            SELECT * FROM record_versions
            WHERE org_id = ${orgId} AND record_id = ${record.id}
              AND version_status = 'draft' AND archived_at IS NULL LIMIT 1`
          if (drafts[0]) {
            return yield* Effect.fail(
              new DraftAlreadyExists({ recordId: record.id, draftInstanceId: drafts[0].id }),
            )
          }
          const heads = yield* sql<RecordVersionRow>`
            SELECT * FROM record_versions
            WHERE org_id = ${orgId} AND record_id = ${record.id}
              AND version_status = 'published' AND archived_at IS NULL
            ORDER BY version_seq DESC LIMIT 1`
          const head = heads[0]
          if (!head) return yield* Effect.fail(new RecordNotPublished({ recordId: record.id }))
          const source = toRecordVersion(head)
          const concept = yield* concepts.getById(source.conceptId)
          // Allocate over ALL lineage rows (archived included), not the head's seq:
          // archiving the head must never free its number, or an archive→new→
          // publish→restore sequence yields two live versions with the same seq
          // (and an ambiguous "Latest"). Backstopped by record_versions_record_seq_uq.
          const maxRows = yield* sql<{ readonly max: number | string | null }>`
            SELECT MAX(version_seq) AS max FROM record_versions
            WHERE org_id = ${orgId} AND record_id = ${record.id}`
          const nextSeq = Number(maxRows[0]?.max ?? 0) + 1
          const inserted = yield* sql<RecordVersionRow>`
            INSERT INTO record_versions (org_id, concept_id, record_id, state, version, version_status, version_seq)
            VALUES (${orgId}, ${source.conceptId}, ${record.id}, ${sql.json({})}, 0, 'draft', ${nextSeq})
            RETURNING *`
          const draft = toRecordVersion(inserted[0]!)
          const event = yield* events.append({
            subjectKind: "recordVersion",
            subjectId: draft.id,
            eventType: "RecordVersionCreated",
            payload: {
              _tag: "RecordVersionCreated",
              conceptId: source.conceptId,
              fields: source.state,
              recordId: record.id,
              versionSeq: nextSeq,
              versionStatus: "draft",
            },
            conceptId: source.conceptId,
            conceptName: concept.name,
          })
          const folded = applyEvent(null, event)
          if (Either.isLeft(folded)) return yield* Effect.fail(folded.left)
          const updated = yield* sql<RecordVersionRow>`
            UPDATE record_versions
            SET state = ${sql.json(folded.right.state)}, version = ${folded.right.version},
                version_status = ${folded.right.versionStatus}, published_at = ${folded.right.publishedAt}
            WHERE id = ${draft.id} AND org_id = ${orgId} RETURNING *`
          // The draft carries the head's state verbatim, so it carries its mentions
          // too. Re-derived from that state rather than cloned from the head's rows:
          // one code path with `create`/`update` means the index cannot drift.
          yield* reindexRecordVersionMentions(
            orgId,
            draft.id,
            folded.right.state,
            yield* fields.listFields(source.conceptId),
          )
          // Clone the head's outbound relations onto the draft (targets verbatim,
          // so general/pinned refs carry over), each as its own RelationCreated.
          const headRels = yield* sql<RelationRow>`
            SELECT * FROM relations
            WHERE org_id = ${orgId} AND from_id = ${source.id} AND archived_at IS NULL`
          for (const r of headRels) {
            const ins = yield* sql<RelationRow>`
              INSERT INTO relations (org_id, field_id, from_id, to_record_id, to_version_id, to_id, properties)
              VALUES (${orgId}, ${r.field_id}, ${draft.id}, ${r.to_record_id}, ${r.to_version_id}, ${r.to_id}, ${sql.json(r.properties ?? {})})
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
                toRecordId: rel.to_record_id,
                toVersionId: rel.to_version_id,
                properties: rel.properties ?? {},
              },
            })
          }
          return toRecordVersion(updated[0]!)
        }),
      )

    /** Discard an open draft: hard-delete the draft row + its (cloned/added)
     *  outbound edges. A draft is never referenceable, so nothing inbound can
     *  dangle. Files hang off the lineage and survive the discard — unless this
     *  was the record's only version (never published), where the now-empty
     *  lineage row purges with its files. */
    const discardDraft = (input: { readonly recordVersionId: string }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const recordVersion = yield* loadAny(input.recordVersionId)
            yield* assertRecordWritable(
              recordVersion.conceptId,
              recordVersion.recordId,
              input.recordVersionId,
              recordVersion.state,
            )
            if (recordVersion.versionStatus !== "draft") {
              return yield* Effect.fail(new VersionFrozen({ recordVersionId: recordVersion.id }))
            }
            // Discarding the only-ever draft purges the empty lineage below — which
            // on a single-record concept would delete the record the flag promises
            // exists. Freshly toggling a VERSIONED concept produces exactly that
            // state (its new record is a draft), so this is the common path, not a
            // corner: without this guard the record is one click from gone.
            yield* assertRecordUnprotected(recordVersion.conceptId, recordVersion.id)
            const concept = yield* concepts.getById(recordVersion.conceptId)
            yield* sql`DELETE FROM relations WHERE org_id = ${orgId} AND from_id = ${recordVersion.id}`
            yield* sql`DELETE FROM mentions WHERE org_id = ${orgId} AND from_version_id = ${recordVersion.id}`
            yield* sql`DELETE FROM record_versions WHERE org_id = ${orgId} AND id = ${recordVersion.id}`
            const remaining = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM record_versions
            WHERE org_id = ${orgId} AND record_id = ${recordVersion.recordId}`
            const blobRefs =
              Number(remaining[0]?.count ?? 0) === 0
                ? yield* purgeEmptiedRecord(orgId, recordVersion.recordId)
                : []
            yield* events.append({
              subjectKind: "recordVersion",
              subjectId: recordVersion.id,
              eventType: "RecordVersionPurged",
              payload: { _tag: "RecordVersionPurged" },
              conceptId: concept.id,
              conceptName: concept.name,
            })
            return { recordVersion, blobRefs }
          }),
        )
        .pipe(
          Effect.tap(({ blobRefs }) => sweepBlobs(blobRefs)),
          Effect.map(({ recordVersion }) => recordVersion),
        )

    /** Whole-record (lineage) archive: hides every version from head lists. Distinct
     *  from per-version `archive` (which hides one version). */
    const archiveRecord = (input: { readonly recordId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // Read the lineage BEFORE writing: this is the guarded path for a
          // versioned single record (the header "Archive" archives the whole
          // lineage, not one version), and it's the one destructive path that
          // otherwise never loads the concept at all.
          const existing = yield* sql<RecordRow>`
            SELECT * FROM records WHERE org_id = ${orgId} AND id = ${input.recordId} LIMIT 1`
          if (!existing[0])
            return yield* Effect.fail(new RecordNotFound({ recordId: input.recordId }))
          const concept = yield* concepts.getById(existing[0].concept_id)
          if (concept.singleRecord) {
            return yield* Effect.fail(
              new SingleRecordProtected({ conceptId: concept.id, recordVersionId: input.recordId }),
            )
          }
          const rows = yield* sql<RecordRow>`
            UPDATE records SET archived_at = COALESCE(archived_at, now())
            WHERE org_id = ${orgId} AND id = ${input.recordId} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new RecordNotFound({ recordId: input.recordId }))
          const record = toRecord(row)
          yield* events.append({
            subjectKind: "record",
            subjectId: record.id,
            eventType: "RecordArchived",
            payload: { _tag: "RecordArchived" },
            conceptId: record.conceptId,
          })
          return record
        }),
      )

    const restoreRecord = (input: { readonly recordId: string }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<RecordRow>`
            UPDATE records SET archived_at = NULL
            WHERE org_id = ${orgId} AND id = ${input.recordId} RETURNING *`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new RecordNotFound({ recordId: input.recordId }))
          const record = toRecord(row)
          yield* events.append({
            subjectKind: "record",
            subjectId: record.id,
            eventType: "RecordRestored",
            payload: { _tag: "RecordRestored" },
            conceptId: record.conceptId,
          })
          return record
        }),
      )

    const getRecord = (recordId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<RecordRow>`
          SELECT * FROM records WHERE id = ${recordId} AND org_id = ${orgId} LIMIT 1`
        const row = rows[0]
        if (!row) return yield* Effect.fail(new RecordNotFound({ recordId }))
        yield* assertConceptVisible(row.concept_id, recordId)
        // THE ANNOTATION CHOKEPOINT: notes, tasks, files and the activity feed all
        // resolve through here (`assertSubjectReadable` in use-cases.ts), because
        // their tables carry no concept column. Without this a shared record id would
        // leak a restricted record's whole annotation trail.
        yield* assertRecordReadable(row.concept_id, recordId, recordId)
        return toRecord(row)
      })

    /** The record's current latest published, non-archived version — or null. Used to
     *  resolve a general ("Latest") reference at read time. */
    const headOf = (recordId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<RecordVersionRow>`
          SELECT * FROM record_versions
          WHERE org_id = ${orgId} AND record_id = ${recordId}
            AND version_status = 'published' AND archived_at IS NULL
          ORDER BY version_seq DESC LIMIT 1`
        const head = rows[0]
        if (!head) return null
        yield* assertConceptVisible(head.concept_id, head.id)
        yield* assertRecordReadable(head.concept_id, head.record_id, head.id, head.state)
        return toRecordVersion(head)
      })

    /**
     * The sole record of a single-record concept — its live lineage's current
     * version — or null if the concept has none.
     *
     * NOT `headOf` alone, and NOT `QueryService.findRecords(...)[0]`: both are
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
        const recordRows = yield* sql<RecordRow>`
          SELECT * FROM records
          WHERE org_id = ${orgId} AND concept_id = ${conceptId} AND archived_at IS NULL
          ORDER BY created_at ASC LIMIT 1`
        const record = recordRows[0]
        // Gate on the concept asked about, before any row is returned. A restricted
        // single-record concept reads as absent rather than erroring, matching the
        // `null` a member already gets for a concept with no record yet.
        if (record) yield* assertConceptVisible(conceptId, record.id)
        if (record) yield* assertRecordReadable(conceptId, record.id, record.id)
        if (!record) return null
        const head = yield* headOf(record.id)
        if (head) return head
        // Fall back to the newest version of ANY status (the draft-only case).
        const anyRows = yield* sql<RecordVersionRow>`
          SELECT * FROM record_versions
          WHERE org_id = ${orgId} AND record_id = ${record.id} AND archived_at IS NULL
          ORDER BY version_seq DESC LIMIT 1`
        return anyRows[0] ? toRecordVersion(anyRows[0]) : null
      })

    /**
     * Flip a concept's `singleRecord` flag, creating its record when switching on.
     *
     * Lives HERE, not on ConceptService (which can't call RecordService — it's
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
          // both read zero records and both create a record.
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
          const liveItems = yield* liveRecordCountOf(concept.id)
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

    /** All versions of an record (draft + published, including per-version archived),
     *  oldest first — for the record-detail version history panel. */
    const listVersions = (recordId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<RecordVersionRow>`
          SELECT * FROM record_versions
          WHERE org_id = ${orgId} AND record_id = ${recordId}
          ORDER BY version_seq ASC`
        // Every version of a record shares its concept, so one check covers them all.
        const first = rows[0]
        if (first) yield* assertConceptVisible(first.concept_id, first.id)
        // Every version shares the lineage, so one record check covers them all.
        if (first) yield* assertRecordReadable(first.concept_id, first.record_id, first.id)
        return rows.map(toRecordVersion)
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
      archiveRecord,
      restoreRecord,
      getRecord,
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
