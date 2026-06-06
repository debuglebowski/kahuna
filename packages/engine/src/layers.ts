import { Layer } from "effect"
import { ComputedFields } from "./services/ComputedFields"
import { ConceptService } from "./services/ConceptService"
import { EventStore } from "./services/EventStore"
import { FieldService } from "./services/FieldService"
import { InstanceService } from "./services/InstanceService"
import { QueryService } from "./services/QueryService"
import { RelationService } from "./services/RelationService"

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
