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

export class FieldValidationError extends Schema.TaggedError<FieldValidationError>()(
  "FieldValidationError",
  { message: Schema.String, field: Schema.optional(Schema.String) },
) {}

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

export type EngineError =
  | VersionConflict
  | InstanceNotFound
  | ConceptNotFound
  | ConceptNameConflict
  | FieldConfigInvalid
  | FieldNameConflict
  | FieldValidationError
  | IllegalTransition
  | RelationTargetMismatch
  | RelationNotFound
  | OrgScopeViolation
  | AttachmentNotFound
  | EventCorruption
