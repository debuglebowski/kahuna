import {
  type AnnotationField,
  AnnotationFieldService,
  AnnotationService,
  type AnnotationType,
  type Attachment,
  AttachmentService,
  ComputedFields,
  ConceptService,
  type DashboardBody,
  DashboardService,
  type EngineServices,
  EventStore,
  type FieldConfig,
  type FieldKind,
  FieldService,
  type GraphLayoutPositions,
  GraphLayoutService,
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
  type OrgContext,
  QueryService,
  RelationService,
  type RichTextValue,
  type SidebarViewBody,
  SidebarViewService,
  type Task,
  type TaskPriority,
  TaskPriorityService,
  type TaskStatus,
  type TaskStatusCategory,
  TaskStatusService,
} from "@kingsmaker/engine"
import { Effect } from "effect"

/** All use-cases return engine effects (R = OrgContext | EngineServices) for runScoped. */
type UC<A, E = unknown> = Effect.Effect<A, E, OrgContext | EngineServices>

// ── managed-concept guard ─────────────────────────────────────────────────────
// A connector-managed concept's schema + instances are owned by an integration
// sync; reject user-initiated mutations here at the use-case boundary. The sync
// path calls the engine services directly (runEngineOrThrow), never through these
// use-cases, so it stays free to write. Discriminated by the typed `managedBy`
// kind on the concept — never by concept name.

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
    // (the case that matters) are still covered by create/update/archive guards.
    Effect.catchAll((e) =>
      (e as { _tag?: string })?._tag === "InstanceNotFound" ? Effect.void : Effect.fail(e),
    ),
  )

const ensureUnmanagedField = (fieldId: string): UC<void> =>
  Effect.flatMap(FieldService, (f) => f.getById(fieldId)).pipe(
    Effect.flatMap((field) => ensureUnmanagedConcept(field.conceptId)),
  )

// ── reads ───────────────────────────────────────────────────────────────────

export interface ListOpts {
  readonly where?: Record<string, unknown>
  readonly orderBy?: { readonly field: string; readonly dir?: "asc" | "desc" }
  readonly relatedToTo?: { readonly fieldId: string; readonly toId: string }
  readonly limit?: number
  readonly decorate?: boolean
  readonly includeArchived?: boolean
}

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
    return opts.decorate ? yield* Effect.forEach(rows, (r) => computed.decorate(r)) : rows
  })

export const getInstance = (id: string, decorate = false): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const computed = yield* ComputedFields
    const inst = yield* instances.get(id)
    return decorate ? yield* computed.decorate(inst) : inst
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
        // Resolve a display label from the connected concept's first text field
        // (its state is keyed by field id; the client lacks these defs).
        const textField = otherFields.find((f) => f.kind === "text" && d.state[f.id])
        return {
          relationId: rel.id,
          fieldId: rel.fieldId,
          // Decorative labels, resolved from the field def (renameable).
          relationName: field.name,
          relationInverseName: field.config.inverseName ?? null,
          relationInversePluralName: field.config.inversePluralName ?? null,
          label: textField ? String(d.state[textField.id]) : "(untitled)",
          direction,
          conceptId: other.conceptId,
          conceptName: nameById.get(other.conceptId) ?? other.conceptId,
          pinned,
          instance: d,
        }
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    const related = yield* Effect.all([
      Effect.forEach(outRels, (r) => resolveEntry(r, "out")),
      Effect.forEach(inRels, (r) => resolveEntry(r, "in")),
    ]).pipe(Effect.map(([a, b]) => [...a, ...b].filter((x) => x !== null)))

    return {
      instance: decorated,
      concept,
      fields: fieldDefs,
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
        staticLabelIds: patch.staticLabelIds,
        defaultLabelIds: patch.defaultLabelIds,
      }),
    )
  })

export const setConceptInstanceView = (
  id: string,
  instanceView: InstanceViewLayout | null,
): UC<unknown> => Effect.flatMap(ConceptService, (c) => c.setInstanceView(id, instanceView))

export const archiveConcept = (id: string): UC<unknown> =>
  ensureUnmanagedConcept(id).pipe(
    Effect.zipRight(Effect.flatMap(ConceptService, (c) => c.archive(id))),
  )

export const restoreConcept = (id: string): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) => c.restore(id))

export const deleteConcept = (id: string): UC<unknown> =>
  ensureUnmanagedConcept(id).pipe(
    Effect.zipRight(Effect.flatMap(ConceptService, (c) => c.purge(id))),
  )

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
  Effect.flatMap(FieldService, (f) => f.listFields(conceptId, { includeArchived }))

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

export const createDashboard = (input: {
  readonly name: string
  readonly icon?: string | null
  readonly scope: "personal" | "org"
  readonly body: DashboardBody
}): UC<unknown> => Effect.flatMap(DashboardService, (s) => s.create(input))

export const updateDashboard = (input: {
  readonly id: string
  readonly name?: string
  readonly icon?: string | null
  readonly hidden?: boolean
  readonly scope?: "personal" | "org"
  readonly body?: DashboardBody
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
  ensureUnmanagedConcept(input.conceptId).pipe(
    Effect.zipRight(Effect.flatMap(FieldService, (f) => f.addField(input))),
  )

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
  ensureUnmanagedConcept(conceptId).pipe(
    Effect.zipRight(Effect.flatMap(FieldService, (f) => f.reorder(conceptId, orders))),
  )

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
    Effect.zipRight(Effect.flatMap(InstanceService, (i) => i.create({ conceptId, fields }))),
  )

export const updateInstance = (
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(
      Effect.flatMap(InstanceService, (i) => i.update({ instanceId: id, expectedVersion, patch })),
    ),
  )

export const transitionInstance = (
  id: string,
  expectedVersion: number,
  field: string,
  to: string,
): UC<Instance> =>
  Effect.gen(function* () {
    yield* ensureUnmanagedInstance(id)
    return yield* Effect.flatMap(InstanceService, (i) =>
      i.transition({ instanceId: id, expectedVersion, field, to }),
    )
  })

export const archiveInstance = (id: string, expectedVersion: number): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(
      Effect.flatMap(InstanceService, (i) => i.archive({ instanceId: id, expectedVersion })),
    ),
  )

export const restoreInstance = (id: string, expectedVersion: number): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(
      Effect.flatMap(InstanceService, (i) => i.restore({ instanceId: id, expectedVersion })),
    ),
  )

export const deleteInstance = (id: string): UC<Instance> =>
  ensureUnmanagedInstance(id).pipe(
    Effect.zipRight(Effect.flatMap(InstanceService, (i) => i.purge({ instanceId: id }))),
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
  Effect.flatMap(InstanceService, (i) => i.listVersions(itemId))

export const newVersion = (itemId: string): UC<Instance> =>
  Effect.flatMap(InstanceService, (i) => i.newVersion({ itemId }))

export const publishVersion = (id: string, expectedVersion: number): UC<Instance> =>
  Effect.flatMap(InstanceService, (i) => i.publishVersion({ instanceId: id, expectedVersion }))

export const discardDraft = (id: string): UC<Instance> =>
  Effect.flatMap(InstanceService, (i) => i.discardDraft({ instanceId: id }))

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
    const rows = yield* q.findInstances({ conceptId, limit: 200 })
    const defs = yield* fieldsSvc.listFields(conceptId)
    const textField = defs.find((f) => f.kind === "text")
    const out = rows.map((r) => ({
      itemId: r.itemId,
      instanceId: r.id,
      label: textField && r.state[textField.id] ? String(r.state[textField.id]) : "(untitled)",
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

export const uploadAttachment = (
  itemId: string,
  filename: string,
  mimeType: string | undefined,
  data: Uint8Array,
): UC<Attachment> =>
  Effect.flatMap(AttachmentService, (a) => a.upload({ itemId, filename, mimeType, data }))

export const listFiles = (filter: {
  readonly itemId?: string
  readonly instanceId?: string
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
    const fieldCache = new Map<string, ReadonlyArray<{ id: string; kind: string }>>()

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
        const textField = fields.find((f) => f.kind === "text" && head.state[f.id])
        return {
          subjectId,
          instanceId: head.id,
          label: textField ? String(head.state[textField.id]) : "(untitled)",
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
    const events = yield* annotations.readActivityForSubject(subjectId, { limit })
    const edited = events.filter(
      (ev) => ev.subjectKind === "instance" && ev.payload._tag === "InstanceUpdated",
    )
    const previousByEvent = new Map<number, Record<string, unknown>>()
    for (const instanceId of new Set(edited.map((ev) => ev.subjectId))) {
      const state: Record<string, unknown> = {}
      for (const ev of yield* store.readStream(instanceId)) {
        const p = ev.payload
        if (p._tag === "InstanceCreated") Object.assign(state, p.fields)
        else if (p._tag === "InstanceUpdated") {
          previousByEvent.set(
            ev.id,
            Object.fromEntries(Object.keys(p.patch).map((k) => [k, state[k] ?? null])),
          )
          Object.assign(state, p.patch)
        }
      }
    }
    return events.map((ev) => ({
      id: ev.id,
      occurredAt: ev.occurredAt,
      actor: ev.actor,
      eventType: ev.eventType,
      subjectKind: ev.subjectKind,
      subjectId: ev.subjectId,
      payload: ev.payload,
      previous: previousByEvent.get(ev.id),
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
