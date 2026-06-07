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
  readonly concept: string | null
}

export const KEY = {
  concepts: "concepts",
  owed: "owed",
  changed: "changed",
  demand: "demand",
  instances: (concept: string) => `instances:${concept}`,
} as const

/**
 * Returns the subset of collection keys to refetch for this envelope, filtered
 * to those actually mounted. Every event also nudges the `changed` feed.
 */
export const routeEnvelope = (env: LiveEnvelope, mounted: ReadonlyArray<string>): string[] => {
  const candidates = new Set<string>([KEY.changed])

  if (env.kind === "concept" || env.kind === "field") {
    candidates.add(KEY.concepts)
  } else if (env.kind === "relation") {
    // Relations feed the dashboard aggregates (e.g. Signal -from-> account → demand).
    candidates.add(KEY.owed)
    candidates.add(KEY.demand)
  } else {
    // instance — keep the dashboard's owed/demand aggregates live.
    const c = env.concept
    if (c === "Deal" || c === "Task") candidates.add(KEY.owed)
    else if (c === "Signal") candidates.add(KEY.demand)
    if (c) candidates.add(KEY.instances(c))
  }

  const mountedSet = new Set(mounted)
  return [...candidates].filter((k) => mountedSet.has(k))
}
