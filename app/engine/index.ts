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
  ACCESS_ACTIONS,
  ACTION_ALL,
  type AccessAction,
  type AccessCondition,
  type AccessResource,
  type AccessResourceType,
  type AccessRule,
  decide,
  decideRecord,
  type ExplainLayer,
  type ExplainResult,
  emptyPolicy,
  explainDecision,
  LAYER_0_PRECEDENCE,
  layer0Rules,
  matchesCondition,
  type PolicySet,
  recordRulesForConcept,
  rulesFor,
  tiersOf,
  unrestrictedPolicy,
} from "./domain/access"
export {
  type CompiledFilter,
  compileRecordFilter,
  filterFragment,
} from "./domain/accessSql"
export {
  extractMentions,
  MAX_MENTIONS_PER_DOC,
  MENTION_KINDS,
  type MentionKind,
  type MentionRef as MentionTargetRef,
} from "./domain/mentions"
export {
  deriveRichText,
  isRichText,
  MAX_RICHTEXT_CHARS,
  type RichTextValue,
  richTextWalk,
} from "./domain/richtext"
export * from "./domain/types"
export {
  canReadConcept,
  canReadRestricted,
  hiddenFieldIds,
  projectState,
  scopeCanReadConcept,
  scopeHiddenFieldIds,
} from "./domain/visibility"
export * from "./errors"
export { EngineLive, type EngineServices } from "./layers"
export { foldEvents, foldUntil } from "./projection/fold"
export { applyEvent, type FoldState } from "./projection/reducer"
export {
  type AccessDefault,
  AccessDefaultsService,
  TEMPLATED_TYPES,
} from "./services/AccessDefaultsService"
export { type AccessRole, AccessRoleService, BUILTIN_ROLES } from "./services/AccessRoleService"
export {
  type AddAnnotationFieldInput,
  AnnotationFieldService,
} from "./services/AnnotationFieldService"
export { AnnotationService, type ListTasksFilter } from "./services/AnnotationService"
export {
  AttachmentService,
  type ListFilesFilter,
  MAX_UPLOAD_BYTES,
  type UploadInput,
  type UploadOwner,
} from "./services/AttachmentService"
export {
  AutomationService,
  nextRunAfter,
  RATE_CAP_PER_MIN,
} from "./services/AutomationService"
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
export { LabelService } from "./services/LabelService"
export { MemberService } from "./services/MemberService"
export { type Backlink, MentionService } from "./services/MentionService"
// Services
export { OrgContext, type OrgScope, type ScopeRole } from "./services/OrgContext"
export { PolicyService } from "./services/PolicyService"
export { type FindRecordsInput, QueryService } from "./services/QueryService"
export { RecordService } from "./services/RecordService"
export { type CreateRelationInput, RelationService } from "./services/RelationService"
// `toVisibility` only: the rest of rows.ts is row-mapping internals.
export { toVisibility } from "./services/rows"
export { SidebarViewService } from "./services/SidebarViewService"
// Infrastructure
export { healthCheck, PgLive } from "./services/Sql"
export { TaskPriorityService, type TaskPrioritySpec } from "./services/TaskPriorityService"
export { TaskStatusService, type TaskStatusSpec } from "./services/TaskStatusService"
