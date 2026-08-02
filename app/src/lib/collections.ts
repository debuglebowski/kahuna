import { createCollection } from "@tanstack/db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { useEffect } from "react"
import type {
  AnnotationField,
  AnnotationType,
  Attachment,
  Automation,
  AutomationRun,
  Concept,
  FeedItem,
  Instance,
  InstanceDetail,
  Note,
  SidebarView,
  Task,
  TaskPriority,
  TaskStatus,
} from "../../rpc/contract"
import { api } from "./api"
import { queryClient } from "./queryClient"

export { KEY } from "./routeEnvelope"

/**
 * TanStack DB query collections. Each wraps an existing `api.*` read (the
 * server stays the single source of truth — no client-side joins). The SSE
 * subscriber drives reactivity by calling a mounted collection's
 * `utils.refetch()`; pages read via `useLiveQuery`.
 *
 * Collections register themselves in a process-wide registry while a page that
 * shows them is mounted, so the stream only ever refetches what's on screen —
 * keeping the working set bounded.
 */

// ── registry (key -> refetch thunk) ───────────────────────────────────────────

// Refcounted: two mounted components may register the same key (e.g. the concept
// page and a dashboard loader for the same concept) — the key must stay live
// until the LAST registrant unmounts.
const registry = new Map<string, { count: number; refetch: () => Promise<unknown> }>()

export const mountedKeys = (): string[] => [...registry.keys()]

export const refetchKeys = async (keys: ReadonlyArray<string>): Promise<void> => {
  await Promise.all(keys.map((k) => registry.get(k)?.refetch()))
}

/** A collection exposing the query-collection refetch util. */
interface Refetchable {
  readonly status: string
  readonly utils: { readonly refetch: () => Promise<unknown> }
}

/** Register `collection` under `key` while the calling component is mounted. */
export function useRegisterCollection(key: string, collection: Refetchable): void {
  useEffect(() => {
    const entry = registry.get(key)
    if (entry) entry.count += 1
    else registry.set(key, { count: 1, refetch: () => collection.utils.refetch() })
    // The stream only refetches mounted keys, so an already-synced collection
    // may have missed events while no page showed it — catch up on (re)mount.
    // A fresh collection ("loading") is already fetching current data.
    if (collection.status === "ready") void collection.utils.refetch()
    return () => {
      const cur = registry.get(key)
      if (!cur) return
      cur.count -= 1
      if (cur.count <= 0) registry.delete(key)
    }
  }, [key, collection])
}

// ── global collections ────────────────────────────────────────────────────────

export const conceptsCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "concepts"],
    queryFn: async (): Promise<Concept[]> => [...(await api.listConcepts())],
    queryClient,
    getKey: (c: Concept) => c.id,
  }),
)

export const changedCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "changed"],
    queryFn: async (): Promise<FeedItem[]> => [...(await api.getChanged())],
    queryClient,
    getKey: (f: FeedItem) => f.id,
  }),
)

export const sidebarViewsCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "views"],
    queryFn: async (): Promise<SidebarView[]> => [...(await api.listViews())],
    queryClient,
    getKey: (v: SidebarView) => v.id,
  }),
)

/** A read the server refused because the caller may not see the concept (or it is
 *  genuinely gone). Both cases mean "render nothing", deliberately — telling a
 *  member the difference would confirm a restricted concept exists. */
const isNotFound = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "NOT_FOUND"

// ── lazy, per-scope collections (memoised so the instance is stable) ───────────

const conceptCollections = new Map<string, ReturnType<typeof makeConcept>>()
const makeConcept = (conceptId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "instances", conceptId],
      // A concept restricted to admins reads as NOT_FOUND for a member. Surface it
      // as EMPTY rather than an error: this collection backs every concept-scoped
      // widget, and a dashboard holding one widget for a restricted concept must
      // still render the rest of the board.
      queryFn: async (): Promise<Instance[]> => {
        try {
          return [...(await api.listInstances(conceptId))]
        } catch (e) {
          if (isNotFound(e)) return []
          throw e
        }
      },
      queryClient,
      getKey: (i: Instance) => i.id,
    }),
  )

export const instancesByConcept = (conceptId: string) => {
  let c = conceptCollections.get(conceptId)
  if (!c) {
    c = makeConcept(conceptId)
    conceptCollections.set(conceptId, c)
  }
  return c
}

// One instance's full detail (own data + connected instances) — a single-row
// collection per instance id, so the detail page reacts via the same registry.
const detailCollections = new Map<string, ReturnType<typeof makeDetail>>()
const makeDetail = (id: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "detail", id],
      queryFn: async (): Promise<Array<InstanceDetail & { id: string }>> => [
        { id, ...(await api.getInstance(id)) },
      ],
      queryClient,
      getKey: (d) => d.id,
    }),
  )

export const instanceDetail = (id: string) => {
  let c = detailCollections.get(id)
  if (!c) {
    c = makeDetail(id)
    detailCollections.set(id, c)
  }
  return c
}

// A single-record concept's one record, keyed by CONCEPT id — the same
// `InstanceDetail` shape `instanceDetail` yields, so `/c/<slug>` renders through
// the ordinary record view. Keyed by concept rather than instance because that's
// the only id the caller has: which instance is "the" record moves on every
// publish, and the server's `singleRecordOf` (not `listInstances[0]`) is what
// knows, including for a versioned concept whose record is still a draft.
const singleRecordCollections = new Map<string, ReturnType<typeof makeSingleRecord>>()
const makeSingleRecord = (conceptId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "singleRecord", conceptId],
      queryFn: async (): Promise<Array<InstanceDetail & { id: string }>> => {
        const d = await api.getSingleRecord(conceptId)
        // Null = the flag is on with no record behind it, which shouldn't happen.
        // An empty collection lets the page say so instead of spinning forever.
        return d ? [{ id: conceptId, ...d }] : []
      },
      queryClient,
      getKey: (d) => d.id,
    }),
  )

export const singleRecordOfConcept = (conceptId: string) => {
  let c = singleRecordCollections.get(conceptId)
  if (!c) {
    c = makeSingleRecord(conceptId)
    singleRecordCollections.set(conceptId, c)
  }
  return c
}

// ── annotation layer (per-item: subjectId = the item lineage id) ───────────────

const notesCollections = new Map<string, ReturnType<typeof makeNotes>>()
const makeNotes = (subjectId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "notes", subjectId],
      queryFn: async (): Promise<Note[]> => [...(await api.listNotes(subjectId))],
      queryClient,
      getKey: (n: Note) => n.id,
    }),
  )
export const notesBySubject = (subjectId: string) => {
  let c = notesCollections.get(subjectId)
  if (!c) {
    c = makeNotes(subjectId)
    notesCollections.set(subjectId, c)
  }
  return c
}

const tasksCollections = new Map<string, ReturnType<typeof makeTasks>>()
const makeTasks = (subjectId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "tasks", subjectId],
      queryFn: async (): Promise<Task[]> => [...(await api.listTasks({ subjectId }))],
      queryClient,
      getKey: (t: Task) => t.id,
    }),
  )
export const tasksBySubject = (subjectId: string) => {
  let c = tasksCollections.get(subjectId)
  if (!c) {
    c = makeTasks(subjectId)
    tasksCollections.set(subjectId, c)
  }
  return c
}

// Archived included: the Files panel's "show archived" toggle filters at read
// time (one fetch serves both views, like the panel's live/archived counts).
const filesCollections = new Map<string, ReturnType<typeof makeFiles>>()
const makeFiles = (subjectId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "files", subjectId],
      queryFn: async (): Promise<Attachment[]> => [
        ...(await api.listFiles({ itemId: subjectId, includeArchived: true })),
      ],
      queryClient,
      getKey: (a: Attachment) => a.id,
    }),
  )
export const filesBySubject = (subjectId: string) => {
  let c = filesCollections.get(subjectId)
  if (!c) {
    c = makeFiles(subjectId)
    filesCollections.set(subjectId, c)
  }
  return c
}

const activityCollections = new Map<string, ReturnType<typeof makeActivity>>()
const makeActivity = (subjectId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "activity", subjectId],
      queryFn: async (): Promise<FeedItem[]> => [...(await api.getActivity(subjectId))],
      queryClient,
      getKey: (f: FeedItem) => f.id,
    }),
  )
export const activityBySubject = (subjectId: string) => {
  let c = activityCollections.get(subjectId)
  if (!c) {
    c = makeActivity(subjectId)
    activityCollections.set(subjectId, c)
  }
  return c
}

// ── annotation layer (org-level) ───────────────────────────────────────────────

/** Org-wide task-status vocabulary (the picker + settings editor read this). */
export const taskStatusesCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "taskStatuses"],
    queryFn: async (): Promise<TaskStatus[]> => [...(await api.listTaskStatuses())],
    queryClient,
    getKey: (s: TaskStatus) => s.id,
  }),
)

/** Org-wide task-priority vocabulary (the picker + settings editor read this). */
export const taskPrioritiesCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "taskPriorities"],
    queryFn: async (): Promise<TaskPriority[]> => [...(await api.listTaskPriorities())],
    queryClient,
    getKey: (p: TaskPriority) => p.id,
  }),
)

/** Global "My Tasks" view — cross-item tasks (filter applied at read time). */
export const tasksGlobalCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "tasks", "global"],
    queryFn: async (): Promise<Task[]> => [...(await api.listTasks())],
    queryClient,
    getKey: (t: Task) => t.id,
  }),
)

const annotationFieldCollections = new Map<string, ReturnType<typeof makeAnnotationFields>>()
const makeAnnotationFields = (type: AnnotationType) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "annotationFields", type],
      queryFn: async (): Promise<AnnotationField[]> => [
        ...(await api.listAnnotationFields(type, { includeArchived: true })),
      ],
      queryClient,
      getKey: (f: AnnotationField) => f.id,
    }),
  )
export const annotationFieldsByType = (type: AnnotationType) => {
  let c = annotationFieldCollections.get(type)
  if (!c) {
    c = makeAnnotationFields(type)
    annotationFieldCollections.set(type, c)
  }
  return c
}

// ── automations ────────────────────────────────────────────────────────────────

/** Org-wide automations (the settings list + editor read this). Includes archived
 *  so the list can offer a restore, exactly like the concepts collection. */
export const automationsCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "automations"],
    queryFn: async (): Promise<Automation[]> => [
      ...(await api.listAutomations({ includeArchived: true })),
    ],
    queryClient,
    getKey: (a: Automation) => a.id,
  }),
)

// One run-history collection per automation, created on first use — the editor
// shows exactly one at a time, so this stays bounded in practice.
const automationRunCollections = new Map<string, ReturnType<typeof makeAutomationRuns>>()
const makeAutomationRuns = (automationId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "automationRuns", automationId],
      queryFn: async (): Promise<AutomationRun[]> => [
        ...(await api.listAutomationRuns(automationId, { limit: 20 })),
      ],
      queryClient,
      getKey: (r: AutomationRun) => r.id,
    }),
  )
export const automationRunsFor = (automationId: string) => {
  let c = automationRunCollections.get(automationId)
  if (!c) {
    c = makeAutomationRuns(automationId)
    automationRunCollections.set(automationId, c)
  }
  return c
}
