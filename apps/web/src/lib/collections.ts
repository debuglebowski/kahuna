import { createCollection } from "@tanstack/db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { useEffect } from "react"
import type { Concept, DemandItem, FeedItem, Instance, Owed } from "../../rpc/contract"
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

const registry = new Map<string, () => Promise<unknown>>()

export const mountedKeys = (): string[] => [...registry.keys()]

export const refetchKeys = async (keys: ReadonlyArray<string>): Promise<void> => {
  await Promise.all(keys.map((k) => registry.get(k)?.()))
}

/** A collection exposing the query-collection refetch util. */
interface Refetchable {
  readonly utils: { readonly refetch: () => Promise<unknown> }
}

/** Register `collection` under `key` while the calling component is mounted. */
export function useRegisterCollection(key: string, collection: Refetchable): void {
  useEffect(() => {
    registry.set(key, () => collection.utils.refetch())
    return () => {
      registry.delete(key)
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

export const demandCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "demand"],
    queryFn: async (): Promise<DemandItem[]> => [...(await api.getDemand())],
    queryClient,
    getKey: (d: DemandItem) => d.signal.id,
  }),
)

// `Owed` is one composite object — model it as a single-row collection.
export const owedCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["live", "owed"],
    queryFn: async (): Promise<Array<Owed & { id: string }>> => [
      { id: "owed", ...(await api.getOwed()) },
    ],
    queryClient,
    getKey: (o) => o.id,
  }),
)

// ── lazy, per-scope collections (memoised so the instance is stable) ───────────

const conceptCollections = new Map<string, ReturnType<typeof makeConcept>>()
const makeConcept = (name: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["live", "instances", name],
      queryFn: async (): Promise<Instance[]> => [...(await api.listInstances(name))],
      queryClient,
      getKey: (i: Instance) => i.id,
    }),
  )

export const instancesByConcept = (name: string) => {
  let c = conceptCollections.get(name)
  if (!c) {
    c = makeConcept(name)
    conceptCollections.set(name, c)
  }
  return c
}
