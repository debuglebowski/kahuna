/**
 * Grouping for the dashboards management list. Pure (no React) so the tree shape
 * is unit-testable. The "usage" forest nests each referenced record dashboard
 * beneath every dashboard that uses it (via a list/kanban widget's
 * `recordDashboardId`); a dashboard used by several parents appears under each.
 */

export type DashboardGrouping = "none" | "type" | "usage"

export interface UsageNode {
  readonly id: string
  /** Referenced dashboards, nested. Empty for a leaf. */
  readonly children: ReadonlyArray<UsageNode>
}

/** Safety cap on nesting depth — references form a DAG (a node can have several
 *  parents → duplication), so a pathological graph could blow up; stop well past
 *  any real depth. */
const MAX_DEPTH = 12

/**
 * Build the usage forest from `{ id, refs }` items (refs = the record dashboards
 * that item uses). Roots = dashboards NOT referenced by any other (shown at the
 * top); everything referenced appears beneath each referencer. Dangling refs
 * (to ids not in the set) and self-refs are dropped; cycles are broken along the
 * current path so a reference loop can't recurse forever.
 */
export const buildUsageForest = (
  items: ReadonlyArray<{ readonly id: string; readonly refs: ReadonlyArray<string> }>,
): UsageNode[] => {
  const ids = new Set(items.map((i) => i.id))
  const refsById = new Map<string, string[]>(
    items.map((i) => [i.id, [...new Set(i.refs)].filter((r) => r !== i.id && ids.has(r))]),
  )
  const referenced = new Set<string>()
  for (const refs of refsById.values()) for (const r of refs) referenced.add(r)

  const build = (id: string, path: ReadonlySet<string>, depth: number): UsageNode => {
    if (depth >= MAX_DEPTH) return { id, children: [] }
    const next = new Set([...path, id])
    const children = (refsById.get(id) ?? [])
      .filter((c) => !path.has(c))
      .map((c) => build(c, next, depth + 1))
    return { id, children }
  }

  const forest = items.filter((i) => !referenced.has(i.id)).map((i) => build(i.id, new Set(), 0))
  // Cycle safety: items reachable only through a reference cycle have no root, so
  // they'd vanish. Surface any item missing from the forest as its own root.
  const seen = new Set<string>()
  const collect = (n: UsageNode) => {
    seen.add(n.id)
    n.children.forEach(collect)
  }
  forest.forEach(collect)
  for (const i of items) {
    if (seen.has(i.id)) continue
    const node = build(i.id, new Set(), 0)
    forest.push(node)
    collect(node)
  }
  return forest
}
