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

export class EventCorruption extends Schema.TaggedError<EventCorruption>()("EventCorruption", {
  reason: Schema.String,
  eventId: Schema.Number,
}) {}

export class SidebarViewNotFound extends Schema.TaggedError<SidebarViewNotFound>()(
  "SidebarViewNotFound",
  { id: Schema.String },
) {}

/** The last shared (Default) view can't be deleted — the list must never empty. */
export class SidebarViewProtected extends Schema.TaggedError<SidebarViewProtected>()(
  "SidebarViewProtected",
  { id: Schema.String },
) {}

export type EngineError =
  | VersionConflict
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
  | EventCorruption
  | SidebarViewNotFound
  | SidebarViewProtected
