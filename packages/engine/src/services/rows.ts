import type {
  Concept,
  EngineEvent,
  EventPayload,
  Field,
  FieldConfig,
  FieldKind,
  Instance,
  InstanceState,
  Relation,
  SubjectKind,
} from "../domain/types"

/** Raw DB row shapes (snake_case, as returned by `SELECT *`). */
export interface ConceptRow {
  readonly id: string
  readonly org_id: string
  readonly name: string
  readonly description: string | null
  readonly created_at: Date
}
export interface FieldRow {
  readonly id: string
  readonly org_id: string
  readonly concept_id: string
  readonly name: string
  readonly kind: string
  readonly formula: string | null
  readonly config: unknown
}
export interface InstanceRow {
  readonly id: string
  readonly org_id: string
  readonly concept_id: string
  readonly state: InstanceState
  readonly version: number | string
  readonly created_at: Date
  readonly deleted_at: Date | null
}
export interface RelationRow {
  readonly id: string
  readonly org_id: string
  readonly relation_type: string
  readonly from_id: string
  readonly to_id: string
  readonly properties: Record<string, unknown>
  readonly created_at: Date
  readonly deleted_at: Date | null
}
export interface EventRow {
  readonly id: number | string
  readonly org_id: string
  readonly occurred_at: Date
  readonly actor: string | null
  readonly subject_kind: string
  readonly subject_id: string
  readonly event_type: string
  readonly payload: EventPayload
}

const toFieldConfig = (raw: unknown): FieldConfig =>
  raw && typeof raw === "object" ? (raw as FieldConfig) : {}

export const toConcept = (r: ConceptRow): Concept => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  description: r.description,
  createdAt: r.created_at,
})

export const toField = (r: FieldRow): Field => ({
  id: r.id,
  orgId: r.org_id,
  conceptId: r.concept_id,
  name: r.name,
  kind: r.kind as FieldKind,
  formula: r.formula,
  config: toFieldConfig(r.config),
})

export const toInstance = (r: InstanceRow): Instance => ({
  id: r.id,
  orgId: r.org_id,
  conceptId: r.concept_id,
  state: r.state ?? {},
  version: Number(r.version),
  createdAt: r.created_at,
  deletedAt: r.deleted_at,
})

export const toRelation = (r: RelationRow): Relation => ({
  id: r.id,
  orgId: r.org_id,
  relationType: r.relation_type,
  fromId: r.from_id,
  toId: r.to_id,
  properties: r.properties ?? {},
  createdAt: r.created_at,
  deletedAt: r.deleted_at,
})

export const toEvent = (r: EventRow): EngineEvent => ({
  id: Number(r.id),
  orgId: r.org_id,
  occurredAt: r.occurred_at,
  actor: r.actor,
  subjectKind: r.subject_kind as SubjectKind,
  subjectId: r.subject_id,
  eventType: r.event_type,
  payload: r.payload,
})
