import type {
  Attachment,
  Concept,
  EngineEvent,
  EventPayload,
  Field,
  FieldConfig,
  FieldKind,
  Instance,
  InstanceState,
  Label,
  Relation,
  SubjectKind,
} from "../domain/types"

/** Raw DB row shapes (snake_case, as returned by `SELECT *`). */
export interface ConceptRow {
  readonly id: string
  readonly org_id: string
  readonly slug: string
  readonly name: string
  readonly plural_name: string | null
  readonly description: string | null
  readonly icon: string | null
  readonly static_label_ids: unknown
  readonly default_label_ids: unknown
  readonly created_at: Date
}
export interface LabelRow {
  readonly id: string
  readonly org_id: string
  readonly name: string
  readonly color: string | null
  readonly is_primary: boolean
  readonly created_at: Date
  readonly deleted_at: Date | null
}
export interface FieldRow {
  readonly id: string
  readonly org_id: string
  readonly concept_id: string
  readonly name: string
  readonly kind: string
  readonly formula: string | null
  readonly config: unknown
  readonly icon: string | null
  readonly deleted_at: Date | null
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
  readonly field_id: string
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

/** Coerce a jsonb column into a string-id array (defensive against null/garbage). */
const toIdArray = (raw: unknown): ReadonlyArray<string> =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []

export const toConcept = (r: ConceptRow): Concept => ({
  id: r.id,
  orgId: r.org_id,
  slug: r.slug,
  name: r.name,
  pluralName: r.plural_name,
  description: r.description,
  icon: r.icon,
  staticLabelIds: toIdArray(r.static_label_ids),
  defaultLabelIds: toIdArray(r.default_label_ids),
  createdAt: r.created_at,
})

export const toLabel = (r: LabelRow): Label => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  color: r.color,
  primary: r.is_primary,
  createdAt: r.created_at,
  deletedAt: r.deleted_at,
})

export const toField = (r: FieldRow): Field => ({
  id: r.id,
  orgId: r.org_id,
  conceptId: r.concept_id,
  name: r.name,
  kind: r.kind as FieldKind,
  formula: r.formula,
  config: toFieldConfig(r.config),
  icon: r.icon,
  deletedAt: r.deleted_at,
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
  fieldId: r.field_id,
  fromId: r.from_id,
  toId: r.to_id,
  properties: r.properties ?? {},
  createdAt: r.created_at,
  deletedAt: r.deleted_at,
})

export interface AttachmentRow {
  readonly id: string
  readonly org_id: string
  readonly instance_id: string
  readonly filename: string
  readonly content_ref: string
  readonly mime_type: string | null
  readonly size_bytes: number | string | null
  readonly created_at: Date
}

export const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  orgId: r.org_id,
  instanceId: r.instance_id,
  filename: r.filename,
  contentRef: r.content_ref,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  createdAt: r.created_at,
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
