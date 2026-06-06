import {
  type Attachment,
  AttachmentService,
  ComputedFields,
  ConceptService,
  type EngineServices,
  EventStore,
  type Instance,
  InstanceService,
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
  readonly relatedToTo?: { readonly relationType: string; readonly toId: string }
  readonly limit?: number
  readonly decorate?: boolean
}

export const listInstances = (
  conceptName: string,
  opts: ListOpts = {},
): UC<ReadonlyArray<Instance>> =>
  Effect.gen(function* () {
    const query = yield* QueryService
    const computed = yield* ComputedFields
    const rows = yield* query.findInstances({
      conceptName,
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

export const listConcepts: UC<unknown> = Effect.flatMap(ConceptService, (c) => c.list())

export const getAccountHub = (accountId: string): UC<unknown> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const query = yield* QueryService
    const computed = yield* ComputedFields
    const attachments = yield* AttachmentService
    const account = yield* instances.get(accountId)
    const related = (conceptName: string, relationType: string, orderBy?: ListOpts["orderBy"]) =>
      query.findInstances({ conceptName, relatedToTo: { relationType, toId: accountId }, orderBy })
    const dealsRaw = yield* related("Deal", "for")
    const artifactsRaw = yield* related("Artifact", "belongs_to")
    return {
      account,
      contacts: yield* related("Contact", "works_at"),
      owners: yield* related("TeamMember", "owns"),
      interactions: yield* related("Interaction", "on", { field: "occurred_on", dir: "desc" }),
      signals: yield* related("Signal", "from"),
      tasks: yield* related("Task", "on"),
      deals: yield* Effect.forEach(dealsRaw, (d) => computed.decorate(d)),
      artifacts: yield* Effect.forEach(artifactsRaw, (a) =>
        attachments.list(a.id).pipe(Effect.map((atts) => ({ ...a, attachments: atts }))),
      ),
    }
  })

const decayBand = (d: Instance) => (d.state.decay as { band?: string } | undefined)?.band

export const getOwed: UC<unknown> = Effect.gen(function* () {
  const query = yield* QueryService
  const computed = yield* ComputedFields
  const tasks = yield* query.findInstances({ conceptName: "Task", limit: 200 })
  const openTasks = tasks.filter((t) => t.state.done !== true)
  const dealsRaw = yield* query.findInstances({ conceptName: "Deal", limit: 200 })
  const deals = yield* Effect.forEach(dealsRaw, (d) => computed.decorate(d))
  const open = deals.filter((d) => d.state.status !== "won" && d.state.status !== "lost")
  return {
    openTasks,
    decayingDeals: open
      .filter((d) => decayBand(d) === "cooling" || decayBand(d) === "cold")
      .sort(
        (a, b) =>
          ((b.state.decay as { days?: number }).days ?? 0) -
          ((a.state.decay as { days?: number }).days ?? 0),
      ),
    dueRenewals: open.filter((d) => d.state.is_renewal === true),
  }
})

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

export const getDemand: UC<unknown> = Effect.gen(function* () {
  const query = yield* QueryService
  const relations = yield* RelationService
  const instances = yield* InstanceService
  const signals = yield* query.findInstances({ conceptName: "Signal", limit: 200 })
  const open = signals.filter((s) => s.state.status !== "shipped")
  const items = yield* Effect.forEach(open, (signal) =>
    Effect.gen(function* () {
      const rels = yield* relations.listFrom(signal.id, "from")
      const accountId = rels[0]?.toId
      if (!accountId) return { signal, accountId: null, accountName: null, weight: 0 }
      const account = yield* instances
        .get(accountId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      const weight = Number(account?.state.contract_value ?? account?.state.prospecting_value ?? 0)
      return { signal, accountId, accountName: (account?.state.name as string) ?? null, weight }
    }),
  )
  return [...items].sort((a, b) => b.weight - a.weight)
})

// ── commands ──────────────────────────────────────────────────────────────────

export const createInstance = (
  conceptName: string,
  fields: Record<string, unknown>,
): UC<Instance> => Effect.flatMap(InstanceService, (i) => i.create({ conceptName, fields }))

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
  relationType: string,
  fromId: string,
  toId: string,
  properties?: Record<string, unknown>,
): UC<unknown> =>
  Effect.flatMap(RelationService, (r) => r.create({ relationType, fromId, toId, properties }))

/** Create an instance of `conceptName` and link it to an account via `relationType`. */
const createLinked = (
  conceptName: string,
  relationType: string,
  accountId: string,
  fields: Record<string, unknown>,
): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const relations = yield* RelationService
    const inst = yield* instances.create({ conceptName, fields })
    yield* relations.create({ relationType, fromId: inst.id, toId: accountId })
    return inst
  })

export const createContact = (accountId: string, fields: Record<string, unknown>) =>
  createLinked("Contact", "works_at", accountId, fields)

export const createDeal = (accountId: string, fields: Record<string, unknown>) =>
  createLinked("Deal", "for", accountId, fields)

export const logSignal = (accountId: string, fields: Record<string, unknown>) =>
  createLinked("Signal", "from", accountId, fields)

export const createTask = (accountId: string, fields: Record<string, unknown>) =>
  createLinked("Task", "on", accountId, { done: false, ...fields })

export const createArtifact = (accountId: string, fields: Record<string, unknown>) =>
  createLinked("Artifact", "belongs_to", accountId, fields)

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

export const logInteraction = (
  accountId: string,
  fields: Record<string, unknown>,
  contactId?: string,
): UC<Instance> =>
  Effect.gen(function* () {
    const instances = yield* InstanceService
    const relations = yield* RelationService
    const interaction = yield* instances.create({ conceptName: "Interaction", fields })
    yield* relations.create({ relationType: "on", fromId: interaction.id, toId: accountId })
    if (contactId)
      yield* relations.create({ relationType: "with", fromId: interaction.id, toId: contactId })
    return interaction
  })
