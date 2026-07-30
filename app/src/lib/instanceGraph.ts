/**
 * Instance relationship graph: BFS over relation edges from a seed instance.
 * Pure — the caller supplies `fetchRelated`, so traversal is testable without
 * the network. Nodes are keyed by item id (lineage), so a "Latest" ref and a
 * pinned ref to the same item collapse into one node. Dangling refs (archived
 * or unpublished targets) become non-expandable ghost leaves.
 */

export interface InstanceGraphConfig {
  /** Relation field ids the walk may traverse; null = all. */
  readonly fieldIds: ReadonlyArray<string> | null
  /** Max hops from the seed (1 = direct neighbours only). */
  readonly depth: number
  /** A `LayoutKind` key — kept as a plain string for prefs round-tripping. */
  readonly layout: string
}

export const DEFAULT_GRAPH_CONFIG: InstanceGraphConfig = {
  fieldIds: null,
  depth: 2,
  layout: "dagre-tb",
}

export const GRAPH_NODE_CAP = 120

/** The slice of `RelatedInstance` the traversal reads (structural, so tests
 *  don't have to fabricate full instances). */
export interface RelatedEdge {
  readonly relationId: string
  readonly fieldId: string
  readonly relationName: string
  readonly label: string
  readonly direction: "out" | "in"
  readonly conceptId: string
  readonly conceptName: string
  readonly pinned: boolean
  readonly instance: { readonly id: string; readonly itemId: string } | null
}

export interface GraphSeed {
  readonly itemId: string
  readonly instanceId: string
  readonly label: string
  readonly conceptId: string
  readonly conceptName: string
}

export interface InstanceGraphNode {
  /** Item id, or `ghost:<relationId>` for dangling refs. */
  readonly id: string
  /** Resolved instance for navigation/expansion; null on ghosts. */
  readonly instanceId: string | null
  readonly label: string
  readonly conceptId: string
  readonly conceptName: string
  readonly depth: number
  readonly root: boolean
  readonly ghost: boolean
}

export interface InstanceGraphEdge {
  /** Relation id — stable across re-traversal from either endpoint. */
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label: string
  readonly fieldId: string
  readonly pinned: boolean
}

export interface InstanceGraph {
  readonly nodes: InstanceGraphNode[]
  readonly edges: InstanceGraphEdge[]
  /** True when the node cap stopped the walk before it ran dry. */
  readonly truncated: boolean
}

export async function buildInstanceGraph(
  seed: GraphSeed,
  fetchRelated: (instanceId: string) => Promise<ReadonlyArray<RelatedEdge>>,
  cfg: InstanceGraphConfig,
  cap: number = GRAPH_NODE_CAP,
): Promise<InstanceGraph> {
  const allowed = cfg.fieldIds === null ? null : new Set(cfg.fieldIds)
  const nodes = new Map<string, InstanceGraphNode>()
  const edges = new Map<string, InstanceGraphEdge>()
  let truncated = false

  const root: InstanceGraphNode = {
    id: seed.itemId,
    instanceId: seed.instanceId,
    label: seed.label,
    conceptId: seed.conceptId,
    conceptName: seed.conceptName,
    depth: 0,
    root: true,
    ghost: false,
  }
  nodes.set(root.id, root)

  // Level-synchronous BFS: each ring fetches in parallel; visited nodes are
  // never re-expanded, so cycles (A→B→A, self-loops) terminate by construction.
  let frontier: InstanceGraphNode[] = [root]
  const expanded = new Set<string>()

  for (let depth = 0; depth < cfg.depth && frontier.length > 0; depth++) {
    const toExpand = frontier.filter((n) => !n.ghost && n.instanceId && !expanded.has(n.id))
    for (const n of toExpand) expanded.add(n.id)
    const related = await Promise.all(toExpand.map((n) => fetchRelated(n.instanceId!)))

    const next: InstanceGraphNode[] = []
    toExpand.forEach((from, i) => {
      for (const r of related[i]!) {
        if (allowed && !allowed.has(r.fieldId)) continue

        const neighborId = r.instance ? r.instance.itemId : `ghost:${r.relationId}`
        let neighbor = nodes.get(neighborId)
        if (!neighbor) {
          if (nodes.size >= cap) {
            truncated = true
            continue
          }
          neighbor = {
            id: neighborId,
            instanceId: r.instance?.id ?? null,
            label: r.label,
            conceptId: r.conceptId,
            conceptName: r.conceptName,
            depth: depth + 1,
            root: false,
            ghost: r.instance === null,
          }
          nodes.set(neighborId, neighbor)
          next.push(neighbor)
        }

        if (!edges.has(r.relationId)) {
          const [source, target] =
            r.direction === "out" ? [from.id, neighborId] : [neighborId, from.id]
          edges.set(r.relationId, {
            id: r.relationId,
            source,
            target,
            label: r.relationName,
            fieldId: r.fieldId,
            pinned: r.pinned,
          })
        }
      }
    })
    frontier = next
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated }
}
