import "@xyflow/react/dist/style.css"
import Dagre from "@dagrejs/dagre"
import { useQuery } from "@tanstack/react-query"
import {
  Background,
  BaseEdge,
  ControlButton,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import { AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter } from "lucide-react"
import { useCallback, useEffect, useMemo } from "react"
import { Card, Spinner } from "../../components/ui"
import { api, type ConceptGraph } from "../../lib/api"
import { ConceptIcon } from "../../lib/icons"

const NODE_W = 168
const NODE_H = 44

type Dir = "LR" | "TB"

/** Concept box. Click selects it for editing; the active concept is highlighted. */
function ConceptNode({ data }: NodeProps) {
  const { label, selected, direction, icon } = data as {
    label: string
    selected?: boolean
    direction?: Dir
    icon?: string | null
  }
  const targetPos = direction === "TB" ? Position.Top : Position.Left
  const sourcePos = direction === "TB" ? Position.Bottom : Position.Right
  return (
    <div
      className={
        selected
          ? "cursor-pointer rounded-lg border-2 border-gray-900 bg-white px-4 py-2 text-center text-sm font-medium text-gray-900 shadow"
          : "cursor-pointer rounded-lg border border-gray-300 bg-white px-4 py-2 text-center text-sm font-medium text-gray-800 shadow-sm hover:border-gray-500"
      }
    >
      <Handle type="target" position={targetPos} className="!h-2 !w-2 !border-0 !bg-gray-300" />
      <span className="inline-flex items-center justify-center gap-1.5">
        <ConceptIcon value={icon} size={15} />
        {label}
      </span>
      <Handle type="source" position={sourcePos} className="!h-2 !w-2 !border-0 !bg-gray-300" />
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

/** Project the concept graph into laid-out React Flow nodes + edges (dagre). */
function buildFlow(graph: ConceptGraph, direction: Dir): { nodes: Node[]; edges: Edge[] } {
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
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 90 })
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target)
  Dagre.layout(g)

  const nodes: Node[] = graph.nodes.map((n) => {
    const p = g.node(n.id)
    return {
      id: n.id,
      type: "concept",
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: { label: n.name, selected: false, direction, icon: n.icon },
    }
  })

  return { nodes, edges }
}

/** Interactive canvas — separated so its layout is computed once per data load. */
function Flow({
  graph,
  selectedId,
  onSelect,
}: {
  graph: ConceptGraph
  selectedId: string | null
  onSelect: (conceptId: string) => void
}) {
  const { fitView } = useReactFlow()
  const initial = useMemo(() => buildFlow(graph, "LR"), [graph])
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)

  // Reflect the active selection without re-running layout (preserves pan/zoom).
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, selected: n.id === selectedId } })))
  }, [selectedId, setNodes])

  // Re-run the dagre layout in the chosen direction, then refit the viewport.
  const align = useCallback(
    (direction: Dir) => {
      const next = buildFlow(graph, direction)
      setNodes(
        next.nodes.map((n) => ({ ...n, data: { ...n.data, selected: n.id === selectedId } })),
      )
      requestAnimationFrame(() => fitView({ padding: 0.2 }))
    },
    [graph, selectedId, setNodes, fitView],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      nodesConnectable={false}
      minZoom={0.2}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Background color="#e5e7eb" gap={20} />
      <Controls showInteractive={false}>
        <ControlButton onClick={() => align("LR")} title="Arrange horizontally">
          <AlignHorizontalDistributeCenter size={16} />
        </ControlButton>
        <ControlButton onClick={() => align("TB")} title="Arrange vertically">
          <AlignVerticalDistributeCenter size={16} />
        </ControlButton>
      </Controls>
    </ReactFlow>
  )
}

/** Concept graph as a selector: concepts are nodes, relation fields are edges. */
export function ConceptGraphCanvas({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (conceptId: string) => void
}) {
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
          No concepts yet. Create a concept to get started.
        </div>
      </Card>
    )

  // Re-mount Flow (re-running layout) only when the underlying graph changes.
  const sig = `${graph.data.nodes.map((n) => n.id).join()}|${graph.data.edges.map((e) => e.id).join()}`

  return (
    <div className="space-y-3">
      {graph.data.edges.length === 0 && (
        <p className="text-sm text-gray-400">
          No relationships yet — add relation fields to your concepts to connect them.
        </p>
      )}
      <Card className="h-[70vh] w-full overflow-hidden">
        <ReactFlowProvider>
          <Flow key={sig} graph={graph.data} selectedId={selectedId} onSelect={onSelect} />
        </ReactFlowProvider>
      </Card>
    </div>
  )
}
