/**
 * Pure routing for live-sync envelopes — no React / TanStack deps, fully
 * unit-testable. Maps an incoming SSE envelope to the collection keys that
 * should refetch, given which collections are currently mounted.
 *
 * The envelope is metadata only (mirrors the server's `EventEnvelope`); it is
 * never rendered, only used to decide what to re-read.
 */

export interface LiveEnvelope {
  readonly org: string
  readonly id: number
  readonly at: number
  readonly kind: "instance" | "relation" | "concept" | "field"
  readonly subjectId: string
  readonly type: string
  /** Concept id for instance events — routes to the id-keyed instance collection. */
  readonly conceptId: string | null
  /** Concept name for instance events — informational (mirrors the wire envelope). */
  readonly concept: string | null
}

export const KEY = {
  concepts: "concepts",
  changed: "changed",
  instances: (concept: string) => `instances:${concept}`,
  /** A single instance's detail view (its own data + connected instances). */
  detail: (id: string) => `detail:${id}`,
} as const

/**
 * Returns the subset of collection keys to refetch for this envelope, filtered
 * to those actually mounted. Every event also nudges the `changed` feed.
 */
export const routeEnvelope = (env: LiveEnvelope, mounted: ReadonlyArray<string>): string[] => {
  const candidates = new Set<string>([KEY.changed])

  // An open instance-detail page may show this subject — directly, as a connected
  // instance, or via a relation just added/removed — so any instance/relation event
  // nudges every mounted detail page (the envelope can't say which one is affected).
  const details = mounted.filter((k) => k.startsWith("detail:"))

  if (env.kind === "concept" || env.kind === "field") {
    candidates.add(KEY.concepts)
  } else if (env.kind === "relation") {
    // A relation change can affect any open detail page (connected instances).
    for (const k of details) candidates.add(k)
  } else {
    // instance — nudge its concept's list and any open detail pages.
    if (env.conceptId) candidates.add(KEY.instances(env.conceptId))
    for (const k of details) candidates.add(k)
  }

  const mountedSet = new Set(mounted)
  return [...candidates].filter((k) => mountedSet.has(k))
}
