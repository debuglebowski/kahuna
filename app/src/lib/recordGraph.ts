/**
 * Record version relationship graph: BFS over relation edges from a seed record version.
 * Pure — the caller supplies `fetchRelated`, so traversal is testable without
 * the network. Nodes are keyed by item id (lineage), so a "Latest" ref and a
 * pinned ref to the same item collapse into one node. Dangling refs (archived
 * or unpublished targets) become non-expandable ghost leaves.
 */

export interface RecordGraphConfig {
  /** Relation field ids the walk may traverse; null = all. */
  readonly fieldIds: ReadonlyArray<string> | null
  /** Max hops from the seed (1 = direct neighbours only). */
  readonly depth: number
  /** A `LayoutKind` key — kept as a plain string for prefs round-tripping. */
  readonly layout: string
}

export const DEFAULT_GRAPH_CONFIG: RecordGraphConfig = {
  fieldIds: null,
  depth: 2,
  layout: "dagre-tb",
}

export const GRAPH_NODE_CAP = 120

/** The slice of `RelatedRecord` the traversal reads (structural, so tests
 *  don't have to fabricate full record versions). */
export interface RelatedEdge {
  readonly relationId: string
  readonly fieldId: string
  readonly relationName: string
  readonly label: string
  readonly direction: "out" | "in"
  readonly conceptId: string
  readonly conceptName: string
  readonly pinned: boolean
  readonly recordVersion: { readonly id: string; readonly recordId: string } | null
}

export interface GraphSeed {
  readonly recordId: string
  readonly recordVersionId: string
  readonly label: string
  readonly conceptId: string
  readonly conceptName: string
}

export interface RecordGraphNode {
  /** Item id, or `ghost:<relationId>` for dangling refs. */
  readonly id: string
  /** Resolved record version for navigation/expansion; null on ghosts. */
  readonly recordVersionId: string | null
  readonly label: string
  readonly conceptId: string
  readonly conceptName: string
  readonly depth: number
  readonly root: boolean
  readonly ghost: boolean
}

export interface RecordGraphEdge {
  /** Relation id — stable across re-traversal from either endpoint. */
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label: string
  readonly fieldId: string
  readonly pinned: boolean
}

export interface RecordGraph {
  readonly nodes: RecordGraphNode[]
  readonly edges: RecordGraphEdge[]
  /** True when the node cap stopped the walk before it ran dry. */
  readonly truncated: boolean
}

export async function buildRecordGraph(
  seed: GraphSeed,
  fetchRelated: (recordVersionId: string) => Promise<ReadonlyArray<RelatedEdge>>,
  cfg: RecordGraphConfig,
  cap: number = GRAPH_NODE_CAP,
): Promise<RecordGraph> {
  const allowed = cfg.fieldIds === null ? null : new Set(cfg.fieldIds)
  const nodes = new Map<string, RecordGraphNode>()
  const edges = new Map<string, RecordGraphEdge>()
  let truncated = false

  const root: RecordGraphNode = {
    id: seed.recordId,
    recordVersionId: seed.recordVersionId,
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
  let frontier: RecordGraphNode[] = [root]
  const expanded = new Set<string>()

  for (let depth = 0; depth < cfg.depth && frontier.length > 0; depth++) {
    const toExpand = frontier.filter((n) => !n.ghost && n.recordVersionId && !expanded.has(n.id))
    for (const n of toExpand) expanded.add(n.id)
    const related = await Promise.all(toExpand.map((n) => fetchRelated(n.recordVersionId!)))

    const next: RecordGraphNode[] = []
    toExpand.forEach((from, i) => {
      for (const r of related[i]!) {
        if (allowed && !allowed.has(r.fieldId)) continue

        const neighborId = r.recordVersion ? r.recordVersion.recordId : `ghost:${r.relationId}`
        let neighbor = nodes.get(neighborId)
        if (!neighbor) {
          if (nodes.size >= cap) {
            truncated = true
            continue
          }
          neighbor = {
            id: neighborId,
            recordVersionId: r.recordVersion?.id ?? null,
            label: r.label,
            conceptId: r.conceptId,
            conceptName: r.conceptName,
            depth: depth + 1,
            root: false,
            ghost: r.recordVersion === null,
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
