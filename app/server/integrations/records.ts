import { Effect } from "effect"
import {
  ConceptService,
  type FieldConfig,
  type FieldKind,
  FieldService,
  type OrgScope,
  RecordService,
  type RecordVersion,
} from "#engine"
import { pool } from "../db"
import { runEngineOrThrow } from "../runtime"

/**
 * Reusable foundation for surfacing external (integration-synced) records inside
 * Kingsmaker as ordinary concept record versions — so the EXISTING generic dashboard
 * widgets (List/Kanban/Calendar) can render them with no widget changes.
 *
 * Connectors run as plain async/SQL code OUTSIDE an HTTP request, so engine
 * Effects are executed here the same way the seed does: `runEngineOrThrow(scope,
 * effect)` provides the connection's org as `OrgContext`. Everything is keyed by
 * field/concept **id** (never a name literal — concepts and fields are
 * renameable) and is idempotent across repeated syncs.
 */

/** One field a provisioned concept should carry. `key` is the stable logical
 *  handle the caller uses in the returned field map (decoupled from the display
 *  `name`, which the org may rename later). */
export interface ProvisionFieldSpec {
  readonly key: string
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  readonly icon?: string
}

/** A concept to ensure exists for an org, with its fields. */
export interface ProvisionConceptSpec {
  readonly name: string
  readonly pluralName?: string
  readonly description?: string
  readonly icon?: string
  readonly color?: string
  /** Marks this as a connector-owned "managed concept" (e.g. "google.gmail").
   *  Locked from user edits + given an opinionated detail view. */
  readonly managedBy?: string
  /** Logical `key` of the field to use as the record version display label ("title").
   *  Set as the concept's `titleFieldId` at provision time (overriding the
   *  auto-assigned first field), so e.g. an event shows its Title, not its id. */
  readonly titleFieldKey?: string
  readonly fields: ReadonlyArray<ProvisionFieldSpec>
}

/** The stable handle a caller stores on its connection row and reuses every sync. */
export interface ProvisionedConcept {
  readonly conceptId: string
  /** `{ logicalKey -> field id }` — pin these ids; field names are decorative. */
  readonly fieldMap: Record<string, string>
}

/**
 * Ensure a concept (by display name) + its fields exist for the org, returning
 * its id and a `{ key -> fieldId }` map. Idempotent: an existing concept is
 * reused (by name) and only missing fields are added — mirrors `seed.ts`'s
 * `ensureConcept`. This is NOT the global signup seed; it provisions a single
 * concept on demand and never touches other orgs.
 *
 * Callers should persist the returned `{ conceptId, fieldMap }` and skip calling
 * this once stored, so a later concept/field rename never re-triggers creation.
 */
export const provisionConcept = (
  scope: OrgScope,
  spec: ProvisionConceptSpec,
): Promise<ProvisionedConcept> =>
  runEngineOrThrow(
    scope,
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const concept = yield* concepts.getByName(spec.name).pipe(
        Effect.catchTag("ConceptNotFound", () =>
          concepts.create({
            name: spec.name,
            pluralName: spec.pluralName,
            description: spec.description,
            icon: spec.icon,
            color: spec.color,
            managedBy: spec.managedBy,
          }),
        ),
      )
      const existing = yield* fields.listFields(concept.id)
      const have = new Set(existing.map((f) => f.name))
      for (const field of spec.fields) {
        if (have.has(field.name)) continue
        yield* fields.addField({
          conceptId: concept.id,
          name: field.name,
          kind: field.kind,
          config: field.config,
          icon: field.icon,
          // Mark connector-synced fields read-only (mirrors the concept marker);
          // user-added fields on this concept stay null and remain editable.
          managedBy: spec.managedBy,
        })
      }
      // Re-list after adding so the map covers freshly created fields too. Match
      // the spec's display names to ids ONCE, here at provision time; callers then
      // persist the ids and never name-match again.
      const all = yield* fields.listFields(concept.id)
      const idByName = new Map(all.map((f) => [f.name, f.id]))
      const fieldMap: Record<string, string> = {}
      for (const field of spec.fields) {
        const id = idByName.get(field.name)
        if (id) fieldMap[field.key] = id
      }
      // Pin the display label ("title") to the declared field, overriding the
      // first-field default `addField` auto-assigns (the external-id key is added
      // first). Idempotent: re-provision keeps it pinned.
      const titleId = spec.titleFieldKey ? fieldMap[spec.titleFieldKey] : undefined
      if (titleId) yield* concepts.setTitleField(concept.id, titleId)
      return { conceptId: concept.id, fieldMap }
    }),
  )

/** Outcome of an upsert: the resulting record version and whether it was newly created. */
export interface UpsertResult {
  readonly recordVersion: RecordVersion
  readonly created: boolean
}

/**
 * Upsert one concept record version keyed by an external id held in one of its fields.
 * Looks up a live record version of `conceptId` whose `state[externalFieldId]` equals
 * `externalValue` (org + concept scoped) via the shared pool — the same way
 * other connectors read engine-projection tables — then runs the create/update
 * as an engine Effect (event-sourced) within the org's `OrgContext`. `fields` is
 * already keyed by field id (use the map from `provisionConcept`). Idempotent
 * across syncs; the external id field should be `config.unique` so a create race
 * still can't duplicate.
 */
export const upsertRecordVersionByExternalId = async (
  scope: OrgScope,
  input: {
    readonly conceptId: string
    readonly externalFieldId: string
    readonly externalValue: string
    readonly fields: Record<string, unknown>
  },
): Promise<UpsertResult> => {
  // Newest live row wins: on a versioned concept that's the open draft if one
  // exists, else the published head.
  const found = await pool.query<{
    id: string
    version: number
    version_status: string
    versioning_enabled: boolean
  }>(
    `SELECT i.id, i.version, i.version_status, c.versioning_enabled
       FROM record_versions i JOIN concepts c ON c.id = i.concept_id AND c.org_id = i.org_id
      WHERE i.org_id = $1 AND i.concept_id = $2 AND i.state->>$3 = $4 AND i.archived_at IS NULL
      ORDER BY i.version_seq DESC
      LIMIT 1`,
    [scope.orgId, input.conceptId, input.externalFieldId, input.externalValue],
  )
  const existing = found.rows[0]
  // A connector never amends a PUBLISHED version, even where the concept permits it
  // (`editReach: "any"`). Amending is a human act of correcting the record; a
  // connector inheriting that permission would rewrite published history on a timer,
  // invisibly to whoever published it. Refuse instead — same outcome the engine's
  // freeze gave before amendments existed, just no longer contingent on a setting.
  if (existing?.versioning_enabled && existing.version_status !== "draft") {
    throw new Error(
      `refusing to sync into published version ${existing.id}: open a draft on this record first`,
    )
  }
  if (!existing) {
    const recordVersion = await runEngineOrThrow(
      scope,
      Effect.gen(function* () {
        const recordVersions = yield* RecordService
        return yield* recordVersions.create({ conceptId: input.conceptId, fields: input.fields })
      }),
    )
    return { recordVersion, created: true }
  }
  const recordVersion = await runEngineOrThrow(
    scope,
    Effect.gen(function* () {
      const recordVersions = yield* RecordService
      return yield* recordVersions.update({
        recordVersionId: existing.id,
        expectedVersion: Number(existing.version),
        patch: input.fields,
      })
    }),
  )
  return { recordVersion, created: false }
}
