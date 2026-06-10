import type {
  AnnotationField,
  AnnotationType,
  Attachment,
  Concept,
  Dashboard,
  DashboardBody,
  DashboardWidget,
  EngineEvent,
  EventPayload,
  Field,
  FieldConfig,
  FieldKind,
  Instance,
  InstanceState,
  Item,
  Label,
  Note,
  Relation,
  SidebarView,
  SidebarViewBody,
  SubjectKind,
  Task,
  TaskStatus,
  TaskStatusCategory,
  VersionStatus,
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
  readonly versioning_enabled: boolean
  readonly created_at: Date
  readonly archived_at: Date | null
  /** Present only when ConceptService.list is called withCounts. */
  readonly item_count?: number | string
}
export interface ItemRow {
  readonly id: string
  readonly org_id: string
  readonly concept_id: string
  readonly archived_at: Date | null
  readonly created_at: Date
}
export interface LabelRow {
  readonly id: string
  readonly org_id: string
  readonly name: string
  readonly color: string | null
  readonly is_primary: boolean
  readonly created_at: Date
  readonly archived_at: Date | null
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
  readonly position: number | string
  readonly archived_at: Date | null
}
export interface InstanceRow {
  readonly id: string
  readonly org_id: string
  readonly concept_id: string
  readonly item_id: string
  readonly state: InstanceState
  readonly version: number | string
  readonly version_status: string
  readonly version_seq: number | string
  readonly published_at: Date | null
  readonly created_at: Date
  readonly archived_at: Date | null
}
export interface RelationRow {
  readonly id: string
  readonly org_id: string
  readonly field_id: string
  readonly from_id: string
  readonly to_item_id: string
  readonly to_version_id: string | null
  readonly to_id: string
  readonly properties: Record<string, unknown>
  readonly created_at: Date
  readonly archived_at: Date | null
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
  versioningEnabled: r.versioning_enabled ?? false,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
  ...(r.item_count == null ? {} : { itemCount: Number(r.item_count) }),
})

export const toItem = (r: ItemRow): Item => ({
  id: r.id,
  orgId: r.org_id,
  conceptId: r.concept_id,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
})

export const toLabel = (r: LabelRow): Label => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  color: r.color,
  primary: r.is_primary,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
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
  position: Number(r.position),
  archivedAt: r.archived_at,
})

export const toInstance = (r: InstanceRow): Instance => ({
  id: r.id,
  orgId: r.org_id,
  conceptId: r.concept_id,
  itemId: r.item_id,
  state: r.state ?? {},
  version: Number(r.version),
  versionStatus: (r.version_status ?? "published") as VersionStatus,
  versionSeq: Number(r.version_seq ?? 1),
  publishedAt: r.published_at,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
})

export const toRelation = (r: RelationRow): Relation => ({
  id: r.id,
  orgId: r.org_id,
  fieldId: r.field_id,
  fromId: r.from_id,
  toItemId: r.to_item_id,
  toVersionId: r.to_version_id,
  toId: r.to_id,
  properties: r.properties ?? {},
  createdAt: r.created_at,
  archivedAt: r.archived_at,
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

export interface SidebarViewRow {
  readonly id: string
  readonly org_id: string
  readonly owner_id: string | null
  readonly name: string
  readonly icon: string | null
  readonly position: number | string
  readonly hidden: boolean
  readonly body: unknown
  readonly created_at: Date
  readonly updated_at: Date
}

/** Coerce a jsonb body into a well-formed view body (defensive against garbage). */
const toViewBody = (raw: unknown): SidebarViewBody =>
  raw && typeof raw === "object" && Array.isArray((raw as { sections?: unknown }).sections)
    ? (raw as SidebarViewBody)
    : { sections: [] }

export const toSidebarView = (r: SidebarViewRow): SidebarView => ({
  id: r.id,
  orgId: r.org_id,
  ownerId: r.owner_id,
  name: r.name,
  icon: r.icon,
  position: Number(r.position),
  hidden: r.hidden,
  body: toViewBody(r.body),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export interface DashboardRow {
  readonly id: string
  readonly org_id: string
  readonly owner_id: string | null
  readonly name: string
  readonly icon: string | null
  readonly position: number | string
  readonly hidden: boolean
  readonly body: unknown
  readonly created_at: Date
  readonly updated_at: Date
}

/** Widget types this server build knows about. Unknown types are dropped on read
 *  so a newer client's widget can't corrupt an older server's view of the body. */
const KNOWN_WIDGETS = new Set(["metric", "list", "breakdown", "attention", "trend", "activity"])

/** Coerce a jsonb body into a well-formed dashboard body (defensive against
 *  garbage / drift): keep only widgets with a known `type` and a `layout`. */
const toDashboardBody = (raw: unknown): DashboardBody => {
  if (!raw || typeof raw !== "object") return { widgets: [] }
  const r = raw as { widgets?: unknown; cols?: unknown; rowHeight?: unknown }
  const widgets = Array.isArray(r.widgets)
    ? r.widgets.filter(
        (x): x is DashboardWidget =>
          !!x &&
          typeof x === "object" &&
          KNOWN_WIDGETS.has((x as { type?: string }).type ?? "") &&
          !!(x as { layout?: unknown }).layout,
      )
    : []
  return {
    widgets,
    ...(typeof r.cols === "number" ? { cols: r.cols } : {}),
    ...(typeof r.rowHeight === "number" ? { rowHeight: r.rowHeight } : {}),
  }
}

export const toDashboard = (r: DashboardRow): Dashboard => ({
  id: r.id,
  orgId: r.org_id,
  ownerId: r.owner_id,
  name: r.name,
  icon: r.icon,
  position: Number(r.position),
  hidden: r.hidden,
  body: toDashboardBody(r.body),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
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

// ── annotation layer (notes / tasks / statuses / custom-field defs) ──────────

/** Coerce a jsonb custom-fields column into a plain record (defensive vs null). */
const toCustomFields = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

/** One `annotations` row — a polymorphic note|task before mapping to its variant. */
export interface AnnotationRow {
  readonly id: string
  readonly org_id: string
  readonly type: string
  readonly subject_id: string | null
  readonly subject_kind: string | null
  readonly body: string | null
  readonly title: string | null
  readonly status_id: string | null
  readonly assignee: string | null
  readonly due_at: Date | null
  readonly created_by: string | null
  readonly custom_fields: unknown
  readonly version: number | string
  readonly created_at: Date
  readonly updated_at: Date
  readonly archived_at: Date | null
}

export const toNote = (r: AnnotationRow): Note => ({
  id: r.id,
  orgId: r.org_id,
  subjectId: r.subject_id,
  body: r.body ?? "",
  createdBy: r.created_by,
  customFields: toCustomFields(r.custom_fields),
  version: Number(r.version),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
})

export const toTask = (r: AnnotationRow): Task => ({
  id: r.id,
  orgId: r.org_id,
  subjectId: r.subject_id,
  title: r.title ?? "",
  statusId: r.status_id,
  assignee: r.assignee,
  dueAt: r.due_at ? r.due_at.toISOString() : null,
  createdBy: r.created_by,
  customFields: toCustomFields(r.custom_fields),
  version: Number(r.version),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
})

export interface TaskStatusRow {
  readonly id: string
  readonly org_id: string
  readonly name: string
  readonly color: string | null
  readonly category: string
  readonly is_default: boolean
  readonly position: number | string
  readonly archived_at: Date | null
}

export const toTaskStatus = (r: TaskStatusRow): TaskStatus => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  color: r.color,
  category: r.category as TaskStatusCategory,
  isDefault: r.is_default,
  position: Number(r.position),
  archivedAt: r.archived_at,
})

export interface AnnotationFieldRow {
  readonly id: string
  readonly org_id: string
  readonly annotation_type: string
  readonly name: string
  readonly kind: string
  readonly config: unknown
  readonly icon: string | null
  readonly position: number | string
  readonly archived_at: Date | null
}

export const toAnnotationField = (r: AnnotationFieldRow): AnnotationField => ({
  id: r.id,
  orgId: r.org_id,
  annotationType: r.annotation_type as AnnotationType,
  name: r.name,
  kind: r.kind as FieldKind,
  config: toFieldConfig(r.config),
  icon: r.icon,
  position: Number(r.position),
  archivedAt: r.archived_at,
})
