import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import {
  type AccessAction,
  type AccessCondition,
  AccessDefaultsService,
  type AccessResourceType,
  AccessRoleService,
  type AnnotationField,
  AnnotationFieldService,
  AnnotationService,
  type AnnotationType,
  type Attachment,
  AttachmentService,
  AUTOMATION_ACTOR_PREFIX,
  type Automation,
  type AutomationAction,
  type AutomationRun,
  AutomationService,
  type AutomationTrigger,
  ComputedFields,
  ConceptService,
  type ConceptVisibility,
  type ConditionMatch,
  canReadRestricted,
  type DashboardBody,
  DashboardService,
  decide,
  type EditReach,
  type EngineServices,
  EventStore,
  type FieldConfig,
  type FieldKind,
  FieldService,
  FieldValidationError,
  GrantService,
  type GraphLayoutPositions,
  GraphLayoutService,
  LABELS_KEY,
  type Label,
  LabelService,
  type ListTasksFilter,
  MAX_MENTIONS_PER_DOC,
  ManagedConceptReadonly,
  MemberService,
  MentionService,
  type Note,
  OrgContext,
  PolicyService,
  projectState,
  QueryService,
  RecordService,
  type RecordVersion,
  type RecordViewLayout,
  type RecordViewPrefsBody,
  RelationService,
  type RichTextValue,
  type SidebarCondition,
  type SidebarViewBody,
  SidebarViewService,
  scopeHiddenFieldIds,
  type Task,
  type TaskPriority,
  TaskPriorityService,
  type TaskStatus,
  type TaskStatusCategory,
  TaskStatusService,
  type UploadOwner,
} from "#engine"
// The runner owns the dry-run evaluation (it also owns trigger matching and the
// shared condition evaluator); this is the only import of it from a use-case, and
// it does not import back — no cycle.
import { dryRun } from "./automations"

/** All use-cases return engine effects (R = OrgContext | EngineServices) for runScoped. */
type UC<A, E = unknown> = Effect.Effect<A, E, OrgContext | EngineServices>

// ── managed-concept guard ─────────────────────────────────────────────────────
// A connector-managed concept's schema + record versions are owned by an integration
// sync; the sync path calls the engine services directly (runEngineOrThrow),
// never through these use-cases, so it stays free to write. At the use-case
// boundary the guard is FIELD-LEVEL: synced fields (Field.managedBy set) and the
// record lifecycle stay read-only, but members may add + edit their OWN fields
// (managedBy null) — e.g. a status on a synced email. Discriminated by the typed
// `managedBy` kind on the concept/field — never by name.

const ensureUnmanagedConcept = (conceptId: string): UC<void> =>
  Effect.flatMap(ConceptService, (c) => c.getById(conceptId)).pipe(
    Effect.flatMap((concept) =>
      concept.managedBy
        ? Effect.fail(
            new ManagedConceptReadonly({ concept: concept.name, managedBy: concept.managedBy }),
          )
        : Effect.void,
    ),
  )

const ensureUnmanagedRecordVersion = (recordVersionId: string): UC<void> =>
  Effect.flatMap(RecordService, (i) => i.get(recordVersionId)).pipe(
    Effect.flatMap((inst) => ensureUnmanagedConcept(inst.conceptId)),
    // get() is live-only; if the record version is archived/gone, skip the guard and let
    // the real mutation surface the proper RecordVersionNotFound. Live managed record versions
    // (the case that matters) are still covered by create/archive guards.
    Effect.catchAll((e) =>
      (e as { _tag?: string })?._tag === "RecordVersionNotFound" ? Effect.void : Effect.fail(e),
    ),
  )

// Block a SCHEMA edit (rename/config/archive/delete) to a connector-SYNCED field;
// a user-added field on the same concept (managedBy null) stays editable.
const ensureUnmanagedField = (fieldId: string): UC<void> =>
  Effect.flatMap(FieldService, (f) => f.getById(fieldId)).pipe(
    Effect.flatMap((field) =>
      field.managedBy
        ? Effect.flatMap(ConceptService, (c) => c.getById(field.conceptId)).pipe(
            Effect.flatMap((concept) =>
              Effect.fail(
                new ManagedConceptReadonly({
                  concept: concept.name,
                  managedBy: field.managedBy as string,
                }),
              ),
            ),
          )
        : Effect.void,
    ),
  )

// For a record version VALUE write to specific keys: a managed concept accepts the
// write only when every touched key is a user-added (unmanaged) field — so a
// member can set their own fields on a synced record while the integration's
// fields stay read-only. Unmanaged concepts pass freely (no field is managed); a
// missing/archived record version skips the guard (the real mutation surfaces the
// proper RecordVersionNotFound). Keyed by field id; non-field keys (e.g. __labels) pass.
const ensureWritablePatch = (recordVersionId: string, keys: ReadonlyArray<string>): UC<void> =>
  Effect.flatMap(RecordService, (i) => i.get(recordVersionId)).pipe(
    Effect.flatMap((inst) =>
      Effect.flatMap(ConceptService, (c) => c.getById(inst.conceptId)).pipe(
        Effect.flatMap((concept) =>
          !concept.managedBy
            ? Effect.void
            : Effect.flatMap(FieldService, (f) =>
                f.listFields(concept.id, { includeArchived: true }),
              ).pipe(
                Effect.flatMap((fields) => {
                  const managed = new Set(fields.filter((fd) => fd.managedBy).map((fd) => fd.id))
                  return keys.some((k) => managed.has(k))
                    ? Effect.fail(
                        new ManagedConceptReadonly({
                          concept: concept.name,
                          managedBy: concept.managedBy as string,
                        }),
                      )
                    : Effect.void
                }),
              ),
        ),
      ),
    ),
    Effect.catchAll((e) =>
      (e as { _tag?: string })?._tag === "RecordVersionNotFound" ? Effect.void : Effect.fail(e),
    ),
  )

// ── reads ───────────────────────────────────────────────────────────────────

/** The field id that holds a record version's display label ("title"): the concept's
 *  explicit `titleFieldId`, else the first text field (fallback for an as-yet
 *  unconfigured concept). Mirrors the client `instanceLabel`. */
const titleFieldIdOf = (
  titleFieldId: string | null,
  defs: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): string | undefined => titleFieldId ?? defs.find((f) => f.kind === "text")?.id

export interface ListOpts {
  readonly where?: Record<string, unknown>
  readonly orderBy?: { readonly field: string; readonly dir?: "asc" | "desc" }
  readonly relatedToTo?: { readonly fieldId: string; readonly toId: string }
  readonly limit?: number
  readonly decorate?: boolean
  readonly includeArchived?: boolean
}

/**
 * The field-visibility projection, resolved once per concept.
 *
 * Every read below that returns record version state runs through this. It lives HERE
 * and not deeper in the engine on purpose — `domain/visibility.ts` documents the
 * two placements that silently corrupt data (a filter in `toRecordVersion` deletes
 * hidden values on the next edit; a filter in `FieldService.listFields` disables
 * required-field enforcement).
 *
 * One `listFields` call covers a whole page of rows, because every row in a
 * `listRecords` result shares one concept.
 */
const fieldMaskFor = (conceptId: string): UC<ReadonlySet<string>> =>
  Effect.gen(function* () {
    const scope = yield* OrgContext
    // No early return for privileged roles: a DENY rule must be able to hide a field
    // from an admin, and only `scopeHiddenFieldIds` knows that. It still short-
    // circuits internally when the caller is privileged and holds no field rules.
    if (canReadRestricted(scope) && !hasFieldRules(scope)) return new Set<string>()
    const fields = yield* FieldService
    // includeArchived: an archived field's values linger in `state`, so a hidden
    // one must stay masked after it is archived.
    const defs = yield* fields.listFields(conceptId, { includeArchived: true })
    return scopeHiddenFieldIds(scope, defs)
  })

/** Does this caller hold any field-scoped rule? Lets the privileged fast path above
 *  stay a no-op for the overwhelmingly common case of no field rules at all. */
const hasFieldRules = (scope: {
  readonly policy?: { readonly rules: ReadonlyArray<{ readonly resourceType: string }> }
}): boolean => scope.policy?.rules.some((r) => r.resourceType === "field") ?? false

/** Run a write and project its echoed record version, so a writer's response carries no
 *  more than a reader's would. */
const maskEcho = (eff: UC<RecordVersion>): UC<RecordVersion> =>
  Effect.gen(function* () {
    const out = yield* eff
    return maskRecordVersion(out, yield* fieldMaskFor(out.conceptId))
  })

/**
 * Refuse to WRITE a field the caller may not read. Without this a member could
 * overwrite a hidden salary without ever seeing it — and could probe it via the
 * unique-constraint error.
 *
 * Fails with the SAME `FieldValidationError` shape `validateFields` already emits
 * for a bogus key, so a hidden field is indistinguishable from a nonexistent one
 * (and needs no new error code or ERROR_MAP entry).
 */
const ensureWritableVisibility = (conceptId: string, keys: ReadonlyArray<string>): UC<void> =>
  Effect.gen(function* () {
    const hidden = yield* fieldMaskFor(conceptId)
    if (hidden.size === 0) return
    const blocked = keys.find((k) => hidden.has(k))
    if (blocked)
      return yield* Effect.fail(
        new FieldValidationError({ message: `unknown field "${blocked}"`, field: blocked }),
      )
  })

/** Drop hidden keys from a field-id-keyed record (a patch, or a `previous` map). */
const maskRecord = (
  rec: Record<string, unknown> | undefined,
  hidden: ReadonlySet<string>,
): Record<string, unknown> | undefined =>
  !rec || hidden.size === 0 ? rec : projectState(rec, hidden)

/**
 * Drop hidden field keys from an event payload. Three payload shapes carry
 * field-id-keyed data — `RecordVersionCreated.fields`, `RecordVersionUpdated.patch` and
 * `VersionAmended.patch` — and `ComputedBandChanged` names a single field, whose
 * very mention would disclose a hidden one.
 */
const maskPayload = (payload: unknown, hidden: ReadonlySet<string>): unknown => {
  if (hidden.size === 0 || !payload || typeof payload !== "object") return payload
  const p = payload as { _tag?: string; fields?: unknown; patch?: unknown; field?: unknown }
  if (p._tag === "RecordVersionCreated" && p.fields && typeof p.fields === "object")
    return { ...p, fields: projectState(p.fields as Record<string, unknown>, hidden) }
  if (
    (p._tag === "RecordVersionUpdated" || p._tag === "VersionAmended") &&
    p.patch &&
    typeof p.patch === "object"
  )
    return { ...p, patch: projectState(p.patch as Record<string, unknown>, hidden) }
  if (p._tag === "ComputedBandChanged" && typeof p.field === "string" && hidden.has(p.field))
    return { _tag: p._tag }
  return payload
}

/**
 * Gate a read that keys purely off a record id.
 *
 * The annotation + attachment tables (`annotations.subject_id`,
 * `attachments.item_id`) carry no concept column, so their queries cannot filter on
 * visibility themselves — a member holding a restricted record's record id could
 * otherwise read its notes, tasks, files and activity. `RecordService.getRecord`
 * carries the concept read gate, so resolving the lineage IS the check.
 *
 * A subject that is not a record at all (annotations have their own ids)
 * falls through rather than denying: the gate must only fire on a real, restricted
 * lineage.
 */
const assertSubjectReadable = (subjectId: string): UC<void> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    yield* recordVersions
      .getRecord(subjectId)
      .pipe(Effect.catchTag("RecordNotFound", () => Effect.void))
  })

/**
 * Gate a WRITE whose subject is a record.
 *
 * The mirror of `assertSubjectReadable`, and needed for the same reason the record version
 * write gate is (see THE WRITE GATE in engine/services/RecordService.ts): every READ
 * of an annotation was gated while `createNote` / `createTask` named the subject
 * directly and were not. A member could attach content to a record they cannot see.
 *
 * `null` is an ORG-LEVEL annotation — it belongs to no record, so there is nothing to
 * gate and it must stay allowed (the global Tasks page creates these).
 *
 * Deliberately reuses the read gate: "may I write to this subject?" is answered by
 * "may I read it?", so the two can never disagree. Per-annotation mutation rights
 * (author / assignee / admin) are a separate, additional check at the RPC boundary.
 */
const assertSubjectWritable = (subjectId: string | null): UC<void> =>
  subjectId === null ? Effect.void : assertSubjectReadable(subjectId)

/** Apply a mask to one record version (no-op when nothing is hidden). */
const maskRecordVersion = <T extends { readonly state: Record<string, unknown> }>(
  inst: T,
  hidden: ReadonlySet<string>,
): T => (hidden.size === 0 ? inst : { ...inst, state: projectState(inst.state, hidden) })

export const listRecords = (
  conceptId: string,
  opts: ListOpts = {},
): UC<ReadonlyArray<RecordVersion>> =>
  Effect.gen(function* () {
    const query = yield* QueryService
    const computed = yield* ComputedFields
    const rows = yield* query.findRecords({
      conceptId,
      where: opts.where,
      orderBy: opts.orderBy,
      relatedToTo: opts.relatedToTo,
      limit: opts.limit,
      includeArchived: opts.includeArchived,
    })
    // Load the concept's field defs ONCE and use them for both jobs below. Without
    // this `decorate` does its own `listFields` per record version — and this path runs
    // with a 50 000-row cap, so that was a real N+1 on the hottest read in the app.
    const defs = opts.decorate ? yield* (yield* FieldService).listFields(conceptId) : []
    const decorated = opts.decorate
      ? yield* Effect.forEach(rows, (r) => computed.decorate(r, defs))
      : rows
    const hidden = yield* fieldMaskFor(conceptId)
    return hidden.size === 0 ? decorated : decorated.map((r) => maskRecordVersion(r, hidden))
  })

export const getRecord = (id: string, decorate = false): UC<RecordVersion> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const computed = yield* ComputedFields
    const inst = yield* recordVersions.get(id)
    const out = decorate ? yield* computed.decorate(inst) : inst
    return maskRecordVersion(out, yield* fieldMaskFor(inst.conceptId))
  })

/**
 * One record version plus its detail context: concept, field defs, and every related
 * record version (both directions) with its concept name resolved — for the detail
 * view's "connected things". Dangling relations (target deleted) are skipped.
 */
export const getRecordDetail = (id: string): UC<unknown> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const relations = yield* RelationService
    const conceptsSvc = yield* ConceptService
    const fieldsSvc = yield* FieldService
    const computed = yield* ComputedFields
    const labelsSvc = yield* LabelService

    const inst = yield* recordVersions.get(id)
    const [decorated, concept, fieldDefs, inboundFields, outRels, inRels, allConcepts] =
      yield* Effect.all([
        computed.decorate(inst),
        conceptsSvc.getById(inst.conceptId),
        fieldsSvc.listFields(inst.conceptId),
        fieldsSvc.listRelationFieldsTargeting(inst.conceptId),
        relations.listFrom(id),
        relations.listTo(id),
        conceptsSvc.list(),
      ])
    const nameById = new Map(allConcepts.map((c) => [c.id, c.name] as const))
    const titleByConcept = new Map(allConcepts.map((c) => [c.id, c.titleFieldId] as const))

    // Inherited (static) labels come from the concept; the record version's own labels
    // live under the synthetic `__labels` state key. Both resolved to live labels
    // (soft-deleted ids drop out); own labels exclude any already shown as static.
    const ownLabelIds = Array.isArray(inst.state[LABELS_KEY])
      ? (inst.state[LABELS_KEY] as ReadonlyArray<string>)
      : []
    const staticIdSet = new Set(concept.staticLabelIds)
    const [staticLabels, ownLabels] = yield* Effect.all([
      labelsSvc.resolve(concept.staticLabelIds),
      labelsSvc.resolve(ownLabelIds.filter((lid) => !staticIdSet.has(lid))),
    ])

    // Resolve one edge to its display target. Outbound: a pinned ref resolves to
    // its specific version, a general ref to the record's CURRENT latest published
    // (re-resolved here — the shadow `toId` may be stale after a republish).
    // Inbound: the source version (already filtered to published by `listTo`).
    const resolveEntry = (
      rel: {
        id: string
        fieldId: string
        fromId: string
        toRecordId: string
        toVersionId: string | null
      },
      direction: "out" | "in",
    ) =>
      Effect.gen(function* () {
        const pinned = rel.toVersionId !== null
        const otherId =
          direction === "in"
            ? rel.fromId
            : pinned
              ? (rel.toVersionId as string)
              : ((yield* recordVersions.headOf(rel.toRecordId))?.id ?? null)
        const field = yield* fieldsSvc.getById(rel.fieldId)
        // Dangling: a general ref whose record has no live published version, OR a
        // pinned target that is archived/gone (record versions.get is live-only).
        // Surface both as unavailable rather than silently dropping the edge.
        const other = otherId
          ? yield* recordVersions.get(otherId).pipe(Effect.catchAll(() => Effect.succeed(null)))
          : null
        // A target in a concept this caller may not read: DROP the edge entirely
        // rather than fall into the "(unavailable)" shape below, which would still
        // confirm that a connection exists (and name its concept). `nameById` comes
        // from the filtered `concepts.list()`, so a missing name is the signal.
        if (otherId && !other) {
          const targetRecord = yield* recordVersions
            .getRecord(rel.toRecordId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (!targetRecord) return null
        }
        if (!other) {
          const record = yield* recordVersions
            .getRecord(rel.toRecordId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          const cId = record?.conceptId ?? ""
          return {
            relationId: rel.id,
            fieldId: rel.fieldId,
            relationName: field.name,
            relationInverseName: field.config.inverseName ?? null,
            relationInversePluralName: field.config.inversePluralName ?? null,
            label: "(unavailable)",
            direction,
            conceptId: cId,
            conceptName: cId ? (nameById.get(cId) ?? cId) : "(unavailable)",
            pinned,
            recordVersion: null,
          }
        }
        const [otherFields, d] = yield* Effect.all([
          fieldsSvc.listFields(other.conceptId),
          computed.decorate(other),
        ])
        // Resolve a display label from the connected concept's title field (its
        // state is keyed by field id; the client lacks these defs).
        const titleId = titleFieldIdOf(titleByConcept.get(other.conceptId) ?? null, otherFields)
        // The related record belongs to a DIFFERENT concept, so it needs that
        // concept's own mask — including for the title label below, or a hidden
        // title field would leak through the edge's display text.
        const otherHidden = yield* fieldMaskFor(other.conceptId)
        const dMasked = maskRecordVersion(d, otherHidden)
        return {
          relationId: rel.id,
          fieldId: rel.fieldId,
          // Decorative labels, resolved from the field def (renameable).
          relationName: field.name,
          relationInverseName: field.config.inverseName ?? null,
          relationInversePluralName: field.config.inversePluralName ?? null,
          label: titleId && dMasked.state[titleId] ? String(dMasked.state[titleId]) : "(untitled)",
          direction,
          conceptId: other.conceptId,
          conceptName: nameById.get(other.conceptId) ?? other.conceptId,
          pinned,
          recordVersion: dMasked,
        }
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    const related = yield* Effect.all([
      Effect.forEach(outRels, (r) => resolveEntry(r, "out")),
      Effect.forEach(inRels, (r) => resolveEntry(r, "in")),
    ]).pipe(Effect.map(([a, b]) => [...a, ...b].filter((x) => x !== null)))

    // The host's own mask, applied to both its values and the field DEFS it ships:
    // a def whose values are masked must not appear at all, or the table renders a
    // column that is permanently blank (and names a field the caller can't read).
    const hostHidden = yield* fieldMaskFor(inst.conceptId)
    return {
      recordVersion: maskRecordVersion(decorated, hostHidden),
      concept,
      fields: fieldDefs.filter((f) => !hostHidden.has(f.id)),
      inboundRelationFields: inboundFields,
      related,
      staticLabels,
      labels: ownLabels,
    }
  })

export const listConcepts = (includeArchived = false, withCounts = false): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) => c.list({ includeArchived, withCounts }))

/** The dashboard a fresh concept starts with: its record version table as one
 *  full-width list widget. An ORDINARY org dashboard — renameable, deletable;
 *  the widget's own `conceptId` config is the only reference to the concept. */
export const conceptDashboardSeed = (conceptId: string): DashboardBody => ({
  widgets: [
    {
      id: crypto.randomUUID(),
      type: "list",
      title: null,
      layout: { x: 0, y: 0, w: 12, h: 7 },
      conceptId,
      conditions: [],
      orderBy: null,
      limit: null,
    },
  ],
})

export const createConcept = (
  name: string,
  color?: string | null,
  access?: ReadonlyArray<{ readonly roleId: string; readonly view: boolean }>,
): UC<unknown> =>
  Effect.gen(function* () {
    const concepts = yield* ConceptService
    const dashboards = yield* DashboardService
    const concept = yield* concepts.create({ name, color, access })
    // Every concept starts with a dashboard (deletable like any other).
    yield* dashboards.create({
      name: concept.name,
      icon: concept.icon,
      scope: "org",
      body: conceptDashboardSeed(concept.id),
    })
    return concept
  })

export const updateConcept = (
  id: string,
  patch: {
    readonly name?: string
    readonly pluralName?: string | null
    readonly description: string | null
    readonly icon?: string | null
    readonly color?: string | null
    readonly versioningEnabled?: boolean
    readonly editReach?: EditReach
    readonly staticLabelIds?: ReadonlyArray<string>
    readonly defaultLabelIds?: ReadonlyArray<string>
  },
): UC<unknown> =>
  Effect.gen(function* () {
    yield* ensureUnmanagedConcept(id)
    return yield* Effect.flatMap(ConceptService, (c) =>
      c.update({
        id,
        name: patch.name,
        pluralName: patch.pluralName,
        description: patch.description,
        icon: patch.icon,
        color: patch.color,
        versioningEnabled: patch.versioningEnabled,
        editReach: patch.editReach,
        staticLabelIds: patch.staticLabelIds,
        defaultLabelIds: patch.defaultLabelIds,
      }),
    )
  })

export const setConceptRecordView = (
  id: string,
  recordView: RecordViewLayout | null,
): UC<unknown> => Effect.flatMap(ConceptService, (c) => c.setRecordView(id, recordView))

/** Designate (or clear) a concept's title field. Rejected for a managed concept —
 *  the integration owns its title (set at provision time). */
/** Set who may read a concept's records (admin-gated at the RPC boundary). */
/** Set who may read ONE field's values (admin-gated at the RPC boundary). */
export const setFieldVisibility = (id: string, visibility: ConceptVisibility): UC<unknown> =>
  Effect.flatMap(FieldService, (f) => f.setVisibility(id, visibility))

export const setConceptVisibility = (id: string, visibility: ConceptVisibility): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) => c.setVisibility(id, visibility))

export const setConceptTitleField = (id: string, titleFieldId: string | null): UC<unknown> =>
  ensureUnmanagedConcept(id).pipe(
    Effect.zipRight(Effect.flatMap(ConceptService, (c) => c.setTitleField(id, titleFieldId))),
  )

/**
 * Turn a concept's "single record" mode on or off. Rejected for a managed concept
 * — an integration syncs N rows into its concepts, so the one-record rule can
 * never hold there.
 *
 * Deliberately NOT folded into `updateConcept`'s batched patch: switching on also
 * CREATES the record, atomically, and `fields` carries that record's initial
 * values (required when the concept has required fields). A second setter on the
 * batch path would flip the flag without the record and without the guard.
 */
export const setConceptSingleRecord = (
  conceptId: string,
  singleRecord: boolean,
  fields?: Record<string, unknown>,
): UC<unknown> =>
  ensureUnmanagedConcept(conceptId).pipe(
    Effect.zipRight(
      Effect.flatMap(RecordService, (i) =>
        i.setConceptSingleRecord({ conceptId, singleRecord, fields }),
      ),
    ),
  )

/**
 * The sole record of a single-record concept, as the SAME `RecordDetail` shape
 * `getRecord` returns — so `/c/<slug>` can render through the ordinary record
 * view with no second assembly to keep in sync. Null when the concept has no
 * record (which shouldn't happen while the flag is on: that's the leak detector,
 * not a normal state).
 *
 * Resolution is `singleRecordOf`, NOT `listRecords(...)[0]` — see its doc
 * comment: a versioned concept's first record is a draft and is invisible to
 * every head-only query.
 */
export const getSingleRecord = (conceptId: string): UC<unknown> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const record = yield* recordVersions.singleRecordOf(conceptId)
    if (!record) return null
    return yield* getRecordDetail(record.id)
  })

export const archiveConcept = (id: string): UC<unknown> =>
  ensureUnmanagedConcept(id).pipe(
    Effect.zipRight(Effect.flatMap(ConceptService, (c) => c.archive(id))),
  )

export const restoreConcept = (id: string): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) => c.restore(id))

/**
 * Delete a concept — and, for a single-record concept, its one record with it.
 *
 * The project convention is *block, never cascade*: `ConceptService.purge`
 * refuses while any record version exists (`ConceptInUse`), and the UI offers "Archive
 * instead". That stays exactly as it is — no `singleRecord` special-casing inside
 * the engine. But a single-record concept can never reach zero record versions (its
 * record is created with the flag and protected while it's on), so "delete the
 * concept" would be permanently impossible without this one composition.
 *
 * So the cascade lives HERE, at one call site, rather than becoming a general
 * engine capability. It needs its own return type: `UC` excludes `PgClient`
 * (`use-cases.ts` is otherwise non-transactional), and this must be one
 * transaction — purging the record transiently breaks "always exactly one
 * record", which must never be observable. Every inner `withTransaction` nests as
 * a SAVEPOINT, so a failure at any step rolls the whole thing back and the flag
 * stays on.
 *
 * `RecordVersionInUse` from step 2 is deliberately NOT forced through: if live
 * relations point at the record, orphaning them is precisely what the convention
 * exists to prevent. The caller gets the same 409 an ordinary record purge gives.
 */
export const deleteConcept = (
  id: string,
): Effect.Effect<unknown, unknown, OrgContext | EngineServices | PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* ensureUnmanagedConcept(id)
    const concepts = yield* ConceptService
    const concept = yield* concepts.getById(id)
    if (!concept.singleRecord) return yield* concepts.purge(id)

    const sql = yield* PgClient.PgClient
    const recordVersions = yield* RecordService
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const record = yield* recordVersions.singleRecordOf(id)
        // 1. Clear the flag first — `SingleRecordProtected` would otherwise refuse
        //    the record purge (that guard is the whole point of the flag).
        yield* recordVersions.setConceptSingleRecord({ conceptId: id, singleRecord: false })
        // 2. The record's own versions: purge each, newest first. `purge` drops the
        //    `records` lineage (and its files) with the last one, so the concept then
        //    sees a genuinely empty table rather than an orphaned lineage.
        if (record) {
          const versions = yield* recordVersions.listVersions(record.recordId)
          for (const v of [...versions].reverse()) {
            yield* recordVersions.purge({ recordVersionId: v.id })
          }
        }
        // 3. Unchanged engine purge — `instanceCount === 0` now, so it succeeds on
        //    its ordinary path.
        return yield* concepts.purge(id)
      }),
    )
  })

// ── labels (org-wide vocabulary) ───────────────────────────────────────────────

export const listLabels = (includeArchived = false): UC<ReadonlyArray<Label>> =>
  Effect.flatMap(LabelService, (l) => l.list({ includeArchived }))

export const createLabel = (name: string, color?: string | null, primary?: boolean): UC<Label> =>
  Effect.flatMap(LabelService, (l) => l.create({ name, color, primary }))

export const renameLabel = (
  id: string,
  patch: { readonly name?: string; readonly color?: string | null; readonly primary?: boolean },
): UC<Label> =>
  Effect.flatMap(LabelService, (l) =>
    l.rename({ id, name: patch.name, color: patch.color, primary: patch.primary }),
  )

export const archiveLabel = (id: string): UC<Label> =>
  Effect.flatMap(LabelService, (l) => l.archive(id))

export const restoreLabel = (id: string): UC<Label> =>
  Effect.flatMap(LabelService, (l) => l.restore(id))

export const deleteLabel = (id: string): UC<Label> =>
  Effect.flatMap(LabelService, (l) => l.purge(id))

export const listFields = (conceptId: string, includeArchived = false): UC<unknown> =>
  Effect.gen(function* () {
    const fields = yield* FieldService
    const defs = yield* fields.listFields(conceptId, { includeArchived })
    // Filtered HERE, not in `FieldService.listFields`: that one is also what write
    // validation reads, and filtering it would silently disable required-field
    // enforcement (see domain/visibility.ts). Shipping a hidden def would leak more
    // than the name, too — `config.options` on an enum is real business data.
    const hidden = yield* fieldMaskFor(conceptId)
    return hidden.size === 0 ? defs : defs.filter((f) => !hidden.has(f.id))
  })

/** One field by id — the RPC gate uses it to resolve which CONCEPT a field write
 *  belongs to, so "may configure Deals" covers Deals' schema. Unmasked on purpose:
 *  the caller has already passed the read gate for whatever it is about to do, and
 *  masking here would turn a permission check into a 404 for admins. */
export const getField = (id: string): UC<{ readonly conceptId: string }> =>
  Effect.flatMap(FieldService, (f) => f.getById(id)) as UC<{ readonly conceptId: string }>

// ── sidebar views (configurable nav layouts) ───────────────────────────────────

export const listViews: UC<unknown> = Effect.flatMap(SidebarViewService, (s) => s.list())

export const createView = (input: {
  readonly name: string
  readonly icon?: string | null
  readonly scope: "personal" | "org"
  readonly body: SidebarViewBody
}): UC<unknown> => Effect.flatMap(SidebarViewService, (s) => s.create(input))

export const updateView = (input: {
  readonly id: string
  readonly name?: string
  readonly icon?: string | null
  readonly hidden?: boolean
  readonly scope?: "personal" | "org"
  readonly body?: SidebarViewBody
}): UC<unknown> => Effect.flatMap(SidebarViewService, (s) => s.update(input))

export const deleteView = (id: string): UC<unknown> =>
  Effect.flatMap(SidebarViewService, (s) => s.remove(id))

export const reorderViews = (
  orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
): UC<unknown> => Effect.flatMap(SidebarViewService, (s) => s.reorder(orders))

// ── dashboards (configurable widget canvases) ──────────────────────────────────

export const listDashboards: UC<unknown> = Effect.flatMap(DashboardService, (s) => s.list())

export const listAllDashboards: UC<unknown> = Effect.flatMap(DashboardService, (s) => s.listAll())

export const listRecordDashboards = (conceptId: string): UC<unknown> =>
  Effect.flatMap(DashboardService, (s) => s.listRecordDashboards(conceptId))

export const createDashboard = (input: {
  readonly name: string
  readonly icon?: string | null
  readonly scope: "personal" | "org"
  readonly body: DashboardBody
  readonly kind?: "page" | "record"
  readonly conceptId?: string | null
}): UC<unknown> => Effect.flatMap(DashboardService, (s) => s.create(input))

export const updateDashboard = (input: {
  readonly id: string
  readonly name?: string
  readonly icon?: string | null
  readonly hidden?: boolean
  readonly scope?: "personal" | "org"
  readonly body?: DashboardBody
  readonly conceptId?: string | null
  readonly expectedUpdatedAt?: Date
}): UC<unknown> => Effect.flatMap(DashboardService, (s) => s.update(input))

export const deleteDashboard = (id: string): UC<unknown> =>
  Effect.flatMap(DashboardService, (s) => s.remove(id))

export const reorderDashboards = (
  orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
): UC<unknown> => Effect.flatMap(DashboardService, (s) => s.reorder(orders))

// ── member deactivation + prefs ──────────────────────────────────────────────────

/** The caller's record version-view layout prefs (own row only by construction). */
export const getRecordViewPrefs: UC<unknown> = Effect.flatMap(MemberService, (m) =>
  m.getViewPrefs(),
)

export const updateRecordViewPrefs = (body: RecordViewPrefsBody): UC<unknown> =>
  Effect.flatMap(MemberService, (m) => m.updateViewPrefs(body))

export const listDeactivatedMembers: UC<unknown> = Effect.flatMap(MemberService, (m) =>
  m.listDeactivations(),
)

export const deactivateMember = (userId: string): UC<unknown> =>
  Effect.flatMap(MemberService, (m) => m.deactivate(userId))

export const reactivateMember = (userId: string): UC<unknown> =>
  Effect.flatMap(MemberService, (m) => Effect.map(m.reactivate(userId), () => ({ userId })))

/** The engine half of a member purge (prefs + marker); the membership removal
 *  itself happens in the router against BetterAuth. */
export const purgeMemberData = (userId: string): UC<unknown> =>
  Effect.flatMap(MemberService, (m) => Effect.map(m.purgeMemberData(userId), () => ({ userId })))

// ── concept graph layout (shared canvas positions) ─────────────────────────────

export const getGraphLayout: UC<GraphLayoutPositions> = Effect.flatMap(GraphLayoutService, (s) =>
  s.get(),
)

export const saveGraphLayout = (positions: GraphLayoutPositions): UC<GraphLayoutPositions> =>
  Effect.flatMap(GraphLayoutService, (s) => s.save(positions))

export const getRecordGraphLayout = (recordId: string): UC<GraphLayoutPositions> =>
  Effect.flatMap(GraphLayoutService, (s) => s.getForRecord(recordId))

export const saveRecordGraphLayout = (
  recordId: string,
  positions: GraphLayoutPositions,
): UC<GraphLayoutPositions> =>
  Effect.flatMap(GraphLayoutService, (s) => s.saveForRecord(recordId, positions))

/**
 * The concept relationship graph: every concept is a node, and every relation
 * field is a directed edge from its concept to the field's target concept.
 * Edges whose target concept no longer exists (dangling) are dropped.
 */
export const getConceptGraph: UC<unknown> = Effect.gen(function* () {
  const concepts = yield* Effect.flatMap(ConceptService, (c) => c.list())
  const fields = yield* FieldService
  const fieldsPerConcept = yield* Effect.forEach(concepts, (c) => fields.listFields(c.id))
  const ids = new Set(concepts.map((c) => c.id))
  return {
    nodes: concepts.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      icon: c.icon,
      managedBy: c.managedBy,
    })),
    edges: fieldsPerConcept
      .flat()
      .filter((f) => f.kind === "relation" && !!f.config.target && ids.has(f.config.target))
      .map((f) => ({
        id: f.id,
        from: f.conceptId,
        to: f.config.target as string,
        // Identity is the field id (`id`); these are decorative labels.
        relationType: f.name,
        inverseName: f.config.inverseName ?? null,
        cardinality: f.config.cardinality ?? ("many" as const),
        fieldName: f.name,
      })),
  }
})

export const addField = (input: {
  readonly conceptId: string
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  readonly formula?: string
  readonly icon?: string | null
}): UC<unknown> =>
  // A user-added field is always unmanaged (managedBy null), so any concept —
  // managed or not — accepts it; the synced fields keep their own marker.
  Effect.flatMap(FieldService, (f) => f.addField(input))

export const updateField = (input: {
  readonly id: string
  readonly name?: string
  readonly config?: FieldConfig
  readonly formula?: string | null
  readonly icon?: string | null
}): UC<unknown> =>
  ensureUnmanagedField(input.id).pipe(
    Effect.zipRight(Effect.flatMap(FieldService, (f) => f.update(input))),
  )

export const archiveField = (id: string): UC<unknown> =>
  ensureUnmanagedField(id).pipe(Effect.zipRight(Effect.flatMap(FieldService, (f) => f.archive(id))))

export const restoreField = (id: string): UC<unknown> =>
  Effect.flatMap(FieldService, (f) => f.restore(id))

export const deleteField = (id: string): UC<unknown> =>
  ensureUnmanagedField(id).pipe(Effect.zipRight(Effect.flatMap(FieldService, (f) => f.purge(id))))

export const reorderFields = (
  conceptId: string,
  orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
): UC<unknown> =>
  // Pure presentation (display order); harmless on a managed concept and lets a
  // member position their own fields among the synced ones.
  Effect.flatMap(FieldService, (f) => f.reorder(conceptId, orders))

export interface FeedItem {
  readonly id: number
  readonly occurredAt: Date
  readonly actor: string | null
  readonly eventType: string
  readonly subjectKind: string
  readonly subjectId: string
  /** Raw event payload — only the per-record activity feed sends it (the
   *  org-wide feeds stay metadata-only). */
  readonly payload?: unknown
  /** For field-edit events: what each patched field held before, folded from
   *  the record version's event stream (events store only the new values). */
  readonly previous?: Record<string, unknown>
}

/**
 * Drop events whose subject the caller may not read.
 *
 * WHY: an event row carries `subject_id`, `event_type` and `actor`. The org-wide reads
 * (`getChanged`, unfiltered `listEvents`) never gated any of it, so a member learned
 * the ids of records changing inside concepts they cannot open, and how often. Same
 * class as the SSE envelope leak closed in `server/stream.ts` — metadata, not values
 * (both these use-cases already drop `payload`), but a leak either way.
 *
 * Resolved through `RecordService.get`, which carries both the concept gate and the
 * record gate — so this filter cannot disagree with what a detail read would allow.
 * Deduped by subject, so a page of edits to one record costs one lookup.
 *
 * Non-record version subjects (labels, task statuses, org config) name no restricted material
 * and pass through untouched.
 */
const dropUnreadableSubjects = <
  T extends { readonly subjectKind: string; readonly subjectId: string },
>(
  events: ReadonlyArray<T>,
): UC<ReadonlyArray<T>> =>
  Effect.gen(function* () {
    const subjects = [
      ...new Set(events.filter((e) => e.subjectKind === "recordVersion").map((e) => e.subjectId)),
    ]
    if (subjects.length === 0) return events
    const recordVersions = yield* RecordService
    // Resolved through `RecordService.get`, which already carries BOTH read gates —
    // so this filter can never disagree with what a detail read would allow. Deduped by
    // subject, so a page of edits to one record costs one lookup.
    const readable = new Map<string, boolean>()
    for (const id of subjects) {
      const ok = yield* recordVersions.get(id).pipe(
        Effect.map(() => true),
        // Archived or purged record versions fail `get` too. Dropping them is right: their
        // events are already unreachable, and keeping them would be a fail-open guess.
        Effect.catchAll(() => Effect.succeed(false)),
      )
      readable.set(id, ok)
    }
    return events.filter(
      (e) => e.subjectKind !== "recordVersion" || readable.get(e.subjectId) === true,
    )
  })

export const getChanged: UC<ReadonlyArray<FeedItem>> = Effect.flatMap(EventStore, (e) =>
  e.readAllForOrg({ limit: 50 }),
).pipe(
  Effect.flatMap(dropUnreadableSubjects),
  Effect.map((events) =>
    events.map((ev) => ({
      id: ev.id,
      occurredAt: ev.occurredAt,
      actor: ev.actor,
      eventType: ev.eventType,
      subjectKind: ev.subjectKind,
      subjectId: ev.subjectId,
    })),
  ),
)

export const listEvents = (input: {
  readonly conceptId?: string | null
  readonly since?: number
  readonly limit?: number
}): UC<ReadonlyArray<FeedItem>> =>
  Effect.gen(function* () {
    // A named concept is gated like any other read, so asking about a restricted
    // concept fails NotFound rather than returning its event stream.
    if (input.conceptId)
      yield* Effect.flatMap(ConceptService, (c) => c.getByIdForRead(input.conceptId as string))
    const events = yield* Effect.flatMap(EventStore, (e) =>
      e.listEvents({
        conceptId: input.conceptId ?? undefined,
        since: input.since != null ? new Date(input.since) : undefined,
        limit: input.limit,
      }),
    )
    return yield* dropUnreadableSubjects(events)
  })

// ── commands ──────────────────────────────────────────────────────────────────

export const createRecord = (
  conceptId: string,
  fields: Record<string, unknown>,
): UC<RecordVersion> =>
  ensureUnmanagedConcept(conceptId).pipe(
    Effect.zipRight(ensureWritableVisibility(conceptId, Object.keys(fields))),
    Effect.zipRight(
      maskEcho(Effect.flatMap(RecordService, (i) => i.create({ conceptId, fields }))),
    ),
  )

export const updateRecord = (
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): UC<RecordVersion> =>
  ensureWritablePatch(id, Object.keys(patch)).pipe(
    Effect.zipRight(
      Effect.gen(function* () {
        const recordVersions = yield* RecordService
        const inst = yield* recordVersions.get(id)
        yield* ensureWritableVisibility(inst.conceptId, Object.keys(patch))
        return yield* maskEcho(
          recordVersions.update({ recordVersionId: id, expectedVersion, patch }),
        )
      }),
    ),
  )

export const transitionRecord = (
  id: string,
  expectedVersion: number,
  field: string,
  to: string,
): UC<RecordVersion> =>
  Effect.gen(function* () {
    yield* ensureWritablePatch(id, [field])
    const recordVersions = yield* RecordService
    const inst = yield* recordVersions.get(id)
    yield* ensureWritableVisibility(inst.conceptId, [field])
    return yield* maskEcho(
      recordVersions.transition({ recordVersionId: id, expectedVersion, field, to }),
    )
  })

export const archiveRecordVersion = (id: string, expectedVersion: number): UC<RecordVersion> =>
  ensureUnmanagedRecordVersion(id).pipe(
    Effect.zipRight(
      maskEcho(
        Effect.flatMap(RecordService, (i) => i.archive({ recordVersionId: id, expectedVersion })),
      ),
    ),
  )

export const restoreRecordVersion = (id: string, expectedVersion: number): UC<RecordVersion> =>
  ensureUnmanagedRecordVersion(id).pipe(
    Effect.zipRight(
      maskEcho(
        Effect.flatMap(RecordService, (i) => i.restore({ recordVersionId: id, expectedVersion })),
      ),
    ),
  )

export const deleteRecordVersion = (id: string): UC<RecordVersion> =>
  ensureUnmanagedRecordVersion(id).pipe(
    Effect.zipRight(
      maskEcho(Effect.flatMap(RecordService, (i) => i.purge({ recordVersionId: id }))),
    ),
  )

export const linkRelation = (
  fieldId: string,
  fromId: string,
  toId: string,
  properties?: Record<string, unknown>,
): UC<unknown> =>
  Effect.flatMap(RelationService, (r) => r.create({ fieldId, fromId, toId, properties }))

// ── versioning ──────────────────────────────────────────────────────────────

export const listVersions = (recordId: string): UC<ReadonlyArray<RecordVersion>> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const rows = yield* recordVersions.listVersions(recordId)
    const first = rows[0]
    if (!first) return rows
    // Every version of a record shares its concept, so one mask covers them all.
    const hidden = yield* fieldMaskFor(first.conceptId)
    return hidden.size === 0 ? rows : rows.map((r) => maskRecordVersion(r, hidden))
  })

export const newVersion = (recordId: string): UC<RecordVersion> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const out = yield* recordVersions.newVersion({ recordId })
    // A writer's response is projected exactly like a reader's.
    return maskRecordVersion(out, yield* fieldMaskFor(out.conceptId))
  })

export const publishVersion = (id: string, expectedVersion: number): UC<RecordVersion> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const out = yield* recordVersions.publishVersion({ recordVersionId: id, expectedVersion })
    // A writer's response is projected exactly like a reader's.
    return maskRecordVersion(out, yield* fieldMaskFor(out.conceptId))
  })

export const discardDraft = (id: string): UC<RecordVersion> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const out = yield* recordVersions.discardDraft({ recordVersionId: id })
    // A writer's response is projected exactly like a reader's.
    return maskRecordVersion(out, yield* fieldMaskFor(out.conceptId))
  })

export const archiveRecord = (recordId: string): UC<unknown> =>
  Effect.flatMap(RecordService, (i) => i.archiveRecord({ recordId }))

export const restoreRecord = (recordId: string): UC<unknown> =>
  Effect.flatMap(RecordService, (i) => i.restoreRecord({ recordId }))

/** Relation-picker candidates: the head (latest published) of each record of a
 *  concept whose display label matches `query`. */
export const searchRecords = (conceptId: string, query?: string, limit = 20): UC<unknown> =>
  Effect.gen(function* () {
    const q = yield* QueryService
    const fieldsSvc = yield* FieldService
    const conceptsSvc = yield* ConceptService
    const rows = yield* q.findRecords({ conceptId, limit: 200 })
    const [defs, concept] = yield* Effect.all([
      fieldsSvc.listFields(conceptId),
      conceptsSvc.getById(conceptId),
    ])
    const titleId = titleFieldIdOf(concept.titleFieldId, defs)
    // A hidden TITLE field must not leak through the picker's display text.
    const hidden = yield* fieldMaskFor(conceptId)
    const visibleTitleId = titleId && !hidden.has(titleId) ? titleId : null
    const out = rows.map((r) => ({
      recordId: r.recordId,
      recordVersionId: r.id,
      label:
        visibleTitleId && r.state[visibleTitleId] ? String(r.state[visibleTitleId]) : "(untitled)",
      versionSeq: r.versionSeq,
      versionStatus: r.versionStatus,
    }))
    const ql = query?.trim().toLowerCase()
    const filtered = ql ? out.filter((o) => o.label.toLowerCase().includes(ql)) : out
    return filtered.slice(0, limit)
  })

export const createRelation = (input: {
  readonly fieldId: string
  readonly fromId: string
  readonly toRecordId?: string
  readonly toVersionId?: string
  readonly toId?: string
  readonly properties?: Record<string, unknown>
}): UC<unknown> => Effect.flatMap(RelationService, (r) => r.create(input))

export const removeRelation = (relationId: string): UC<unknown> =>
  Effect.flatMap(RelationService, (r) => r.remove({ relationId }))

/** `owner` is a record's record or a Files widget's bucket — see UploadOwner. */
export const uploadAttachment = (
  owner: UploadOwner,
  filename: string,
  mimeType: string | undefined,
  data: Uint8Array,
): UC<Attachment> =>
  // Gate the OWNER when it is a record, mirroring `listFiles` (which already gates the
  // read). Without this a member could upload onto a record they cannot see — and then
  // not be able to list it back. A `bucketId` owner belongs to a Files widget rather
  // than a record, so there is nothing to gate.
  assertSubjectWritable("recordId" in owner ? owner.recordId : null).pipe(
    Effect.zipRight(
      Effect.flatMap(AttachmentService, (a) => a.upload({ owner, filename, mimeType, data })),
    ),
  )

export const listFiles = (filter: {
  readonly recordId?: string
  readonly recordVersionId?: string
  readonly bucketId?: string
  readonly conceptId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}): UC<ReadonlyArray<Attachment>> =>
  Effect.gen(function* () {
    // `recordId` is a lineage; `conceptId` is gated by resolving the concept for read.
    // A widget `bucketId` belongs to no record, so there is nothing to gate.
    if (filter.recordId) yield* assertSubjectReadable(filter.recordId)
    if (filter.conceptId) {
      const concepts = yield* ConceptService
      yield* concepts.getByIdForRead(filter.conceptId)
    }
    const attachments = yield* AttachmentService
    return yield* attachments.list(filter)
  })

export const archiveFile = (id: string): UC<Attachment> =>
  Effect.flatMap(AttachmentService, (a) => a.archive(id))

export const restoreFile = (id: string): UC<Attachment> =>
  Effect.flatMap(AttachmentService, (a) => a.restore(id))

export const deleteFile = (id: string): UC<Attachment> =>
  Effect.flatMap(AttachmentService, (a) => a.purge(id))

/** Purge every file in a widget bucket (widget/dashboard deletion). */
export const purgeBucket = (bucketId: string): UC<ReadonlyArray<Attachment>> =>
  Effect.flatMap(AttachmentService, (a) => a.purgeBucket(bucketId))

/** Re-stamp a bucket's sharing flag onto the files already in it (the widget's
 *  "Also list elsewhere" toggle — new uploads carry it, existing rows need this). */
export const setBucketShared = (bucketId: string, shared: boolean): UC<ReadonlyArray<Attachment>> =>
  Effect.flatMap(AttachmentService, (a) => a.setBucketShared(bucketId, shared))

export const downloadAttachment = (
  attachmentId: string,
): UC<{ attachment: Attachment; data: Uint8Array }> =>
  Effect.flatMap(AttachmentService, (a) => a.download(attachmentId))

// ── annotation layer: notes ────────────────────────────────────────────────────

export const listNotes = (subjectId: string, includeArchived = false): UC<ReadonlyArray<Note>> =>
  assertSubjectReadable(subjectId).pipe(
    Effect.zipRight(
      Effect.flatMap(AnnotationService, (a) => a.listNotes(subjectId, { includeArchived })),
    ),
  )

export const createNote = (input: {
  readonly subjectId: string | null
  readonly body: string
  readonly customFields?: Record<string, unknown>
}): UC<Note> =>
  // Gate the SUBJECT, not just reads of it. Attaching a note to a record you cannot
  // read was possible: the write landed and the read of it was then refused, so the
  // author couldn't even see what they'd planted. A null subject is an org-level note,
  // which belongs to no record and needs no gate.
  assertSubjectWritable(input.subjectId).pipe(
    Effect.zipRight(Effect.flatMap(AnnotationService, (a) => a.createNote(input))),
  )

export const updateNote = (input: {
  readonly id: string
  readonly expectedVersion: number
  readonly body?: string
  readonly customFields?: Record<string, unknown>
}): UC<Note> => Effect.flatMap(AnnotationService, (a) => a.updateNote(input))

export const archiveNote = (id: string, expectedVersion: number): UC<Note> =>
  Effect.flatMap(AnnotationService, (a) => a.archiveNote(id, expectedVersion))

export const restoreNote = (id: string, expectedVersion: number): UC<Note> =>
  Effect.flatMap(AnnotationService, (a) => a.restoreNote(id, expectedVersion))

export const deleteNote = (id: string): UC<Note> =>
  Effect.flatMap(AnnotationService, (a) => a.purgeNote(id))

// ── annotation layer: tasks ────────────────────────────────────────────────────

export const listTasks = (filter: ListTasksFilter = {}): UC<ReadonlyArray<Task>> =>
  Effect.gen(function* () {
    // Only the per-record panel names a lineage; the global "My tasks" view is not
    // subject-scoped, and its rows are already resolved through
    // `resolveTaskSubjects`, which degrades a restricted subject to "(unavailable)".
    if (filter.subjectId) yield* assertSubjectReadable(filter.subjectId)
    const annotations = yield* AnnotationService
    return yield* annotations.listTasks(filter)
  })

/**
 * Batch-resolve task subjects (record ids) for display: each to its head
 * version (latest published, else newest — mirrors the Overview's click-through)
 * plus a label from the concept's first text field (record version state is keyed by
 * field id; the client lacks foreign field defs). A gone/dangling record degrades
 * to a null record version rather than failing the batch.
 */
export const resolveTaskSubjects = (subjectIds: ReadonlyArray<string>): UC<unknown> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const fieldsSvc = yield* FieldService
    const conceptsSvc = yield* ConceptService
    const fieldCache = new Map<string, ReadonlyArray<{ id: string; kind: string }>>()
    const titleCache = new Map<string, string | null>()
    const maskCache = new Map<string, ReadonlySet<string>>()

    const resolveOne = (subjectId: string) =>
      Effect.gen(function* () {
        const record = yield* recordVersions.getRecord(subjectId)
        const head =
          (yield* recordVersions.headOf(subjectId)) ??
          (yield* recordVersions.listVersions(subjectId)).at(-1) ??
          null
        if (!head)
          return {
            subjectId,
            recordVersionId: null,
            label: "(unavailable)",
            conceptId: record.conceptId,
          }
        let fields = fieldCache.get(head.conceptId)
        if (!fields) {
          fields = yield* fieldsSvc.listFields(head.conceptId)
          fieldCache.set(head.conceptId, fields)
        }
        let titleFieldId = titleCache.get(head.conceptId)
        if (titleFieldId === undefined) {
          titleFieldId = (yield* conceptsSvc.getById(head.conceptId)).titleFieldId
          titleCache.set(head.conceptId, titleFieldId)
        }
        const titleId = titleFieldIdOf(titleFieldId, fields)
        // A hidden title field must not leak through a task's subject label. Cached
        // per concept like the two lookups above (subjects repeat across tasks).
        let hidden = maskCache.get(head.conceptId)
        if (hidden === undefined) {
          hidden = yield* fieldMaskFor(head.conceptId)
          maskCache.set(head.conceptId, hidden)
        }
        const visibleTitleId = titleId && !hidden.has(titleId) ? titleId : null
        return {
          subjectId,
          recordVersionId: head.id,
          label:
            visibleTitleId && head.state[visibleTitleId]
              ? String(head.state[visibleTitleId])
              : "(untitled)",
          conceptId: head.conceptId,
        }
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            subjectId,
            recordVersionId: null,
            label: "(unavailable)",
            conceptId: null,
          }),
        ),
      )

    // Dedupe + cap: the page sends each task's subject once; 1000 bounds a
    // pathological caller (listTasks itself defaults to 500 rows).
    return yield* Effect.forEach([...new Set(subjectIds)].slice(0, 1000), resolveOne)
  })

/**
 * Batch-resolve the `@` mentions in one document to live labels and routes.
 *
 * The read gate IS the resolution: each kind is looked up through the engine
 * method that already carries its permission check, and a failure degrades that
 * one ref rather than the batch. Nothing here decides "may they?" separately —
 * that would be a second, driftable copy of the rule.
 *
 * `href: null` is the enforcement signal (see `MentionRef`): unreachable-for-you
 * and has-no-page are deliberately the same answer. `label: null` means "keep the
 * document's own label", so a restricted target is passed over silently instead of
 * being replaced by a sentinel that announces it.
 *
 * `person` is NOT resolved here — membership lives in the auth tier, which the
 * engine has no access to; `rpc.ts` overlays it. `page` is not resolved here
 * either: `GLOBAL_NAV` is a static client table with no permission dimension.
 */
export const resolveMentions = (
  refs: ReadonlyArray<{ readonly kind: string; readonly targetId: string }>,
): UC<unknown> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const fieldsSvc = yield* FieldService
    const conceptsSvc = yield* ConceptService
    const dashboardsSvc = yield* DashboardService
    const attachmentsSvc = yield* AttachmentService

    const fieldCache = new Map<string, ReadonlyArray<{ id: string; kind: string }>>()
    const titleCache = new Map<string, string | null>()
    const maskCache = new Map<string, ReadonlySet<string>>()
    const conceptCache = new Map<string, { name: string; icon: string | null }>()

    interface Resolved {
      readonly kind: string
      readonly targetId: string
      readonly href: string | null
      readonly label: string | null
      readonly subtitle: string | null
      readonly icon: string | null
    }

    const unresolved = (kind: string, targetId: string): Resolved => ({
      kind,
      targetId,
      href: null,
      label: null,
      subtitle: null,
      icon: null,
    })

    /** A record mention: lineage → head version → title, with the concept's own
     *  field mask applied to the LABEL, not just to state. */
    const resolveRecord = (targetId: string): UC<Resolved> =>
      Effect.gen(function* () {
        yield* recordVersions.getRecord(targetId) // the gate
        const head =
          (yield* recordVersions.headOf(targetId)) ??
          (yield* recordVersions.listVersions(targetId)).at(-1) ??
          null
        if (!head) return unresolved("record", targetId)

        let fields = fieldCache.get(head.conceptId)
        if (!fields) {
          fields = yield* fieldsSvc.listFields(head.conceptId)
          fieldCache.set(head.conceptId, fields)
        }
        let concept = conceptCache.get(head.conceptId)
        if (!concept) {
          // `getById`, not `getByIdForRead`: `getRecord` already gated the concept,
          // so the guarded variant would only repeat the query.
          const c = yield* conceptsSvc.getById(head.conceptId)
          concept = { name: c.name, icon: c.icon }
          conceptCache.set(head.conceptId, concept)
          if (!titleCache.has(head.conceptId)) titleCache.set(head.conceptId, c.titleFieldId)
        }
        const titleId = titleFieldIdOf(titleCache.get(head.conceptId) ?? null, fields)
        let hidden = maskCache.get(head.conceptId)
        if (hidden === undefined) {
          hidden = yield* fieldMaskFor(head.conceptId)
          maskCache.set(head.conceptId, hidden)
        }
        const visibleTitleId = titleId && !hidden.has(titleId) ? titleId : null
        return {
          kind: "record",
          targetId,
          href: `/recordVersions/${head.id}`,
          label:
            visibleTitleId && head.state[visibleTitleId]
              ? String(head.state[visibleTitleId])
              : "(untitled)",
          subtitle: concept.name,
          icon: concept.icon,
        }
      })

    /** A concept mention routes to `/c/<slug>` — which is the single RECORD of a
     *  single-record concept, not a concept page. Any other concept has no
     *  member-reachable page at all (the schema editor is admin-gated), so it
     *  resolves label-only and renders inert. */
    const resolveConcept = (targetId: string): UC<Resolved> =>
      Effect.gen(function* () {
        const c = yield* conceptsSvc.getByIdForRead(targetId) // the gate
        const reachable = c.singleRecord && c.archivedAt === null
        return {
          kind: "concept",
          targetId,
          href: reachable ? `/c/${c.slug}` : null,
          label: c.name,
          subtitle: null,
          icon: c.icon,
        }
      })

    /** Dashboards are already actor-scoped by the service (`owner_id IS NULL OR
     *  owner_id = actor`), so a personal dashboard simply isn't in the list for
     *  anyone else. Record-kind dashboards are per-concept TEMPLATES, not pages. */
    const resolveDashboard = (targetId: string): UC<Resolved> =>
      Effect.gen(function* () {
        const all = yield* dashboardsSvc.listAll()
        const d = all.find((x) => x.id === targetId)
        if (d?.kind !== "page") return unresolved("dashboard", targetId)
        return {
          kind: "dashboard",
          targetId,
          href: `/dashboards/${d.id}`,
          label: d.name,
          subtitle: d.ownerId ? "personal" : null,
          icon: d.icon,
        }
      })

    /** A file has no SPA route — its target is the inline-preview endpoint. It
     *  carries no concept column, so the read gate goes through its host lineage,
     *  exactly as `listFiles` does. A bucket file has no lineage to check. */
    const resolveFile = (targetId: string): UC<Resolved> =>
      Effect.gen(function* () {
        const a = yield* attachmentsSvc.get(targetId)
        if (a.recordId) yield* assertSubjectReadable(a.recordId)
        return {
          kind: "file",
          targetId,
          href: `/api/attachments/${a.id}/download?inline=1`,
          label: a.filename,
          subtitle: a.mimeType,
          icon: null,
        }
      })

    const resolveOne = (ref: {
      readonly kind: string
      readonly targetId: string
    }): UC<Resolved> => {
      const fallback: UC<Resolved> = Effect.succeed(unresolved(ref.kind, ref.targetId))
      const run =
        ref.kind === "record"
          ? resolveRecord(ref.targetId)
          : ref.kind === "concept"
            ? resolveConcept(ref.targetId)
            : ref.kind === "dashboard"
              ? resolveDashboard(ref.targetId)
              : ref.kind === "file"
                ? resolveFile(ref.targetId)
                : // `person` is overlaid by the handler; `page` is client-side; an
                  // unknown kind (a newer build's) passes through untouched.
                  fallback
      return run.pipe(Effect.catchAll(() => fallback))
    }

    // Deduped by (kind, targetId) — so the response is NOT positionally aligned
    // with the request, and callers join on those two. Capped to match the
    // extractor's per-document ceiling; this is a per-document render, not a page
    // of rows.
    const deduped = [
      ...new Map(refs.map((r) => [`${r.kind}\u0000${r.targetId}`, r])).values(),
    ].slice(0, MAX_MENTIONS_PER_DOC)
    return yield* Effect.forEach(deduped, resolveOne)
  })

/**
 * Everything that mentions one record, resolved for display.
 *
 * DROP, don't degrade. An unreadable source is omitted entirely rather than shown
 * as "(unavailable)" — the opposite of `resolveMentions`, and the asymmetry is
 * deliberate. An inline mention's label is already in prose the reader can see, so
 * there is nothing left to protect; a backlink would be NEW information, and a
 * placeholder row would confirm that a document they may not open references this
 * record. This follows the same rule the relation resolver uses for unreadable
 * targets. Do not reconcile the two.
 */
export const listBacklinks = (recordId: string): UC<unknown> =>
  Effect.gen(function* () {
    // Standing on a record you may not read must not reveal who points at it.
    yield* assertSubjectReadable(recordId)
    const mentionsSvc = yield* MentionService
    const recordVersions = yield* RecordService
    const fieldsSvc = yield* FieldService
    const conceptsSvc = yield* ConceptService
    const annotations = yield* AnnotationService

    const rows = yield* mentionsSvc.listBacklinks(recordId)

    const fieldCache = new Map<string, ReadonlyArray<{ id: string; kind: string; name: string }>>()
    const titleCache = new Map<string, string | null>()
    const maskCache = new Map<string, ReadonlySet<string>>()
    const nameCache = new Map<string, string>()

    const resolveRow = (row: (typeof rows)[number]) =>
      Effect.gen(function* () {
        if (row.source === "task") {
          const task = yield* annotations.getTask(row.fromAnnotationId!)
          // `getTask` is org-scoped only; a task hanging off a record the caller
          // may not read must not surface through this list.
          if (task.subjectId) yield* assertSubjectReadable(task.subjectId)
          return {
            source: "task" as const,
            // Tasks open in a modal and have no addressable URL yet.
            href: null,
            label: task.title,
            fieldName: null,
            conceptName: null,
          }
        }

        const conceptId = row.fromConceptId!
        // The gate: resolving the source lineage carries the concept check.
        yield* recordVersions.getRecord(row.fromRecordId!)
        const head = yield* recordVersions.get(row.fromVersionId!)

        let fields = fieldCache.get(conceptId)
        if (!fields) {
          fields = yield* fieldsSvc.listFields(conceptId)
          fieldCache.set(conceptId, fields)
        }
        let conceptName = nameCache.get(conceptId)
        if (conceptName === undefined) {
          const c = yield* conceptsSvc.getById(conceptId)
          conceptName = c.name
          nameCache.set(conceptId, c.name)
          if (!titleCache.has(conceptId)) titleCache.set(conceptId, c.titleFieldId)
        }
        let hidden = maskCache.get(conceptId)
        if (hidden === undefined) {
          hidden = yield* fieldMaskFor(conceptId)
          maskCache.set(conceptId, hidden)
        }

        const titleId = titleFieldIdOf(titleCache.get(conceptId) ?? null, fields)
        const visibleTitleId = titleId && !hidden.has(titleId) ? titleId : null
        // The field the mention sits in — named only when the reader may see it,
        // since a hidden field's NAME is as much a leak as its value.
        const field = row.fromFieldId ? fields.find((f) => f.id === row.fromFieldId) : undefined
        const fieldName = field && !hidden.has(field.id) ? field.name : null

        return {
          source: "record" as const,
          href: `/recordVersions/${head.id}`,
          label:
            visibleTitleId && head.state[visibleTitleId]
              ? String(head.state[visibleTitleId])
              : "(untitled)",
          fieldName,
          conceptName,
        }
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    const resolved = yield* Effect.forEach(rows, resolveRow)
    return resolved.filter((r) => r !== null)
  })

/**
 * Records-only typeahead for the `@` menu, across every concept the caller may read.
 *
 * `searchRecords` is per-concept, and an `@` menu cannot fan that out — it would
 * be one round-trip per concept per keystroke. So this walks head rows org-wide.
 *
 * THE COST, stated plainly: this is `searchRecords`' algorithm widened from one
 * concept to all of them — head rows are fetched, then labels are matched in JS,
 * because the title field id differs per concept and so the predicate would need a
 * different column expression per concept. `SCAN_CAP` bounds the work per
 * keystroke; on a very large org the right record can fall outside it. The fix
 * when that day comes is to push the match into SQL as per-concept
 * `OR (concept_id = X AND state->>'<fid>' ILIKE $q)` clauses — still index-free,
 * but filtering in the database.
 */
const SCAN_CAP = 2000

export const searchMentionableRecords = (query: string, limit = 20): UC<unknown> =>
  Effect.gen(function* () {
    const q = query.trim().toLowerCase()
    // A bare `@` must not trigger the scan; the menu asks again once there's a term.
    if (q === "") return []

    const conceptsSvc = yield* ConceptService
    const fieldsSvc = yield* FieldService
    const queries = yield* QueryService
    // `list()` FILTERS rather than failing, so this is already the caller's
    // visible set — no separate permission pass to keep in step.
    const concepts = yield* conceptsSvc.list({})

    const out: Array<{
      kind: string
      targetId: string
      href: string
      label: string
      subtitle: string
      icon: string | null
    }> = []
    let scanned = 0

    for (const concept of concepts) {
      if (out.length >= limit || scanned >= SCAN_CAP) break
      const defs = yield* fieldsSvc.listFields(concept.id)
      const titleId = titleFieldIdOf(concept.titleFieldId, defs)
      if (!titleId) continue
      // A hidden TITLE field must not leak through the picker's display text —
      // the concept is simply not searchable for this caller.
      const hidden = yield* fieldMaskFor(concept.id)
      if (hidden.has(titleId)) continue

      // `findRecords` is the head-only read (one row per lineage, newest
      // published) and carries the concept gate itself.
      const rows = yield* queries.findRecords({
        conceptId: concept.id,
        limit: SCAN_CAP - scanned,
      })
      scanned += rows.length
      for (const r of rows) {
        if (out.length >= limit) break
        const label = r.state[titleId]
        if (typeof label !== "string" || !label.toLowerCase().includes(q)) continue
        out.push({
          kind: "record",
          targetId: r.recordId,
          href: `/recordVersions/${r.id}`,
          label,
          subtitle: concept.name,
          icon: concept.icon,
        })
      }
    }
    return out
  })

export const createTask = (input: {
  readonly subjectId: string | null
  readonly title: string
  readonly description?: RichTextValue | null
  readonly statusId?: string | null
  readonly priorityId?: string | null
  readonly labelIds?: ReadonlyArray<string>
  readonly assignee?: string | null
  readonly dueAt?: string | null
  readonly customFields?: Record<string, unknown>
}): UC<Task> =>
  // Same gate as `createNote` — see there.
  assertSubjectWritable(input.subjectId).pipe(
    Effect.zipRight(Effect.flatMap(AnnotationService, (a) => a.createTask(input))),
  )

export const updateTask = (input: {
  readonly id: string
  readonly expectedVersion: number
  readonly title?: string
  readonly description?: RichTextValue | null
  readonly priorityId?: string | null
  readonly labelIds?: ReadonlyArray<string>
  readonly dueAt?: string | null
  readonly customFields?: Record<string, unknown>
}): UC<Task> => Effect.flatMap(AnnotationService, (a) => a.updateTask(input))

export const setTaskStatus = (id: string, expectedVersion: number, statusId: string): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.setTaskStatus({ id, expectedVersion, statusId }))

export const assignTask = (
  id: string,
  expectedVersion: number,
  assignee: string | null,
): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.assignTask({ id, expectedVersion, assignee }))

export const snoozeTask = (id: string, expectedVersion: number, until: string | null): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.snoozeTask({ id, expectedVersion, until }))

export const setTaskBlocked = (
  id: string,
  expectedVersion: number,
  blocked: null | { readonly reason?: string | null; readonly taskId?: string | null },
): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.setTaskBlocked({ id, expectedVersion, blocked }))

export const archiveTask = (id: string, expectedVersion: number): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.archiveTask(id, expectedVersion))

export const restoreTask = (id: string, expectedVersion: number): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.restoreTask(id, expectedVersion))

export const deleteTask = (id: string): UC<Task> =>
  Effect.flatMap(AnnotationService, (a) => a.purgeTask(id))

/** Per-record activity (union of the lineage's events + its annotations' events).
 *  Field-edit events also get `previous` — the values the patch overwrote,
 *  reconstructed by folding the record version's own stream oldest-first. */
export const getActivity = (subjectId: string, limit = 100): UC<ReadonlyArray<FeedItem>> =>
  Effect.gen(function* () {
    const annotations = yield* AnnotationService
    const store = yield* EventStore
    yield* assertSubjectReadable(subjectId)
    const recordVersions = yield* RecordService
    const events = yield* annotations.readActivityForSubject(subjectId, { limit })
    // An amendment (`VersionAmended`) is a field edit too, so it gets the same
    // before/after treatment — and its patch must join the running fold, or a later
    // event's `previous` would report a value the amendment had already replaced.
    const edited = events.filter(
      (ev) =>
        ev.subjectKind === "recordVersion" &&
        (ev.payload._tag === "RecordVersionUpdated" || ev.payload._tag === "VersionAmended"),
    )
    const previousByEvent = new Map<number, Record<string, unknown>>()
    for (const recordVersionId of new Set(edited.map((ev) => ev.subjectId))) {
      const state: Record<string, unknown> = {}
      for (const ev of yield* store.readStream(recordVersionId)) {
        const p = ev.payload
        if (p._tag === "RecordVersionCreated") Object.assign(state, p.fields)
        else if (p._tag === "RecordVersionUpdated" || p._tag === "VersionAmended") {
          previousByEvent.set(
            ev.id,
            Object.fromEntries(Object.keys(p.patch).map((k) => [k, state[k] ?? null])),
          )
          Object.assign(state, p.patch)
        }
      }
    }
    // Field-level masking, applied ONLY here at the final map — never inside the
    // fold above. The running `state` there must stay complete, or a later event's
    // `previous` would report a value an earlier masked patch had already replaced.
    //
    // The log itself is never redacted: it is the source of truth for versioning,
    // amend and automations, so this is a read-time filter and nothing else.
    const lineage = yield* recordVersions
      .getRecord(subjectId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    const hidden = lineage ? yield* fieldMaskFor(lineage.conceptId) : new Set<string>()

    return events.map((ev) => ({
      id: ev.id,
      occurredAt: ev.occurredAt,
      actor: ev.actor,
      eventType: ev.eventType,
      subjectKind: ev.subjectKind,
      subjectId: ev.subjectId,
      payload: maskPayload(ev.payload, hidden),
      previous: maskRecord(previousByEvent.get(ev.id), hidden),
    }))
  })

// ── annotation layer: task statuses (admin) ─────────────────────────────────────

export const listTaskStatuses = (includeArchived = false): UC<ReadonlyArray<TaskStatus>> =>
  Effect.flatMap(TaskStatusService, (s) => s.list({ includeArchived }))

export const createTaskStatus = (input: {
  readonly name: string
  readonly category: TaskStatusCategory
  readonly color?: string | null
  readonly isDefault?: boolean
}): UC<TaskStatus> => Effect.flatMap(TaskStatusService, (s) => s.create(input))

export const updateTaskStatus = (input: {
  readonly id: string
  readonly name?: string
  readonly color?: string | null
  readonly category?: TaskStatusCategory
  readonly isDefault?: boolean
}): UC<TaskStatus> => Effect.flatMap(TaskStatusService, (s) => s.update(input))

export const archiveTaskStatus = (id: string): UC<TaskStatus> =>
  Effect.flatMap(TaskStatusService, (s) => s.archive(id))

export const restoreTaskStatus = (id: string): UC<TaskStatus> =>
  Effect.flatMap(TaskStatusService, (s) => s.restore(id))

export const reorderTaskStatuses = (
  orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
): UC<ReadonlyArray<TaskStatus>> => Effect.flatMap(TaskStatusService, (s) => s.reorder(orders))

// ── annotation layer: task priorities (admin) ────────────────────────────────────

export const listTaskPriorities = (includeArchived = false): UC<ReadonlyArray<TaskPriority>> =>
  Effect.flatMap(TaskPriorityService, (s) => s.list({ includeArchived }))

export const createTaskPriority = (input: {
  readonly name: string
  readonly color?: string | null
}): UC<TaskPriority> => Effect.flatMap(TaskPriorityService, (s) => s.create(input))

export const updateTaskPriority = (input: {
  readonly id: string
  readonly name?: string
  readonly color?: string | null
}): UC<TaskPriority> => Effect.flatMap(TaskPriorityService, (s) => s.update(input))

export const archiveTaskPriority = (id: string): UC<TaskPriority> =>
  Effect.flatMap(TaskPriorityService, (s) => s.archive(id))

export const restoreTaskPriority = (id: string): UC<TaskPriority> =>
  Effect.flatMap(TaskPriorityService, (s) => s.restore(id))

export const reorderTaskPriorities = (
  orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
): UC<ReadonlyArray<TaskPriority>> => Effect.flatMap(TaskPriorityService, (s) => s.reorder(orders))

// ── annotation layer: custom-field definitions (admin) ──────────────────────────

export const listAnnotationFields = (
  annotationType: AnnotationType,
  includeArchived = false,
): UC<ReadonlyArray<AnnotationField>> =>
  Effect.flatMap(AnnotationFieldService, (s) => s.list(annotationType, { includeArchived }))

export const addAnnotationField = (input: {
  readonly annotationType: AnnotationType
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  readonly icon?: string | null
}): UC<AnnotationField> => Effect.flatMap(AnnotationFieldService, (s) => s.add(input))

export const updateAnnotationField = (input: {
  readonly id: string
  readonly name?: string
  readonly config?: FieldConfig
  readonly icon?: string | null
}): UC<AnnotationField> => Effect.flatMap(AnnotationFieldService, (s) => s.update(input))

export const archiveAnnotationField = (id: string): UC<AnnotationField> =>
  Effect.flatMap(AnnotationFieldService, (s) => s.archive(id))

export const restoreAnnotationField = (id: string): UC<AnnotationField> =>
  Effect.flatMap(AnnotationFieldService, (s) => s.restore(id))

export const reorderAnnotationFields = (
  annotationType: AnnotationType,
  orders: ReadonlyArray<{ readonly id: string; readonly position: number }>,
): UC<ReadonlyArray<AnnotationField>> =>
  Effect.flatMap(AnnotationFieldService, (s) => s.reorder(annotationType, orders))

// ── automations (admin) ────────────────────────────────────────────────────────
// "when X, if Y, then Z". The service owns validation + the event trail; the
// RUNNER (server/automations.ts) owns matching and execution. `testAutomation` is
// the dry run — it evaluates and reports, writing nothing.

export const listAutomations = (includeArchived = false): UC<ReadonlyArray<Automation>> =>
  Effect.flatMap(AutomationService, (s) => s.list({ includeArchived }))

export const getAutomation = (id: string): UC<Automation> =>
  Effect.flatMap(AutomationService, (s) => s.getById(id))

export const createAutomation = (input: {
  readonly name: string
  readonly trigger: AutomationTrigger
  readonly conditions?: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly actions: ReadonlyArray<AutomationAction>
  readonly enabled?: boolean
}): UC<Automation> =>
  Effect.gen(function* () {
    const automations = yield* AutomationService
    const roles = yield* AccessRoleService
    const created = yield* automations.create(input)
    // An automation is a governed ACTOR (see `actorScope`), so a fresh one has to be
    // GIVEN access — without a role it resolves an empty policy and every run fails.
    //
    // Which roles is the org's decision, not a hardcoded key: every `automation`-kind
    // role flagged auto-assign. Out of the box that is the managed "Full access" one,
    // matching what automations had before this model; an org that wants new
    // automations to start narrow moves the flag to a role of its own.
    yield* roles.ensureBuiltins
    const actorId = `${AUTOMATION_ACTOR_PREFIX}${created.id}`
    for (const role of yield* roles.autoAssignFor("automation")) {
      yield* roles.assign(role.id, actorId)
    }
    return created
  })

export const updateAutomation = (input: {
  readonly id: string
  readonly name?: string
  readonly trigger?: AutomationTrigger
  readonly conditions?: ReadonlyArray<SidebarCondition>
  readonly match?: ConditionMatch
  readonly actions?: ReadonlyArray<AutomationAction>
  readonly enabled?: boolean
}): UC<Automation> => Effect.flatMap(AutomationService, (s) => s.update(input))

export const archiveAutomation = (id: string): UC<Automation> =>
  Effect.flatMap(AutomationService, (s) => s.archive(id))

export const restoreAutomation = (id: string): UC<Automation> =>
  Effect.flatMap(AutomationService, (s) => s.restore(id))

export const deleteAutomation = (id: string): UC<{ readonly id: string }> =>
  Effect.gen(function* () {
    const automations = yield* AutomationService
    const roles = yield* AccessRoleService
    yield* automations.remove(id)
    // Drop EVERY role the actor holds, not just the auto-assigned one — an automation
    // that was narrowed to a custom role would otherwise leave that assignment behind.
    // The actor can never authenticate so a leftover row grants nothing, but they
    // accumulate forever and would show up in "who holds this role?" as a lie.
    const actorId = `${AUTOMATION_ACTOR_PREFIX}${id}`
    for (const role of yield* roles.rolesOf(actorId)) {
      yield* roles.unassign(role.id, actorId)
    }
    return { id }
  })

export const listAutomationRuns = (
  automationId: string,
  limit?: number,
): UC<ReadonlyArray<AutomationRun>> =>
  Effect.flatMap(AutomationService, (s) => s.listRuns(automationId, { limit }))

/** Dry run: what WOULD happen, having written nothing. */
export const testAutomation = (id: string, limit?: number) =>
  Effect.gen(function* () {
    const automations = yield* AutomationService
    const automation = yield* automations.getById(id)
    return yield* dryRun({ automation, limit })
  })

// ── sharing ─────────────────────────────────────────────────────────────────

/** Current grants on one resource — what the Share dialog lists. */
export const listGrants = (resourceType: AccessResourceType, resourceId: string): UC<unknown> =>
  Effect.flatMap(GrantService, (g) => g.listFor(resourceType, resourceId))

/**
 * Grant access to a person or a role.
 *
 * NOBODY CAN SHARE MORE THAN THEY HOLD. Without this check, `share` on a resource
 * would be a privilege-escalation primitive: a member could grant themselves (or a
 * confederate) `delete` on a record they can only view. So every requested action is
 * re-checked against the sharer's own policy before the rule is written.
 *
 * For a record the resource id is the ITEM lineage, so the grant survives a new
 * version being published.
 */
export const share = (input: {
  readonly resourceType: AccessResourceType
  readonly resourceId: string
  readonly userId?: string
  readonly roleId?: string
  readonly actions: ReadonlyArray<AccessAction>
}): UC<unknown> =>
  Effect.gen(function* () {
    const scope = yield* OrgContext
    const grants = yield* GrantService
    const resource = { type: input.resourceType, id: input.resourceId }
    // `unconditionalOnly`: a CONDITIONAL grant of an action does not entitle the
    // sharer to hand that action out unconditionally.
    const held = (action: AccessAction) =>
      scope.policy === undefined ||
      scope.policy.unrestricted ||
      decide(scope.policy, action, resource, canReadRestricted(scope), {
        unconditionalOnly: true,
      })
    const overreach = input.actions.filter((a) => !held(a))
    if (overreach.length > 0)
      return yield* Effect.fail(
        new FieldValidationError({
          message: `you cannot share access you do not hold: ${overreach.join(", ")}`,
          field: "actions",
        }),
      )
    // Exactly one subject; the DB CHECK enforces it too, but a typed error beats a
    // constraint violation surfacing as an opaque 500.
    if ((input.userId === undefined) === (input.roleId === undefined))
      return yield* Effect.fail(
        new FieldValidationError({
          message: "a share names exactly one of userId or roleId",
          field: "userId",
        }),
      )
    return yield* grants.create({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      userId: input.userId,
      roleId: input.roleId,
      actions: input.actions,
    })
  })

/** One grant by id, or null. The revoke gate needs it to learn WHICH resource to
 *  check `share` against — only the row knows that. */
export const getGrant = (grantId: string): UC<unknown> =>
  Effect.flatMap(GrantService, (g) => g.getById(grantId))

/** Revoke a grant. Any holder of `share` may revoke, not only whoever granted it. */
export const revoke = (grantId: string): UC<unknown> =>
  Effect.gen(function* () {
    const grants = yield* GrantService
    yield* grants.revoke(grantId)
    return { id: grantId }
  })

// ── roles ───────────────────────────────────────────────────────────────────

export const listRoles = (): UC<unknown> =>
  Effect.flatMap(AccessRoleService, (r) => r.ensureBuiltins.pipe(Effect.zipRight(r.list())))

export const rolesOfUser = (userId: string): UC<unknown> =>
  Effect.flatMap(AccessRoleService, (r) => r.rolesOf(userId))

export const listRules = (roleId: string): UC<unknown> =>
  Effect.flatMap(AccessRoleService, (r) => r.rulesOf(roleId))

/** Who holds a role — what the turn-off dialog counts before it takes the rules away. */
export const roleHolders = (roleId: string): UC<unknown> =>
  Effect.flatMap(AccessRoleService, (r) =>
    r.actorsOf(roleId).pipe(Effect.map((actors) => ({ actors }))),
  )

/** Move every holder of one role onto another, before turning the first one off. */
export const reassignRoleHolders = (input: {
  readonly fromRoleId: string
  readonly toRoleId: string
}): UC<unknown> =>
  Effect.flatMap(AccessRoleService, (r) =>
    r.reassignHolders(input.fromRoleId, input.toRoleId).pipe(Effect.map((moved) => ({ moved }))),
  )

export const createRole = (input: {
  readonly name: string
  readonly description?: string
  readonly kind?: "user" | "automation"
  readonly startFrom?: string
}): UC<unknown> => Effect.flatMap(AccessRoleService, (r) => r.create(input))

export const updateRole = (input: {
  readonly id: string
  readonly name?: string
  readonly description?: string | null
  readonly autoAssign?: boolean
  readonly active?: boolean
}): UC<unknown> =>
  Effect.gen(function* () {
    const roles = yield* AccessRoleService
    const updated = yield* roles.update(input)
    if (!updated)
      return yield* Effect.fail(
        new FieldValidationError({ message: "role not found", field: "id" }),
      )
    return updated
  })

export const deleteRole = (id: string): UC<unknown> =>
  Effect.gen(function* () {
    const roles = yield* AccessRoleService
    // THE FLOOR: refuse if this role is what keeps the org administrable. Checked
    // BEFORE the delete, and by simulating the result rather than trusting the
    // caller's own role — see `assertFloorHolds`.
    yield* assertFloorHolds(roles, { removingRoleId: id })
    const outcome = yield* roles.remove(id)
    if (outcome === "not-found")
      return yield* Effect.fail(
        new FieldValidationError({ message: "role not found", field: "id" }),
      )
    if (outcome === "builtin")
      return yield* Effect.fail(
        new FieldValidationError({
          message: "a managed role can't be deleted — turn it off instead",
          field: "id",
        }),
      )
    return { id }
  })

export const assignRole = (roleId: string, userId: string): UC<unknown> =>
  Effect.flatMap(AccessRoleService, (r) => r.assign(roleId, userId)).pipe(
    Effect.map(() => ({ ok: true })),
  )

export const unassignRole = (roleId: string, userId: string): UC<unknown> =>
  Effect.gen(function* () {
    const roles = yield* AccessRoleService
    yield* assertFloorHolds(roles, { unassigning: { roleId, userId } })
    yield* roles.unassign(roleId, userId)
    return { ok: true }
  })

export const addRule = (input: {
  readonly roleId: string
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<AccessAction>
  readonly resourceType: AccessResourceType
  readonly resourceId?: string | null
  readonly conceptId?: string | null
  readonly condition?: AccessCondition | null
}): UC<unknown> => Effect.flatMap(AccessRoleService, (r) => r.addRule(input))

export const updateRule = (input: {
  readonly ruleId: string
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<AccessAction>
  readonly resourceType: AccessResourceType
  readonly resourceId?: string | null
  readonly conceptId?: string | null
  readonly condition?: AccessCondition | null
}): UC<unknown> =>
  Effect.gen(function* () {
    const roles = yield* AccessRoleService
    const before = yield* roles.getRule(input.ruleId)
    if (!before)
      return yield* Effect.fail(
        new FieldValidationError({ message: "rule not found", field: "ruleId" }),
      )
    // THE FLOOR, on edits too. Stripping `configure` from the last rule that grants it
    // bricks the org exactly as deleting that rule would — and an editor that only
    // guarded deletion would leave the same door open one click to the left.
    const grantsConfigure = (
      actions: ReadonlyArray<string>,
      resourceType: string,
      resourceId: string | null,
    ) =>
      (actions.includes("configure") || actions.includes("*")) &&
      (resourceType === "org" || resourceId === null)
    const wasGranting =
      before.effect === "allow" &&
      grantsConfigure(before.actions, before.resourceType, before.resourceId)
    const stillGranting =
      input.effect === "allow" &&
      grantsConfigure(input.actions, input.resourceType, input.resourceId ?? null)
    if (wasGranting && !stillGranting)
      yield* assertFloorHolds(roles, { removingRuleId: input.ruleId })
    yield* roles.updateRule(input)
    return { id: input.ruleId }
  })

/** THE CREATION TEMPLATE for every role — what a new resource of each type grants. */
export const listAccessDefaults: UC<unknown> = Effect.flatMap(AccessDefaultsService, (d) =>
  d.list(),
)

/** Set one role's template for one type. Empty `actions` clears it. */
export const setAccessDefault = (input: {
  readonly roleId: string
  readonly resourceType: AccessResourceType
  readonly actions: ReadonlyArray<AccessAction>
}): UC<{ readonly ok: boolean }> =>
  Effect.flatMap(AccessDefaultsService, (d) => d.set(input)).pipe(Effect.as({ ok: true }))

export const setScopedRules = (input: {
  readonly roleId: string
  readonly resourceType: AccessResourceType
  readonly scopeBy?: "resource" | "concept"
  readonly entries: ReadonlyArray<{
    readonly resourceId: string
    readonly allow: ReadonlyArray<AccessAction>
    readonly deny: ReadonlyArray<AccessAction>
  }>
}): UC<unknown> =>
  Effect.gen(function* () {
    // `org` has no per-record grid and is what the irreducible floor protects — a bulk
    // replace there could empty the configure set in one call.
    if (input.resourceType === "org")
      return yield* Effect.fail(
        new FieldValidationError({
          message: "org-level access can't be set from the grid",
          field: "resourceType",
        }),
      )
    const roles = yield* AccessRoleService
    yield* roles.setScopedRules(input)
    return { ok: true }
  })

export const removeRule = (ruleId: string): UC<unknown> =>
  Effect.gen(function* () {
    const roles = yield* AccessRoleService
    yield* assertFloorHolds(roles, { removingRuleId: ruleId })
    yield* roles.removeRule(ruleId)
    return { id: ruleId }
  })

/**
 * ── THE IRREDUCIBLE FLOOR ───────────────────────────────────────────────────
 *
 * Refuse any access change that would leave the org with NOBODY able to configure
 * it. Presets are fully editable by design, but an org nobody can administer is
 * bricked with no in-app recovery — the same reason member demotion already refuses
 * to remove the last owner.
 *
 * Implemented by asking "who holds configure?" and refusing when the change would
 * empty that set. Deliberately NOT "is the caller an owner": once presets are
 * editable, membership role no longer implies configure.
 *
 * Conservative by construction: it only blocks when the set would become EMPTY, so
 * it never gets in the way of ordinary edits.
 */
const assertFloorHolds = (
  roles: {
    readonly configureHolders: () => UC<ReadonlyArray<string>>
    readonly rolesOf: (actorId: string) => UC<ReadonlyArray<{ readonly id: string }>>
  },
  change:
    | { readonly removingRoleId: string }
    | { readonly removingRuleId: string }
    | { readonly unassigning: { readonly roleId: string; readonly userId: string } },
): UC<void> =>
  Effect.gen(function* () {
    const holders = yield* roles.configureHolders()
    // More than one holder ⇒ no single change can empty the set.
    if (holders.length > 1) return
    if (holders.length === 0) return // already floorless; don't block recovery attempts
    const last = holders[0]!
    if ("unassigning" in change) {
      if (change.unassigning.userId !== last) return
      // Does the last holder keep configure through some OTHER role?
      const held = yield* roles.rolesOf(last)
      const others = held.filter((r) => r.id !== change.unassigning.roleId)
      if (others.length > 0) return
      return yield* Effect.fail(
        new FieldValidationError({
          message: "this is the only member who can configure the org — assign someone else first",
          field: "userId",
        }),
      )
    }
    // Deleting a role, or removing a rule from one: refuse when it is the last
    // holder's only source of configure.
    const held = yield* roles.rolesOf(last)
    const roleId = "removingRoleId" in change ? change.removingRoleId : null
    if (roleId !== null && held.length === 1 && held[0]!.id === roleId)
      return yield* Effect.fail(
        new FieldValidationError({
          message: "this role is the only thing granting org configuration — it can't be removed",
          field: "id",
        }),
      )
    if ("removingRuleId" in change && held.length === 1)
      return yield* Effect.fail(
        new FieldValidationError({
          message:
            "this rule is the only thing granting org configuration — add another before removing it",
          field: "ruleId",
        }),
      )
  })

/**
 * The effective-access report: what this member can do, and what grants it.
 *
 * The self-serve half matters — a member who cannot see something answers "why?"
 * themselves instead of filing a ticket. The RPC gate allows asking about yourself
 * unconditionally and requires `configure` for anyone else.
 */
export const effectiveAccess = (userId: string): UC<unknown> =>
  Effect.gen(function* () {
    const roles = yield* AccessRoleService
    const policies = yield* PolicyService
    const scope = yield* OrgContext
    const held = yield* roles.rolesOf(userId)
    const policy = yield* policies.resolve(scope.orgId, userId)
    const nameById = new Map(held.map((r) => [r.id, r.name]))
    return {
      userId,
      roles: held,
      rules: policy.rules.map((r) => ({
        id: r.id,
        viaRoleId: r.roleId,
        viaRoleName: r.roleId ? (nameById.get(r.roleId) ?? null) : null,
        effect: r.effect,
        actions: r.actions,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        condition: r.condition,
      })),
    }
  })
