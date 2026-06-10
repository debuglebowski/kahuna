import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import {
  type DashboardBody,
  type FieldConfig,
  type FieldKind,
  type GraphLayout,
  KingsmakerRpcs,
  type SidebarViewBody,
} from "../../rpc/contract"

export type {
  AnnotationField,
  AnnotationType,
  Attachment,
  Concept,
  ConceptGraph,
  ConceptGraphEdge,
  ConceptGraphNode,
  Dashboard,
  DashboardBody,
  DashboardWidget,
  FeedItem,
  Field,
  FieldConfig,
  FieldKind,
  GraphLayout,
  Instance,
  InstanceDetail,
  InstancePick,
  Item,
  Label,
  Note,
  RelatedInstance,
  Relation,
  SidebarCondition,
  SidebarMember,
  SidebarRule,
  SidebarSection,
  SidebarSource,
  SidebarView,
  SidebarViewBody,
  Task,
  TaskStatus,
  TaskStatusCategory,
  VersionStatus,
} from "../../rpc/contract"

/** Computed-field shapes (carried inside an instance's `state`). */
export interface DecayValue {
  readonly days: number | null
  readonly band: "fresh" | "warm" | "cooling" | "cold"
}
export interface MomentumValue {
  readonly label: "heating" | "steady" | "cooling"
  readonly recent: number
  readonly prior: number
}

// Build the RPC client once: fetch transport + ndjson, pointed at /api/rpc.
const ProtocolLive = RpcClient.layerProtocolHttp({ url: "/api/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
)

const makeClient = RpcClient.make(KingsmakerRpcs)
type Client = Effect.Effect.Success<typeof makeClient>

class ApiClient extends Context.Tag("kingsmaker/ApiClient")<ApiClient, Client>() {}

const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)

const call = <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(ApiClient, f))

type Fields = Record<string, unknown>

/** Typed, end-to-end client — replaces the old hand-written fetch wrappers. */
export const api = {
  listConcepts: (opts?: { includeArchived?: boolean; withCounts?: boolean }) =>
    call((c) =>
      c.listConcepts({ includeArchived: opts?.includeArchived, withCounts: opts?.withCounts }),
    ),
  createConcept: (name: string) => call((c) => c.createConcept({ name })),
  updateConcept: (
    id: string,
    patch: {
      name?: string
      pluralName?: string | null
      description: string | null
      icon?: string | null
      versioningEnabled?: boolean
      staticLabelIds?: ReadonlyArray<string>
      defaultLabelIds?: ReadonlyArray<string>
    },
  ) =>
    call((c) =>
      c.updateConcept({
        id,
        name: patch.name,
        pluralName: patch.pluralName,
        description: patch.description,
        icon: patch.icon,
        versioningEnabled: patch.versioningEnabled,
        staticLabelIds: patch.staticLabelIds,
        defaultLabelIds: patch.defaultLabelIds,
      }),
    ),
  archiveConcept: (id: string) => call((c) => c.archiveConcept({ id })),
  restoreConcept: (id: string) => call((c) => c.restoreConcept({ id })),
  deleteConcept: (id: string) => call((c) => c.deleteConcept({ id })),
  listLabels: (opts?: { includeArchived?: boolean }) =>
    call((c) => c.listLabels({ includeArchived: opts?.includeArchived })),
  createLabel: (name: string, color?: string | null, primary?: boolean) =>
    call((c) => c.createLabel({ name, color, primary })),
  renameLabel: (id: string, patch: { name?: string; color?: string | null; primary?: boolean }) =>
    call((c) =>
      c.renameLabel({ id, name: patch.name, color: patch.color, primary: patch.primary }),
    ),
  archiveLabel: (id: string) => call((c) => c.archiveLabel({ id })),
  restoreLabel: (id: string) => call((c) => c.restoreLabel({ id })),
  deleteLabel: (id: string) => call((c) => c.deleteLabel({ id })),
  listFields: (conceptId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listFields({ conceptId, includeArchived: opts?.includeArchived })),
  getConceptGraph: () => call((c) => c.getConceptGraph()),
  getGraphLayout: () => call((c) => c.getGraphLayout()),
  saveGraphLayout: (positions: GraphLayout) => call((c) => c.saveGraphLayout({ positions })),
  addField: (input: {
    conceptId: string
    name: string
    kind: FieldKind
    config?: FieldConfig
    formula?: string
    icon?: string | null
  }) => call((c) => c.addField(input)),
  updateField: (input: {
    id: string
    name?: string
    config?: FieldConfig
    formula?: string | null
    icon?: string | null
  }) => call((c) => c.updateField(input)),
  archiveField: (id: string) => call((c) => c.archiveField({ id })),
  restoreField: (id: string) => call((c) => c.restoreField({ id })),
  deleteField: (id: string) => call((c) => c.deleteField({ id })),
  reorderFields: (conceptId: string, orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderFields({ conceptId, orders })),
  listInstances: (conceptId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listInstances({ conceptId, includeArchived: opts?.includeArchived })),
  getInstance: (id: string) => call((c) => c.getInstance({ id })),
  getChanged: () => call((c) => c.getChanged()),
  createInstance: (conceptId: string, fields: Fields) =>
    call((c) => c.createInstance({ conceptId, fields })),
  updateInstance: (id: string, expectedVersion: number, patch: Fields) =>
    call((c) => c.updateInstance({ id, expectedVersion, patch })),
  transitionInstance: (id: string, expectedVersion: number, field: string, to: string) =>
    call((c) => c.transitionInstance({ id, expectedVersion, field, to })),
  archiveInstance: (id: string, expectedVersion: number) =>
    call((c) => c.archiveInstance({ id, expectedVersion })),
  restoreInstance: (id: string, expectedVersion: number) =>
    call((c) => c.restoreInstance({ id, expectedVersion })),
  deleteInstance: (id: string) => call((c) => c.deleteInstance({ id })),
  // ── versioning ──────────────────────────────────────────────────────────────
  listVersions: (itemId: string) => call((c) => c.listVersions({ itemId })),
  newVersion: (itemId: string) => call((c) => c.newVersion({ itemId })),
  publishVersion: (id: string, expectedVersion: number) =>
    call((c) => c.publishVersion({ id, expectedVersion })),
  discardDraft: (id: string) => call((c) => c.discardDraft({ id })),
  archiveItem: (itemId: string) => call((c) => c.archiveItem({ itemId })),
  restoreItem: (itemId: string) => call((c) => c.restoreItem({ itemId })),
  searchInstances: (conceptId: string, query?: string, limit?: number) =>
    call((c) => c.searchInstances({ conceptId, query, limit })),
  createRelation: (input: {
    fieldId: string
    fromId: string
    toItemId?: string
    toVersionId?: string
    toId?: string
    properties?: Fields
  }) => call((c) => c.createRelation(input)),
  removeRelation: (relationId: string) => call((c) => c.removeRelation({ relationId })),
  listViews: () => call((c) => c.listViews()),
  createView: (input: {
    name: string
    icon?: string | null
    scope: "personal" | "org"
    body: SidebarViewBody
  }) => call((c) => c.createView(input)),
  updateView: (input: {
    id: string
    name?: string
    icon?: string | null
    hidden?: boolean
    scope?: "personal" | "org"
    body?: SidebarViewBody
  }) => call((c) => c.updateView(input)),
  deleteView: (id: string) => call((c) => c.deleteView({ id })),
  reorderViews: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderViews({ orders })),
  listDashboards: () => call((c) => c.listDashboards()),
  createDashboard: (input: {
    name: string
    icon?: string | null
    scope: "personal" | "org"
    body: DashboardBody
  }) => call((c) => c.createDashboard(input)),
  updateDashboard: (input: {
    id: string
    name?: string
    icon?: string | null
    hidden?: boolean
    scope?: "personal" | "org"
    body?: DashboardBody
  }) => call((c) => c.updateDashboard(input)),
  deleteDashboard: (id: string) => call((c) => c.deleteDashboard({ id })),
  reorderDashboards: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderDashboards({ orders })),
  // ── annotation layer: notes ───────────────────────────────────────────────────
  listNotes: (subjectId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listNotes({ subjectId, includeArchived: opts?.includeArchived })),
  createNote: (subjectId: string | null, body: string, customFields?: Fields) =>
    call((c) => c.createNote({ subjectId, body, customFields })),
  updateNote: (
    id: string,
    expectedVersion: number,
    patch: { body?: string; customFields?: Fields },
  ) => call((c) => c.updateNote({ id, expectedVersion, ...patch })),
  archiveNote: (id: string, expectedVersion: number) =>
    call((c) => c.archiveNote({ id, expectedVersion })),
  restoreNote: (id: string, expectedVersion: number) =>
    call((c) => c.restoreNote({ id, expectedVersion })),
  deleteNote: (id: string) => call((c) => c.deleteNote({ id })),
  // ── annotation layer: tasks ───────────────────────────────────────────────────
  listTasks: (filter?: {
    subjectId?: string | null
    assignee?: string
    statusId?: string
    dueBefore?: string
    dueAfter?: string
    includeArchived?: boolean
    limit?: number
  }) => call((c) => c.listTasks(filter ?? {})),
  createTask: (input: {
    subjectId: string | null
    title: string
    statusId?: string | null
    assignee?: string | null
    dueAt?: string | null
    customFields?: Fields
  }) => call((c) => c.createTask(input)),
  updateTask: (
    id: string,
    expectedVersion: number,
    patch: { title?: string; dueAt?: string | null; customFields?: Fields },
  ) => call((c) => c.updateTask({ id, expectedVersion, ...patch })),
  setTaskStatus: (id: string, expectedVersion: number, statusId: string) =>
    call((c) => c.setTaskStatus({ id, expectedVersion, statusId })),
  assignTask: (id: string, expectedVersion: number, assignee: string | null) =>
    call((c) => c.assignTask({ id, expectedVersion, assignee })),
  archiveTask: (id: string, expectedVersion: number) =>
    call((c) => c.archiveTask({ id, expectedVersion })),
  restoreTask: (id: string, expectedVersion: number) =>
    call((c) => c.restoreTask({ id, expectedVersion })),
  deleteTask: (id: string) => call((c) => c.deleteTask({ id })),
  getActivity: (subjectId: string, limit?: number) =>
    call((c) => c.getActivity({ subjectId, limit })),
  // ── annotation layer: task statuses (admin) ───────────────────────────────────
  listTaskStatuses: (opts?: { includeArchived?: boolean }) =>
    call((c) => c.listTaskStatuses({ includeArchived: opts?.includeArchived })),
  createTaskStatus: (input: {
    name: string
    category: "todo" | "active" | "done"
    color?: string | null
    isDefault?: boolean
  }) => call((c) => c.createTaskStatus(input)),
  updateTaskStatus: (input: {
    id: string
    name?: string
    color?: string | null
    category?: "todo" | "active" | "done"
    isDefault?: boolean
  }) => call((c) => c.updateTaskStatus(input)),
  archiveTaskStatus: (id: string) => call((c) => c.archiveTaskStatus({ id })),
  restoreTaskStatus: (id: string) => call((c) => c.restoreTaskStatus({ id })),
  reorderTaskStatuses: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderTaskStatuses({ orders })),
  // ── annotation layer: custom-field definitions (admin) ─────────────────────────
  listAnnotationFields: (annotationType: "note" | "task", opts?: { includeArchived?: boolean }) =>
    call((c) => c.listAnnotationFields({ annotationType, includeArchived: opts?.includeArchived })),
  addAnnotationField: (input: {
    annotationType: "note" | "task"
    name: string
    kind: FieldKind
    config?: FieldConfig
    icon?: string | null
  }) => call((c) => c.addAnnotationField(input)),
  updateAnnotationField: (input: {
    id: string
    name?: string
    config?: FieldConfig
    icon?: string | null
  }) => call((c) => c.updateAnnotationField(input)),
  archiveAnnotationField: (id: string) => call((c) => c.archiveAnnotationField({ id })),
  restoreAnnotationField: (id: string) => call((c) => c.restoreAnnotationField({ id })),
  reorderAnnotationFields: (
    annotationType: "note" | "task",
    orders: ReadonlyArray<{ id: string; position: number }>,
  ) => call((c) => c.reorderAnnotationFields({ annotationType, orders })),
}
