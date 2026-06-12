// Pure core

export { BlobError, BlobStore, type BlobStoreApi } from "./blob/BlobStore"
export { LocalFsBlobStore } from "./blob/local"
export {
  DEFAULT_DECAY_BANDS,
  type DecayBand,
  type DecayParams,
  type DecayResult,
  decay,
} from "./computed/decay"
export {
  DEFAULT_WINDOW_DAYS,
  type MomentumLabel,
  type MomentumParams,
  type MomentumResult,
  momentum,
} from "./computed/momentum"
export {
  deriveRichText,
  isRichText,
  MAX_RICHTEXT_CHARS,
  type RichTextValue,
  richTextWalk,
} from "./domain/richtext"
export * from "./domain/types"
export * from "./errors"
export { EngineLive, type EngineServices } from "./layers"
export { foldEvents, foldUntil } from "./projection/fold"
export { applyEvent, type FoldState } from "./projection/reducer"
export {
  type AddAnnotationFieldInput,
  AnnotationFieldService,
} from "./services/AnnotationFieldService"
export { AnnotationService, type ListTasksFilter } from "./services/AnnotationService"
export { AttachmentService, type UploadInput } from "./services/AttachmentService"
export { ComputedFields } from "./services/ComputedFields"
export { ConceptService } from "./services/ConceptService"
export { DashboardService } from "./services/DashboardService"
export {
  type AppendInput,
  EVENT_CHANNEL,
  type EventEnvelope,
  EventStore,
} from "./services/EventStore"
export { type AddFieldInput, FieldService } from "./services/FieldService"
export {
  type GraphLayoutPositions,
  GraphLayoutService,
} from "./services/GraphLayoutService"
export { InstanceService } from "./services/InstanceService"
export { LabelService } from "./services/LabelService"
export { MemberService } from "./services/MemberService"
// Services
export { OrgContext, type OrgScope } from "./services/OrgContext"
export { type FindInstancesInput, QueryService } from "./services/QueryService"
export { type CreateRelationInput, RelationService } from "./services/RelationService"
export { SidebarViewService } from "./services/SidebarViewService"
// Infrastructure
export { healthCheck, PgLive } from "./services/Sql"
export { TaskPriorityService, type TaskPrioritySpec } from "./services/TaskPriorityService"
export { TaskStatusService, type TaskStatusSpec } from "./services/TaskStatusService"
