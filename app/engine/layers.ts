import { Layer } from "effect"
import { AccessRoleService } from "./services/AccessRoleService"
import { AnnotationFieldService } from "./services/AnnotationFieldService"
import { AnnotationService } from "./services/AnnotationService"
import { AttachmentService } from "./services/AttachmentService"
import { AutomationService } from "./services/AutomationService"
import { ComputedFields } from "./services/ComputedFields"
import { ConceptService } from "./services/ConceptService"
import { DashboardService } from "./services/DashboardService"
import { EventStore } from "./services/EventStore"
import { FieldService } from "./services/FieldService"
import { GraphLayoutService } from "./services/GraphLayoutService"
import { InstanceService } from "./services/InstanceService"
import { LabelService } from "./services/LabelService"
import { MemberService } from "./services/MemberService"
import { PolicyService } from "./services/PolicyService"
import { QueryService } from "./services/QueryService"
import { RelationService } from "./services/RelationService"
import { SidebarViewService } from "./services/SidebarViewService"
import { TaskPriorityService } from "./services/TaskPriorityService"
import { TaskStatusService } from "./services/TaskStatusService"

/**
 * All engine services merged. Requires a `PgClient` layer (e.g. `PgLive`) and a
 * per-request `OrgContext`, both provided at the boundary.
 */
export const EngineLive = Layer.mergeAll(
  EventStore.Default,
  ConceptService.Default,
  FieldService.Default,
  InstanceService.Default,
  RelationService.Default,
  QueryService.Default,
  ComputedFields.Default,
  AttachmentService.Default,
  LabelService.Default,
  MemberService.Default,
  PolicyService.Default,
  AccessRoleService.Default,
  SidebarViewService.Default,
  DashboardService.Default,
  GraphLayoutService.Default,
  TaskStatusService.Default,
  TaskPriorityService.Default,
  AnnotationFieldService.Default,
  AnnotationService.Default,
  AutomationService.Default,
)

/** Union of all engine service tags — the requirements an engine effect may carry. */
export type EngineServices =
  | EventStore
  | ConceptService
  | FieldService
  | InstanceService
  | RelationService
  | QueryService
  | ComputedFields
  | AttachmentService
  | LabelService
  | MemberService
  | PolicyService
  | AccessRoleService
  | SidebarViewService
  | DashboardService
  | GraphLayoutService
  | TaskStatusService
  | TaskPriorityService
  | AnnotationFieldService
  | AnnotationService
  | AutomationService
