import "@xyflow/react/dist/style.css"
import Dagre from "@dagrejs/dagre"
import { useQuery } from "@tanstack/react-query"
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react"
import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { Card, Spinner } from "../../components/ui"
import { api, type ConceptGraph } from "../../lib/api"

const NODE_W = 168
const NODE_H = 44

/** Concept box. Click navigates to that concept's instance browser. */
function ConceptNode({ data }: NodeProps) {
  return (
    <div className="cursor-pointer rounded-lg border border-gray-300 bg-white px-4 py-2 text-center text-sm font-medium text-gray-800 shadow-sm hover:border-gray-500">
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-gray-300" />
      {(data as { label: string }).label}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-gray-300"
      />
    </div>
  )
}

/** A relation pointing back at its own concept — drawn as a loop above the node. */
function SelfLoopEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  markerEnd,
  style,
}: EdgeProps) {
  const path = `M ${sourceX} ${sourceY} C ${sourceX + 70} ${sourceY - 80}, ${targetX - 70} ${targetY - 80}, ${targetX} ${targetY}`
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${Math.min(sourceY, targetY) - 64}px)`,
            }}
            className="pointer-events-none absolute rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const nodeTypes = { concept: ConceptNode }
const edgeTypes = { selfloop: SelfLoopEdge }

/** Project the concept graph into laid-out React Flow nodes + edges (dagre LR). */
function buildFlow(graph: ConceptGraph): { nodes: Node[]; edges: Edge[] } {
  // Collapse multiple relation fields with the same direction into one labelled edge.
  const merged = new Map<string, { from: string; to: string; labels: Set<string> }>()
  for (const e of graph.edges) {
    const key = `${e.from}->${e.to}`
    const m = merged.get(key) ?? { from: e.from, to: e.to, labels: new Set<string>() }
    m.labels.add(e.relationType)
    merged.set(key, m)
  }

  const edges: Edge[] = [...merged.values()].map((m) => ({
    id: `${m.from}->${m.to}`,
    source: m.from,
    target: m.to,
    type: m.from === m.to ? "selfloop" : "default",
    label: [...m.labels].join(", "),
    labelStyle: { fontSize: 11, fill: "#4b5563" },
    labelBgStyle: { fill: "#ffffff" },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#9ca3af" },
    style: { stroke: "#9ca3af", strokeWidth: 1.5 },
  }))

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90 })
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target)
  Dagre.layout(g)

  const nodes: Node[] = graph.nodes.map((n) => {
    const p = g.node(n.id)
    return {
      id: n.id,
      type: "concept",
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: { label: n.name },
    }
  })

  return { nodes, edges }
}

/** Interactive canvas — separated so its layout is computed once per data load. */
function Flow({ graph }: { graph: ConceptGraph }) {
  const navigate = useNavigate()
  const initial = useMemo(() => buildFlow(graph), [graph])
  const [nodes, , onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={(_, node) => navigate(`/concepts/${node.id}`)}
      nodesConnectable={false}
      minZoom={0.2}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Background color="#e5e7eb" gap={20} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  )
}

/** Settings → Concepts graph: concepts as nodes, relation fields as edges. */
export function ConceptsGraph() {
  const graph = useQuery({ queryKey: ["conceptGraph"], queryFn: () => api.getConceptGraph() })

  if (graph.isPending) return <Spinner />
  if (graph.error)
    return (
      <Card>
        <div className="p-6 text-sm text-red-600">Failed to load the concept graph.</div>
      </Card>
    )
  if (graph.data.nodes.length === 0)
    return (
      <Card>
        <div className="p-6 text-sm text-gray-400">
          No concepts yet. Create concepts and add relation fields to see the graph.
        </div>
      </Card>
    )

  // Re-mount Flow (re-running layout) only when the underlying graph changes.
  const sig = `${graph.data.nodes.map((n) => n.id).join()}|${graph.data.edges.map((e) => e.id).join()}`

  return (
    <div className="space-y-3">
      {graph.data.edges.length === 0 && (
        <p className="text-sm text-gray-400">
          No relationships yet — add relation fields to your concepts (Settings → Concepts) to
          connect them.
        </p>
      )}
      <Card className="h-[70vh] w-full overflow-hidden">
        <Flow key={sig} graph={graph.data} />
      </Card>
    </div>
  )
}
