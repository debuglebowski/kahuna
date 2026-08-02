import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import {
  type AnnotationField,
  AnnotationFieldService,
  AnnotationService,
  type AnnotationType,
  type Attachment,
  AttachmentService,
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
  type EditReach,
  type EngineServices,
  EventStore,
  type FieldConfig,
  type FieldKind,
  FieldService,
  FieldValidationError,
  type GraphLayoutPositions,
  GraphLayoutService,
  hiddenFieldIds,
  type Instance,
  InstanceService,
  type InstanceViewLayout,
  type InstanceViewPrefsBody,
  LABELS_KEY,
  type Label,
  LabelService,
  type ListTasksFilter,
  ManagedConceptReadonly,
  MemberService,
  type Note,
  OrgContext,
  projectState,
  QueryService,
  RelationService,
  type RichTextValue,
  type SidebarCondition,
  type SidebarViewBody,
  SidebarViewService,
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
// A connector-managed concept's schema + instances are owned by an integration
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

const ensureUnmanagedInstance = (instanceId: string): UC<void> =>
  Effect.flatMap(InstanceService, (i) => i.get(instanceId)).pipe(
    Effect.flatMap((inst) => ensureUnmanagedConcept(inst.conceptId)),
    // get() is live-only; if the instance is archived/gone, skip the guard and let
    // the real mutation surface the proper InstanceNotFound. Live managed instances
    // (the case that matters) are still covered by create/archive guards.
    Effect.catchAll((e) =>
      (e as { _tag?: string })?._tag === "InstanceNotFound" ? Effect.void : Effect.fail(e),
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

// For an instance VALUE write to specific keys: a managed concept accepts the
// write only when every touched key is a user-added (unmanaged) field — so a
// member can set their own fields on a synced record while the integration's
// fields stay read-only. Unmanaged concepts pass freely (no field is managed); a
// missing/archived instance skips the guard (the real mutation surfaces the
// proper InstanceNotFound). Keyed by field id; non-field keys (e.g. __labels) pass.
const ensureWritablePatch = (instanceId: string, keys: ReadonlyArray<string>): UC<void> =>
  Effect.flatMap(InstanceService, (i) => i.get(instanceId)).pipe(
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
      (e as { _tag?: string })?._tag === "InstanceNotFound" ? Effect.void : Effect.fail(e),
    ),
  )

// ── reads ───────────────────────────────────────────────────────────────────

/** The field id that holds an instance's display label ("title"): the concept's
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
 * Every read below that returns instance state runs through this. It lives HERE
 * and not deeper in the engine on purpose — `domain/visibility.ts` documents the
 * two placements that silently corrupt data (a filter in `toInstance` deletes
 * hidden values on the next edit; a filter in `FieldService.listFields` disables
 * required-field enforcement).
 *
 * One `listFields` call covers a whole page of rows, because every row in a
 * `listInstances` result shares one concept.
 */
const fieldMaskFor = (conceptId: string): UC<ReadonlySet<string>> =>
  Effect.gen(function* () {
    const { role } = yield* OrgContext
    if (canReadRestricted(role)) return new Set<string>()
    const fields = yield* FieldService
    // includeArchived: an archived field's values linger in `state`, so a hidden
    // one must stay masked after it is archived.
    const defs = yield* fields.listFields(conceptId, { includeArchived: true })
    return hiddenFieldIds(defs, role)
  })

/** Run a write and project its echoed instance, so a writer's response carries no
 *  more than a reader's would. */
const maskEcho = (eff: UC<Instance>): UC<Instance> =>
  Effect.gen(function* () {
    const out = yield* eff
    return maskInstance(out, yield* fieldMaskFor(out.conceptId))
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
 * field-id-keyed data — `InstanceCreated.fields`, `InstanceUpdated.patch` and
 * `VersionAmended.patch` — and `ComputedBandChanged` names a single field, whose
 * very mention would disclose a hidden one.
 */
const maskPayload = (payload: unknown, hidden: ReadonlySet<string>): unknown => {
  if (hidden.size === 0 || !payload || typeof payload !== "object") return payload
  const p = payload as { _tag?: string; fields?: unknown; patch?: unknown; field?: unknown }
  if (p._tag === "InstanceCreated" && p.fields && typeof p.fields === "object")
    return { ...p, fields: projectState(p.fields as Record<string, unknown>, hidden) }
  if (
    (p._tag === "InstanceUpdated" || p._tag === "VersionAmended") &&
    p.patch &&
    typeof p.patch === "object"
  )
    return { ...p, patch: projectState(p.patch as Record<string, unknown>, hidden) }
  if (p._tag === "ComputedBandChanged" && typeof p.field === "string" && hidden.has(p.field))
    return { _tag: p._tag }
  return payload
}

/** Apply a mask to one instance (no-op when nothing is hidden). */
const maskInstance = <T extends { readonly state: Record<string, unknown> }>(
  inst: T,
  hidden: ReadonlySet<string>,
): T => (hidden.size === 0 ? inst : { ...inst, state: projectState(inst.state, hidden) })

export const listInstances = (
  conceptId: string,
  opts: ListOpts = {},
): UC<ReadonlyArray<Instance>> =>
  Effect.gen(function* () {
    const query = yield* QueryService
    const computed = yield* ComputedFields
    const rows = yield* query.findInstances({
      conceptId,
      where: opts.where,
      orderBy: opts.orderBy,
      relatedToTo: opts.relatedToTo,
      limit: opts.limit,
      includeArchived: opts.includeArchived,
    })
    const decorated = opts.decorate
      ? yield* Effect.forEach(rows, (r) => computed.decorate(r))
      : rows
    const hidden = yield* fieldMaskFor(conceptId)
    return hidden.size === 0 ? decorated : decorated.map((r) => maskInstance(r, hidden))
  })

export const getInstance = (id: string, decorate = false): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const computed = yield* ComputedFields
    const inst = yield* instances.get(id)
    const out = decorate ? yield* computed.decorate(inst) : inst
    return maskInstance(out, yield* fieldMaskFor(inst.conceptId))
  })

/**
 * One instance plus its detail context: concept, field defs, and every related
 * instance (both directions) with its concept name resolved — for the detail
 * view's "connected things". Dangling relations (target deleted) are skipped.
 */
export const getInstanceDetail = (id: string): UC<unknown> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const relations = yield* RelationService
    const conceptsSvc = yield* ConceptService
    const fieldsSvc = yield* FieldService
    const computed = yield* ComputedFields
    const labelsSvc = yield* LabelService

    const inst = yield* instances.get(id)
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

    // Inherited (static) labels come from the concept; the instance's own labels
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
    // its specific version, a general ref to the item's CURRENT latest published
    // (re-resolved here — the shadow `toId` may be stale after a republish).
    // Inbound: the source version (already filtered to published by `listTo`).
    const resolveEntry = (
      rel: {
        id: string
        fieldId: string
        fromId: string
        toItemId: string
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
              : ((yield* instances.headOf(rel.toItemId))?.id ?? null)
        const field = yield* fieldsSvc.getById(rel.fieldId)
        // Dangling: a general ref whose item has no live published version, OR a
        // pinned target that is archived/gone (instances.get is live-only).
        // Surface both as unavailable rather than silently dropping the edge.
        const other = otherId
          ? yield* instances.get(otherId).pipe(Effect.catchAll(() => Effect.succeed(null)))
          : null
        // A target in a concept this caller may not read: DROP the edge entirely
        // rather than fall into the "(unavailable)" shape below, which would still
        // confirm that a connection exists (and name its concept). `nameById` comes
        // from the filtered `concepts.list()`, so a missing name is the signal.
        if (otherId && !other) {
          const targetItem = yield* instances
            .getItem(rel.toItemId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (!targetItem) return null
        }
        if (!other) {
          const item = yield* instances
            .getItem(rel.toItemId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)))
          const cId = item?.conceptId ?? ""
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
            instance: null,
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
        const dMasked = maskInstance(d, otherHidden)
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
          instance: dMasked,
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
      instance: maskInstance(decorated, hostHidden),
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

/** The dashboard a fresh concept starts with: its instance table as one
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

export const createConcept = (name: string, color?: string | null): UC<unknown> =>
  Effect.gen(function* () {
    const concepts = yield* ConceptService
    const dashboards = yield* DashboardService
    const concept = yield* concepts.create({ name, color })
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

export const setConceptInstanceView = (
  id: string,
  instanceView: InstanceViewLayout | null,
): UC<unknown> => Effect.flatMap(ConceptService, (c) => c.setInstanceView(id, instanceView))

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
      Effect.flatMap(InstanceService, (i) =>
        i.setConceptSingleRecord({ conceptId, singleRecord, fields }),
      ),
    ),
  )

/**
 * The sole record of a single-record concept, as the SAME `InstanceDetail` shape
 * `getInstance` returns — so `/c/<slug>` can render through the ordinary record
 * view with no second assembly to keep in sync. Null when the concept has no
 * record (which shouldn't happen while the flag is on: that's the leak detector,
 * not a normal state).
 *
 * Resolution is `singleRecordOf`, NOT `listInstances(...)[0]` — see its doc
 * comment: a versioned concept's first record is a draft and is invisible to
 * every head-only query.
 */
export const getSingleRecord = (conceptId: string): UC<unknown> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const record = yield* instances.singleRecordOf(conceptId)
    if (!record) return null
    return yield* getInstanceDetail(record.id)
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
 * refuses while any instance exists (`ConceptInUse`), and the UI offers "Archive
 * instead". That stays exactly as it is — no `singleRecord` special-casing inside
 * the engine. But a single-record concept can never reach zero instances (its
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
 * `InstanceInUse` from step 2 is deliberately NOT forced through: if live
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
    const instances = yield* InstanceService
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const record = yield* instances.singleRecordOf(id)
        // 1. Clear the flag first — `SingleRecordProtected` would otherwise refuse
        //    the record purge (that guard is the whole point of the flag).
        yield* instances.setConceptSingleRecord({ conceptId: id, singleRecord: false })
        // 2. The record's own versions: purge each, newest first. `purge` drops the
        //    `items` lineage (and its files) with the last one, so the concept then
        //    sees a genuinely empty table rather than an orphaned lineage.
        if (record) {
          const versions = yield* instances.listVersions(record.itemId)
          for (const v of [...versions].reverse()) {
            yield* instances.purge({ instanceId: v.id })
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

/** The caller's instance-view layout prefs (own row only by construction). */
export const getInstanceViewPrefs: UC<unknown> = Effect.flatMap(MemberService, (m) =>
  m.getViewPrefs(),
)

export const updateInstanceViewPrefs = (body: InstanceViewPrefsBody): UC<unknown> =>
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

export const getInstanceGraphLayout = (itemId: string): UC<GraphLayoutPositions> =>
  Effect.flatMap(GraphLayoutService, (s) => s.getForItem(itemId))

export const saveInstanceGraphLayout = (
  itemId: string,
  positions: GraphLayoutPositions,
): UC<GraphLayoutPositions> =>
  Effect.flatMap(GraphLayoutService, (s) => s.saveForItem(itemId, positions))

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
  /** Raw event payload — only the per-item activity feed sends it (the
   *  org-wide feeds stay metadata-only). */
  readonly payload?: unknown
  /** For field-edit events: what each patched field held before, folded from
   *  the instance's event stream (events store only the new values). */
  readonly previous?: Record<string, unknown>
}

export const getChanged: UC<ReadonlyArray<FeedItem>> = Effect.flatMap(EventStore, (e) =>
  e.readAllForOrg({ limit: 50 }),
).pipe(
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
  Effect.flatMap(EventStore, (e) =>
    e.listEvents({
      conceptId: input.conceptId ?? undefined,
      since: input.since != null ? new Date(input.since) : undefined,
      limit: input.limit,
    }),
  ).pipe(
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

// ── commands ──────────────────────────────────────────────────────────────────

export const createInstance = (conceptId: string, fields: Record<string, unknown>): UC<Instance> =>
  ensureUnmanagedConcept(conceptId).pipe(
    Effect.zipRight(ensureWritableVisibility(conceptId, Object.keys(fields))),
    Effect.zipRight(
      maskEcho(Effect.flatMap(InstanceService, (i) => i.create({ conceptId, fields }))),
    ),
  )

export const updateInstance = (
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): UC<Instance> =>
  ensureWritablePatch(id, Object.keys(patch)).pipe(
    Effect.zipRight(
      Effect.gen(function* () {
        const instances = yield* InstanceService
        const inst = yield* instances.get(id)
        yield* ensureWritableVisibility(inst.conceptId, Object.keys(patch))
        return yield* maskEcho(instances.update({ instanceId: id, expectedVersion, patch }))
      }),
    ),
  )

export const transitionInstance = (
  id: string,
  expectedVersion: number,
  field: string,
  to: string,
): UC<Instance> =>
  Effect.gen(function* () {
    yield* ensureWritablePatch(id, [field])
    const instances = yield* InstanceService
    const inst = yield* instances.get(id)
    yield* ensureWritableVisibility(inst.conceptId, [field])
    return yield* maskEcho(instances.transition({ instanceId: id, expectedVersion, field, to }))
  })

export const archiveInstance = (id: string, expectedVersion: number): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(
      maskEcho(
        Effect.flatMap(InstanceService, (i) => i.archive({ instanceId: id, expectedVersion })),
      ),
    ),
  )

export const restoreInstance = (id: string, expectedVersion: number): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(
      maskEcho(
        Effect.flatMap(InstanceService, (i) => i.restore({ instanceId: id, expectedVersion })),
      ),
    ),
  )

export const deleteInstance = (id: string): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(maskEcho(Effect.flatMap(InstanceService, (i) => i.purge({ instanceId: id })))),
  )

export const linkRelation = (
  fieldId: string,
  fromId: string,
  toId: string,
  properties?: Record<string, unknown>,
): UC<unknown> =>
  Effect.flatMap(RelationService, (r) => r.create({ fieldId, fromId, toId, properties }))

// ── versioning ──────────────────────────────────────────────────────────────

export const listVersions = (itemId: string): UC<ReadonlyArray<Instance>> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const rows = yield* instances.listVersions(itemId)
    const first = rows[0]
    if (!first) return rows
    // Every version of an item shares its concept, so one mask covers them all.
    const hidden = yield* fieldMaskFor(first.conceptId)
    return hidden.size === 0 ? rows : rows.map((r) => maskInstance(r, hidden))
  })

export const newVersion = (itemId: string): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const out = yield* instances.newVersion({ itemId })
    // A writer's response is projected exactly like a reader's.
    return maskInstance(out, yield* fieldMaskFor(out.conceptId))
  })

export const publishVersion = (id: string, expectedVersion: number): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const out = yield* instances.publishVersion({ instanceId: id, expectedVersion })
    // A writer's response is projected exactly like a reader's.
    return maskInstance(out, yield* fieldMaskFor(out.conceptId))
  })

export const discardDraft = (id: string): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const out = yield* instances.discardDraft({ instanceId: id })
    // A writer's response is projected exactly like a reader's.
    return maskInstance(out, yield* fieldMaskFor(out.conceptId))
  })

export const archiveItem = (itemId: string): UC<unknown> =>
  Effect.flatMap(InstanceService, (i) => i.archiveItem({ itemId }))

export const restoreItem = (itemId: string): UC<unknown> =>
  Effect.flatMap(InstanceService, (i) => i.restoreItem({ itemId }))

/** Relation-picker candidates: the head (latest published) of each item of a
 *  concept whose display label matches `query`. */
export const searchInstances = (conceptId: string, query?: string, limit = 20): UC<unknown> =>
  Effect.gen(function* () {
    const q = yield* QueryService
    const fieldsSvc = yield* FieldService
    const conceptsSvc = yield* ConceptService
    const rows = yield* q.findInstances({ conceptId, limit: 200 })
    const [defs, concept] = yield* Effect.all([
      fieldsSvc.listFields(conceptId),
      conceptsSvc.getById(conceptId),
    ])
    const titleId = titleFieldIdOf(concept.titleFieldId, defs)
    // A hidden TITLE field must not leak through the picker's display text.
    const hidden = yield* fieldMaskFor(conceptId)
    const visibleTitleId = titleId && !hidden.has(titleId) ? titleId : null
    const out = rows.map((r) => ({
      itemId: r.itemId,
      instanceId: r.id,
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
  readonly toItemId?: string
  readonly toVersionId?: string
  readonly toId?: string
  readonly properties?: Record<string, unknown>
}): UC<unknown> => Effect.flatMap(RelationService, (r) => r.create(input))

export const removeRelation = (relationId: string): UC<unknown> =>
  Effect.flatMap(RelationService, (r) => r.remove({ relationId }))

/** `owner` is a record's item lineage or a Files widget's bucket — see UploadOwner. */
export const uploadAttachment = (
  owner: UploadOwner,
  filename: string,
  mimeType: string | undefined,
  data: Uint8Array,
): UC<Attachment> =>
  Effect.flatMap(AttachmentService, (a) => a.upload({ owner, filename, mimeType, data }))

export const listFiles = (filter: {
  readonly itemId?: string
  readonly instanceId?: string
  readonly bucketId?: string
  readonly conceptId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}): UC<ReadonlyArray<Attachment>> => Effect.flatMap(AttachmentService, (a) => a.list(filter))

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
  Effect.flatMap(AnnotationService, (a) => a.listNotes(subjectId, { includeArchived }))

export const createNote = (input: {
  readonly subjectId: string | null
  readonly body: string
  readonly customFields?: Record<string, unknown>
}): UC<Note> => Effect.flatMap(AnnotationService, (a) => a.createNote(input))

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
  Effect.flatMap(AnnotationService, (a) => a.listTasks(filter))

/**
 * Batch-resolve task subjects (item lineage ids) for display: each to its head
 * version (latest published, else newest — mirrors the Overview's click-through)
 * plus a label from the concept's first text field (instance state is keyed by
 * field id; the client lacks foreign field defs). A gone/dangling item degrades
 * to a null instance rather than failing the batch.
 */
export const resolveTaskSubjects = (subjectIds: ReadonlyArray<string>): UC<unknown> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const fieldsSvc = yield* FieldService
    const conceptsSvc = yield* ConceptService
    const fieldCache = new Map<string, ReadonlyArray<{ id: string; kind: string }>>()
    const titleCache = new Map<string, string | null>()
    const maskCache = new Map<string, ReadonlySet<string>>()

    const resolveOne = (subjectId: string) =>
      Effect.gen(function* () {
        const item = yield* instances.getItem(subjectId)
        const head =
          (yield* instances.headOf(subjectId)) ??
          (yield* instances.listVersions(subjectId)).at(-1) ??
          null
        if (!head)
          return { subjectId, instanceId: null, label: "(unavailable)", conceptId: item.conceptId }
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
          instanceId: head.id,
          label:
            visibleTitleId && head.state[visibleTitleId]
              ? String(head.state[visibleTitleId])
              : "(untitled)",
          conceptId: head.conceptId,
        }
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({ subjectId, instanceId: null, label: "(unavailable)", conceptId: null }),
        ),
      )

    // Dedupe + cap: the page sends each task's subject once; 1000 bounds a
    // pathological caller (listTasks itself defaults to 500 rows).
    return yield* Effect.forEach([...new Set(subjectIds)].slice(0, 1000), resolveOne)
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
}): UC<Task> => Effect.flatMap(AnnotationService, (a) => a.createTask(input))

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

/** Per-item activity (union of the lineage's events + its annotations' events).
 *  Field-edit events also get `previous` — the values the patch overwrote,
 *  reconstructed by folding the instance's own stream oldest-first. */
export const getActivity = (subjectId: string, limit = 100): UC<ReadonlyArray<FeedItem>> =>
  Effect.gen(function* () {
    const annotations = yield* AnnotationService
    const store = yield* EventStore
    // `readActivityForSubject` keys purely off `subject_id`, so without this a
    // member could read the whole payload stream of a record in a concept they
    // cannot see — including `InstanceCreated.fields` and every patch. `getItem`
    // carries the concept read gate, so resolving the lineage IS the check.
    const instances = yield* InstanceService
    yield* instances.getItem(subjectId).pipe(
      // Not every subject is an item lineage (annotations have their own ids), so a
      // miss must fall through rather than deny — the gate only fires on a real,
      // restricted lineage.
      Effect.catchTag("ItemNotFound", () => Effect.void),
    )
    const events = yield* annotations.readActivityForSubject(subjectId, { limit })
    // An amendment (`VersionAmended`) is a field edit too, so it gets the same
    // before/after treatment — and its patch must join the running fold, or a later
    // event's `previous` would report a value the amendment had already replaced.
    const edited = events.filter(
      (ev) =>
        ev.subjectKind === "instance" &&
        (ev.payload._tag === "InstanceUpdated" || ev.payload._tag === "VersionAmended"),
    )
    const previousByEvent = new Map<number, Record<string, unknown>>()
    for (const instanceId of new Set(edited.map((ev) => ev.subjectId))) {
      const state: Record<string, unknown> = {}
      for (const ev of yield* store.readStream(instanceId)) {
        const p = ev.payload
        if (p._tag === "InstanceCreated") Object.assign(state, p.fields)
        else if (p._tag === "InstanceUpdated" || p._tag === "VersionAmended") {
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
    const lineage = yield* instances
      .getItem(subjectId)
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
}): UC<Automation> => Effect.flatMap(AutomationService, (s) => s.create(input))

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
  Effect.flatMap(AutomationService, (s) => s.remove(id)).pipe(Effect.map(() => ({ id })))

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
