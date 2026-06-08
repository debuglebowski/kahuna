import {
  type Attachment,
  AttachmentService,
  ComputedFields,
  ConceptService,
  type EngineServices,
  EventStore,
  type FieldConfig,
  type FieldKind,
  FieldService,
  type Instance,
  InstanceService,
  LABELS_KEY,
  type Label,
  LabelService,
  type OrgContext,
  QueryService,
  RelationService,
} from "@kingsmaker/engine"
import { Effect } from "effect"

/** All use-cases return engine effects (R = OrgContext | EngineServices) for runScoped. */
type UC<A, E = unknown> = Effect.Effect<A, E, OrgContext | EngineServices>

// ── reads ───────────────────────────────────────────────────────────────────

export interface ListOpts {
  readonly where?: Record<string, unknown>
  readonly orderBy?: { readonly field: string; readonly dir?: "asc" | "desc" }
  readonly relatedToTo?: { readonly fieldId: string; readonly toId: string }
  readonly limit?: number
  readonly decorate?: boolean
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
    const [decorated, concept, fieldDefs, outRels, inRels, allConcepts] = yield* Effect.all([
      computed.decorate(inst),
      conceptsSvc.getById(inst.conceptId),
      fieldsSvc.listFields(inst.conceptId),
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

    const resolve = (
      rel: { id: string; fieldId: string },
      direction: "out" | "in",
      otherId: string,
    ) =>
      Effect.gen(function* () {
        const other = yield* instances.get(otherId)
        const [field, otherFields, d] = yield* Effect.all([
          fieldsSvc.getById(rel.fieldId),
          fieldsSvc.listFields(other.conceptId),
          computed.decorate(other),
        ])
        // Resolve a display label from the connected concept's first text field
        // (its state is keyed by field id; the client lacks these defs).
        const textField = otherFields.find((f) => f.kind === "text" && d.state[f.id])
        return {
          relationId: rel.id,
          fieldId: rel.fieldId,
          // Decorative label, resolved from the field def (renameable).
          relationName: field.name,
          label: textField ? String(d.state[textField.id]) : "(untitled)",
          direction,
          conceptId: other.conceptId,
          conceptName: nameById.get(other.conceptId) ?? other.conceptId,
          instance: d,
        }
      }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    const related = yield* Effect.all([
      Effect.forEach(outRels, (r) => resolve(r, "out", r.toId)),
      Effect.forEach(inRels, (r) => resolve(r, "in", r.fromId)),
    ]).pipe(Effect.map(([a, b]) => [...a, ...b].filter((x) => x !== null)))

    return {
      instance: decorated,
      concept,
      fields: fieldDefs,
      related,
      staticLabels,
      labels: ownLabels,
    }
  })

export const listConcepts: UC<unknown> = Effect.flatMap(ConceptService, (c) => c.list())

export const createConcept = (name: string, description?: string): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) => c.create({ name, description }))

export const updateConcept = (
  id: string,
  patch: {
    readonly name?: string
    readonly description: string | null
    readonly icon?: string | null
    readonly staticLabelIds?: ReadonlyArray<string>
    readonly defaultLabelIds?: ReadonlyArray<string>
  },
): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) =>
    c.update({
      id,
      name: patch.name,
      description: patch.description,
      icon: patch.icon,
      staticLabelIds: patch.staticLabelIds,
      defaultLabelIds: patch.defaultLabelIds,
    }),
  )

export const deleteConcept = (id: string): UC<unknown> =>
  Effect.flatMap(ConceptService, (c) => c.remove(id))

// ── labels (org-wide vocabulary) ───────────────────────────────────────────────

export const listLabels: UC<ReadonlyArray<Label>> = Effect.flatMap(LabelService, (l) => l.list())

export const createLabel = (name: string, color?: string | null, primary?: boolean): UC<Label> =>
  Effect.flatMap(LabelService, (l) => l.create({ name, color, primary }))

export const renameLabel = (
  id: string,
  patch: { readonly name?: string; readonly color?: string | null; readonly primary?: boolean },
): UC<Label> =>
  Effect.flatMap(LabelService, (l) =>
    l.rename({ id, name: patch.name, color: patch.color, primary: patch.primary }),
  )

export const deleteLabel = (id: string): UC<Label> =>
  Effect.flatMap(LabelService, (l) => l.remove(id))

export const listFields = (conceptId: string): UC<unknown> =>
  Effect.flatMap(FieldService, (f) => f.listFields(conceptId))

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
    nodes: concepts.map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon })),
    edges: fieldsPerConcept
      .flat()
      .filter((f) => f.kind === "relation" && !!f.config.target && ids.has(f.config.target))
      .map((f) => ({
        id: f.id,
        from: f.conceptId,
        to: f.config.target as string,
        // Identity is the field id (`id`); these are decorative labels.
        relationType: f.name,
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
}): UC<unknown> => Effect.flatMap(FieldService, (f) => f.addField(input))

export const updateField = (input: {
  readonly id: string
  readonly name?: string
  readonly config?: FieldConfig
  readonly formula?: string | null
  readonly icon?: string | null
}): UC<unknown> => Effect.flatMap(FieldService, (f) => f.update(input))

export const deleteField = (id: string): UC<unknown> =>
  Effect.flatMap(FieldService, (f) => f.remove(id))

export interface FeedItem {
  readonly id: number
  readonly occurredAt: Date
  readonly actor: string | null
  readonly eventType: string
  readonly subjectKind: string
  readonly subjectId: string
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

// ── commands ──────────────────────────────────────────────────────────────────

export const createInstance = (conceptId: string, fields: Record<string, unknown>): UC<Instance> =>
  Effect.flatMap(InstanceService, (i) => i.create({ conceptId, fields }))

export const updateInstance = (
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): UC<Instance> =>
  Effect.flatMap(InstanceService, (i) => i.update({ instanceId: id, expectedVersion, patch }))

export const transitionInstance = (
  id: string,
  expectedVersion: number,
  field: string,
  to: string,
): UC<Instance> =>
  Effect.flatMap(InstanceService, (i) =>
    i.transition({ instanceId: id, expectedVersion, field, to }),
  )

export const linkRelation = (
  fieldId: string,
  fromId: string,
  toId: string,
  properties?: Record<string, unknown>,
): UC<unknown> =>
  Effect.flatMap(RelationService, (r) => r.create({ fieldId, fromId, toId, properties }))

export const uploadAttachment = (
  instanceId: string,
  filename: string,
  mimeType: string | undefined,
  data: Uint8Array,
): UC<Attachment> =>
  Effect.flatMap(AttachmentService, (a) => a.upload({ instanceId, filename, mimeType, data }))

export const listAttachments = (instanceId: string): UC<ReadonlyArray<Attachment>> =>
  Effect.flatMap(AttachmentService, (a) => a.list(instanceId))

export const downloadAttachment = (
  attachmentId: string,
): UC<{ attachment: Attachment; data: Uint8Array }> =>
  Effect.flatMap(AttachmentService, (a) => a.download(attachmentId))
