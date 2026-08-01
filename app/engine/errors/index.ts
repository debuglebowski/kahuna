import { Schema } from "effect"

/**
 * The engine's typed error ADT. All are `Schema.TaggedError` so they carry a
 * `_tag`, are serializable across the (future) RPC boundary, and can be
 * exhaustively matched by the web layer's error->HTTP mapping.
 */

export class VersionConflict extends Schema.TaggedError<VersionConflict>()("VersionConflict", {
  instanceId: Schema.String,
  expected: Schema.Number,
  actual: Schema.Number,
}) {}

export class InstanceNotFound extends Schema.TaggedError<InstanceNotFound>()("InstanceNotFound", {
  instanceId: Schema.String,
}) {}

export class ConceptNotFound extends Schema.TaggedError<ConceptNotFound>()("ConceptNotFound", {
  concept: Schema.String,
}) {}

export class ConceptNameConflict extends Schema.TaggedError<ConceptNameConflict>()(
  "ConceptNameConflict",
  { name: Schema.String },
) {}

export class FieldConfigInvalid extends Schema.TaggedError<FieldConfigInvalid>()(
  "FieldConfigInvalid",
  { conceptId: Schema.String, name: Schema.String, reason: Schema.String },
) {}

export class FieldNameConflict extends Schema.TaggedError<FieldNameConflict>()(
  "FieldNameConflict",
  {
    conceptId: Schema.String,
    name: Schema.String,
  },
) {}

export class FieldNotFound extends Schema.TaggedError<FieldNotFound>()("FieldNotFound", {
  fieldId: Schema.String,
}) {}

export class LabelNotFound extends Schema.TaggedError<LabelNotFound>()("LabelNotFound", {
  labelId: Schema.String,
}) {}

export class LabelNameConflict extends Schema.TaggedError<LabelNameConflict>()(
  "LabelNameConflict",
  { name: Schema.String },
) {}

export class FieldValidationError extends Schema.TaggedError<FieldValidationError>()(
  "FieldValidationError",
  { message: Schema.String, field: Schema.optional(Schema.String) },
) {}

export class ConceptInUse extends Schema.TaggedError<ConceptInUse>()("ConceptInUse", {
  concept: Schema.String,
  instanceCount: Schema.Number,
}) {}

/** A field can't be hard-deleted while relation edges still reference it. */
export class FieldInUse extends Schema.TaggedError<FieldInUse>()("FieldInUse", {
  field: Schema.String,
  relationCount: Schema.Number,
}) {}

/** An instance can't be hard-deleted while relation edges still reference it. */
export class InstanceInUse extends Schema.TaggedError<InstanceInUse>()("InstanceInUse", {
  instanceId: Schema.String,
  relationCount: Schema.Number,
}) {}

export class IllegalTransition extends Schema.TaggedError<IllegalTransition>()(
  "IllegalTransition",
  {
    field: Schema.String,
    from: Schema.String,
    to: Schema.String,
    allowed: Schema.Array(Schema.String),
  },
) {}

export class RelationTargetMismatch extends Schema.TaggedError<RelationTargetMismatch>()(
  "RelationTargetMismatch",
  { relationType: Schema.String, expected: Schema.String, actual: Schema.String },
) {}

export class RelationNotFound extends Schema.TaggedError<RelationNotFound>()("RelationNotFound", {
  relationId: Schema.String,
}) {}

export class OrgScopeViolation extends Schema.TaggedError<OrgScopeViolation>()(
  "OrgScopeViolation",
  {
    resource: Schema.String,
    id: Schema.String,
  },
) {}

export class AttachmentNotFound extends Schema.TaggedError<AttachmentNotFound>()(
  "AttachmentNotFound",
  { attachmentId: Schema.String },
) {}

/** Upload exceeded `MAX_UPLOAD_BYTES`. Raised before the blob write, so nothing
 *  is stored — the route buffers the whole body in memory, hence the cap. */
export class AttachmentTooLarge extends Schema.TaggedError<AttachmentTooLarge>()(
  "AttachmentTooLarge",
  { sizeBytes: Schema.Number, maxBytes: Schema.Number },
) {}

export class EventCorruption extends Schema.TaggedError<EventCorruption>()("EventCorruption", {
  reason: Schema.String,
  eventId: Schema.Number,
}) {}

// ── versioning ──────────────────────────────────────────────────────────────

export class ItemNotFound extends Schema.TaggedError<ItemNotFound>()("ItemNotFound", {
  itemId: Schema.String,
}) {}

/** A published version is frozen: it can't be edited, re-published, or have its
 *  links changed. Raised only on a versioned concept whose `editReach` is `draft`
 *  — under `any`, published versions are amendable and this never fires for an
 *  edit (it still guards re-publish). */
export class VersionFrozen extends Schema.TaggedError<VersionFrozen>()("VersionFrozen", {
  instanceId: Schema.String,
}) {}

/** Only one draft may be open per item at a time — publish or discard it first. */
export class DraftAlreadyExists extends Schema.TaggedError<DraftAlreadyExists>()(
  "DraftAlreadyExists",
  { itemId: Schema.String, draftInstanceId: Schema.String },
) {}

/** A reference can't pin to a draft (or otherwise non-published) version. */
export class RelationPinToDraft extends Schema.TaggedError<RelationPinToDraft>()(
  "RelationPinToDraft",
  { versionId: Schema.String },
) {}

/** A general reference can't resolve an item that has no published version yet
 *  (a brand-new item is not referenceable until its first publish). */
export class ItemNotPublished extends Schema.TaggedError<ItemNotPublished>()("ItemNotPublished", {
  itemId: Schema.String,
}) {}

/** Versioning can't be disabled on a concept while items hold >1 version or an
 *  open draft — that would orphan versions with no defined "latest". */
export class VersioningInUse extends Schema.TaggedError<VersioningInUse>()("VersioningInUse", {
  conceptId: Schema.String,
  multiVersionItemCount: Schema.Number,
}) {}

/** A single-record concept can hold only ONE record. Raised two ways: creating a
 *  second record on one, and switching the flag on while >1 live item exists
 *  (which one would survive is not ours to guess — archive the rest first). */
export class SingleRecordConflict extends Schema.TaggedError<SingleRecordConflict>()(
  "SingleRecordConflict",
  { conceptId: Schema.String, liveItemCount: Schema.Number },
) {}

/** The sole record of a single-record concept can't be archived or purged — the
 *  concept guarantees it always exists. Turn the flag off first, or delete the
 *  whole concept (which cascades to the record at the use-case layer). */
export class SingleRecordProtected extends Schema.TaggedError<SingleRecordProtected>()(
  "SingleRecordProtected",
  { conceptId: Schema.String, instanceId: Schema.String },
) {}

export class SidebarViewNotFound extends Schema.TaggedError<SidebarViewNotFound>()(
  "SidebarViewNotFound",
  { id: Schema.String },
) {}

/** The last shared (Default) view can't be deleted — the list must never empty. */
export class SidebarViewProtected extends Schema.TaggedError<SidebarViewProtected>()(
  "SidebarViewProtected",
  { id: Schema.String },
) {}

export class DashboardNotFound extends Schema.TaggedError<DashboardNotFound>()(
  "DashboardNotFound",
  { id: Schema.String },
) {}

/** The last shared dashboard can't be deleted — the home (`/`) must never empty. */
export class DashboardProtected extends Schema.TaggedError<DashboardProtected>()(
  "DashboardProtected",
  { id: Schema.String },
) {}

/** Optimistic-concurrency conflict: the dashboard was edited elsewhere since the
 *  caller loaded it (its `updatedAt` moved). The caller should reload + retry. */
export class DashboardConflict extends Schema.TaggedError<DashboardConflict>()(
  "DashboardConflict",
  { id: Schema.String },
) {}

// ── annotation layer (notes/tasks) ──────────────────────────────────────────

export class AnnotationNotFound extends Schema.TaggedError<AnnotationNotFound>()(
  "AnnotationNotFound",
  { annotationId: Schema.String },
) {}

export class TaskStatusNotFound extends Schema.TaggedError<TaskStatusNotFound>()(
  "TaskStatusNotFound",
  { statusId: Schema.String },
) {}

export class TaskStatusNameConflict extends Schema.TaggedError<TaskStatusNameConflict>()(
  "TaskStatusNameConflict",
  { name: Schema.String },
) {}

/** A task status can't be archived while live tasks still reference it, or if it
 *  is the last status of its kind (default / the only `done`). */
export class TaskStatusInUse extends Schema.TaggedError<TaskStatusInUse>()("TaskStatusInUse", {
  statusId: Schema.String,
  taskCount: Schema.Number,
  reason: Schema.String,
}) {}

export class TaskPriorityNotFound extends Schema.TaggedError<TaskPriorityNotFound>()(
  "TaskPriorityNotFound",
  { priorityId: Schema.String },
) {}

export class TaskPriorityNameConflict extends Schema.TaggedError<TaskPriorityNameConflict>()(
  "TaskPriorityNameConflict",
  { name: Schema.String },
) {}

/** A task priority can't be archived while live tasks still reference it. */
export class TaskPriorityInUse extends Schema.TaggedError<TaskPriorityInUse>()(
  "TaskPriorityInUse",
  { priorityId: Schema.String, taskCount: Schema.Number },
) {}

export class AnnotationFieldNotFound extends Schema.TaggedError<AnnotationFieldNotFound>()(
  "AnnotationFieldNotFound",
  { fieldId: Schema.String },
) {}

export class AnnotationFieldNameConflict extends Schema.TaggedError<AnnotationFieldNameConflict>()(
  "AnnotationFieldNameConflict",
  { annotationType: Schema.String, name: Schema.String },
) {}

export class AnnotationFieldConfigInvalid extends Schema.TaggedError<AnnotationFieldConfigInvalid>()(
  "AnnotationFieldConfigInvalid",
  { annotationType: Schema.String, name: Schema.String, reason: Schema.String },
) {}

export class AutomationNotFound extends Schema.TaggedError<AutomationNotFound>()(
  "AutomationNotFound",
  { automationId: Schema.String },
) {}

/** A trigger or action document that no vocabulary entry accepts (an unknown
 *  kind, a schedule with no cadence, a `setField` with no field). Raised at the
 *  service boundary so a bad rule can never be persisted. */
export class AutomationInvalid extends Schema.TaggedError<AutomationInvalid>()(
  "AutomationInvalid",
  { reason: Schema.String },
) {}

/** A connector-managed concept (Linear ticket, Gmail email, …) owns its own
 *  schema + instances via integration sync; user-initiated mutations (rename,
 *  add/remove field, create/edit/delete instance) are rejected. The sync path
 *  itself doesn't go through the guarded use-cases, so it's unaffected. */
export class ManagedConceptReadonly extends Schema.TaggedError<ManagedConceptReadonly>()(
  "ManagedConceptReadonly",
  { concept: Schema.String, managedBy: Schema.String },
) {}

export type EngineError =
  | VersionConflict
  | ManagedConceptReadonly
  | InstanceNotFound
  | ConceptNotFound
  | ConceptNameConflict
  | ConceptInUse
  | FieldInUse
  | InstanceInUse
  | FieldConfigInvalid
  | FieldNameConflict
  | FieldNotFound
  | FieldValidationError
  | LabelNotFound
  | LabelNameConflict
  | IllegalTransition
  | RelationTargetMismatch
  | RelationNotFound
  | OrgScopeViolation
  | AttachmentNotFound
  | AttachmentTooLarge
  | EventCorruption
  | ItemNotFound
  | VersionFrozen
  | DraftAlreadyExists
  | RelationPinToDraft
  | ItemNotPublished
  | VersioningInUse
  | SingleRecordConflict
  | SingleRecordProtected
  | SidebarViewNotFound
  | SidebarViewProtected
  | DashboardNotFound
  | DashboardProtected
  | DashboardConflict
  | AnnotationNotFound
  | TaskStatusNotFound
  | TaskStatusNameConflict
  | TaskStatusInUse
  | TaskPriorityNotFound
  | TaskPriorityNameConflict
  | TaskPriorityInUse
  | AnnotationFieldNotFound
  | AnnotationFieldNameConflict
  | AnnotationFieldConfigInvalid
  | AutomationNotFound
  | AutomationInvalid
