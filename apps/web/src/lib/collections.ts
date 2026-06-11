import { createCollection } from "@tanstack/db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { useEffect } from "react"
import type {
  AnnotationField,
  AnnotationType,
  Concept,
  FeedItem,
  Instance,
  InstanceDetail,
  Note,
  SidebarView,
  Task,
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

// ── lazy, per-scope collections (memoised so the instance is stable) ───────────

const conceptCollections = new Map<string, ReturnType<typeof makeConcept>>()
const makeConcept = (conceptId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "instances", conceptId],
      queryFn: async (): Promise<Instance[]> => [...(await api.listInstances(conceptId))],
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
