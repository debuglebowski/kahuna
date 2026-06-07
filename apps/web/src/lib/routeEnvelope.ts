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
  accounts: "accounts",
  owed: "owed",
  changed: "changed",
  demand: "demand",
  account: (id: string) => `account:${id}`,
  instances: (concept: string) => `instances:${concept}`,
} as const

const accountKeys = (mounted: ReadonlyArray<string>) =>
  mounted.filter((k) => k.startsWith("account:"))

/**
 * Returns the subset of collection keys to refetch for this envelope, filtered
 * to those actually mounted. Every event also nudges the `changed` feed.
 */
export const routeEnvelope = (env: LiveEnvelope, mounted: ReadonlyArray<string>): string[] => {
  const candidates = new Set<string>([KEY.changed])

  if (env.kind === "concept" || env.kind === "field") {
    candidates.add(KEY.concepts)
  } else if (env.kind === "relation") {
    // A relation binds a child to an account; the envelope lacks the account id,
    // so refetch the open hub(s) + the org-wide aggregations.
    candidates.add(KEY.owed)
    candidates.add(KEY.demand)
    for (const k of accountKeys(mounted)) candidates.add(k)
  } else {
    // instance
    const c = env.concept
    if (c === "Account") {
      candidates.add(KEY.accounts)
      candidates.add(KEY.owed)
      candidates.add(KEY.demand)
      candidates.add(KEY.account(env.subjectId))
    } else if (c === "Deal" || c === "Task") {
      candidates.add(KEY.owed)
      for (const k of accountKeys(mounted)) candidates.add(k)
    } else if (c === "Signal") {
      candidates.add(KEY.demand)
      for (const k of accountKeys(mounted)) candidates.add(k)
    } else if (c === "Interaction" || c === "Contact" || c === "TeamMember" || c === "Artifact") {
      for (const k of accountKeys(mounted)) candidates.add(k)
    }
    if (c) candidates.add(KEY.instances(c))
  }

  const mountedSet = new Set(mounted)
  return [...candidates].filter((k) => mountedSet.has(k))
}
