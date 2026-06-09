import "@xyflow/react/dist/style.css"
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
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import { ChevronDown, Redo2, Undo2, Workflow } from "lucide-react"
import { type CSSProperties, useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Card, Spinner } from "../../components/ui"
import { api, type ConceptGraph, type GraphLayout } from "../../lib/api"
import {
  computeLayout,
  LAYOUT_DIR,
  LAYOUT_GROUPS,
  type LayoutDir,
  type LayoutInput,
  type LayoutKind,
  layoutDagre,
  NODE_H,
  NODE_W,
} from "../../lib/graphLayouts"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "../../lib/icons"

/** Handle sides per layout flow direction (target side first). */
const DIR_HANDLES: Record<LayoutDir, [Position, Position]> = {
  LR: [Position.Left, Position.Right],
  RL: [Position.Right, Position.Left],
  TB: [Position.Top, Position.Bottom],
  BT: [Position.Bottom, Position.Top],
}

/** Concept box. Click selects it for editing; the active concept is highlighted,
 *  and nodes missed by the toolbar's find-filter render dimmed. */
function ConceptNode({ data }: NodeProps) {
  const { label, selected, direction, icon, dimmed } = data as {
    label: string
    selected?: boolean
    direction?: LayoutDir
    icon?: string | null
    dimmed?: boolean
  }
  const [targetPos, sourcePos] = DIR_HANDLES[direction ?? "LR"]
  return (
    <div
      className={
        (selected
          ? "cursor-pointer rounded-lg border-2 border-primary bg-background px-4 py-2 text-center text-sm font-medium text-foreground shadow"
          : "cursor-pointer rounded-lg border border-input bg-background px-4 py-2 text-center text-sm font-medium text-foreground shadow-sm hover:border-ring") +
        (dimmed ? " opacity-30" : "")
      }
    >
      <Handle
        type="target"
        position={targetPos}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/50"
      />
      <span className="inline-flex items-center justify-center gap-1.5">
        <ConceptIcon value={icon || DEFAULT_CONCEPT_ICON} size={15} />
        {label}
      </span>
      <Handle
        type="source"
        position={sourcePos}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/50"
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
            className="pointer-events-none absolute rounded bg-card px-1.5 py-0.5 text-[11px] font-medium text-foreground"
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

/** Layout input: deduplicated relation pairs, self-loops excluded. */
function toLayoutInput(graph: ConceptGraph): LayoutInput {
  const pairs = new Set<string>()
  const edges: { source: string; target: string }[] = []
  for (const e of graph.edges) {
    if (e.from === e.to) continue
    const key = `${e.from}->${e.to}`
    if (pairs.has(key)) continue
    pairs.add(key)
    edges.push({ source: e.from, target: e.to })
  }
  return { nodes: graph.nodes.map((n) => ({ id: n.id, label: n.name })), edges }
}

/** Project the concept graph into React Flow nodes + edges. Saved positions
 *  win; nodes without one (e.g. freshly created concepts) fall back to dagre. */
function buildFlow(graph: ConceptGraph, saved: GraphLayout): { nodes: Node[]; edges: Edge[] } {
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
    // CSS vars (not hex) so edge chrome follows the active theme.
    labelStyle: { fontSize: 11, fontWeight: 500, fill: "var(--foreground)" },
    labelBgStyle: { fill: "var(--card)" },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--ring)" },
    style: { stroke: "var(--ring)", strokeWidth: 1.5 },
  }))

  const fallback = layoutDagre(toLayoutInput(graph), "LR")
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "concept",
    position: saved[n.id] ?? fallback.get(n.id) ?? { x: 0, y: 0 },
    data: { label: n.name, selected: false, direction: "LR", icon: n.icon },
  }))

  return { nodes, edges }
}

/** Interactive canvas — separated so its layout is computed once per data load. */
function Flow({
  graph,
  selectedId,
  onSelect,
  filter,
  savedPositions,
}: {
  graph: ConceptGraph
  selectedId: string | null
  onSelect: (conceptId: string) => void
  filter: string
  savedPositions: GraphLayout
}) {
  const { fitView } = useReactFlow()
  const initial = useMemo(() => buildFlow(graph, savedPositions), [graph, savedPositions])
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)

  // ── position persistence (debounced) + client-side undo/redo ───────────────
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  const currentPositions = useCallback((): GraphLayout => {
    return Object.fromEntries(nodesRef.current.map((n) => [n.id, { ...n.position }]))
  }, [])

  // Every position change (drag, layout, undo/redo) saves the FULL map after a
  // quiet period — last write wins org-wide, stale concept ids wash out.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      api.saveGraphLayout(currentPositions()).catch((e) => {
        console.warn("graph layout save failed", e)
      })
    }, 800)
  }, [currentPositions])
  // Flush a pending save on unmount so a quick navigation doesn't lose the move.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        api.saveGraphLayout(currentPositions()).catch(() => {})
      }
    },
    [currentPositions],
  )

  // Undo/redo over position snapshots. Refs hold the stacks (no re-render per
  // tick); the reducer bump refreshes button disabled-states.
  const history = useRef<{ past: GraphLayout[]; future: GraphLayout[] }>({ past: [], future: [] })
  const [, bump] = useReducer((c: number) => c + 1, 0)
  const pushHistory = useCallback(() => {
    history.current.past.push(currentPositions())
    history.current.future = []
    bump()
  }, [currentPositions])

  const applyPositions = useCallback(
    (layout: GraphLayout) => {
      setNodes((ns) => ns.map((n) => ({ ...n, position: layout[n.id] ?? n.position })))
      scheduleSave()
    },
    [setNodes, scheduleSave],
  )
  const undo = useCallback(() => {
    const prev = history.current.past.pop()
    if (!prev) return
    history.current.future.push(currentPositions())
    applyPositions(prev)
    bump()
  }, [applyPositions, currentPositions])
  const redo = useCallback(() => {
    const next = history.current.future.pop()
    if (!next) return
    history.current.past.push(currentPositions())
    applyPositions(next)
    bump()
  }, [applyPositions, currentPositions])

  // Cmd/Ctrl+Z / Shift+Cmd+Z (or Ctrl+Y) while interacting with the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement | null
      if (!target?.closest(".react-flow")) return
      if (e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo])

  // A drag is one undo step: snapshot at grab, commit at release.
  const dragSnap = useRef<GraphLayout | null>(null)
  const onNodeDragStart = useCallback(() => {
    dragSnap.current = currentPositions()
  }, [currentPositions])
  const onNodeDragStop = useCallback(() => {
    if (dragSnap.current) {
      history.current.past.push(dragSnap.current)
      history.current.future = []
      dragSnap.current = null
      bump()
    }
    scheduleSave()
  }, [scheduleSave])

  // Reflect selection + find-filter without re-running layout (preserves pan/zoom).
  const q = filter.trim().toLowerCase()
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: {
          ...n.data,
          selected: n.id === selectedId,
          dimmed: q !== "" && !String(n.data.label).toLowerCase().includes(q),
        },
      })),
    )
  }, [selectedId, q, setNodes])

  // Run the chosen auto-layout (some are async — ELK), then refit the viewport.
  // Applying a layout is a single undoable step and autosaves like any move.
  const align = useCallback(
    (kind: LayoutKind) => {
      void computeLayout(kind, toLayoutInput(graph)).then((positions) => {
        pushHistory()
        const direction = LAYOUT_DIR[kind] ?? "LR"
        setNodes((ns) =>
          ns.map((n) => ({
            ...n,
            position: positions.get(n.id) ?? n.position,
            data: { ...n.data, direction, selected: n.id === selectedId },
          })),
        )
        scheduleSave()
        requestAnimationFrame(() => fitView({ padding: 0.2 }))
      })
    },
    [graph, selectedId, setNodes, fitView, pushHistory, scheduleSave],
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
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      nodesConnectable={false}
      minZoom={0.2}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Background color="var(--graph-dots)" gap={20} />
      <Controls showInteractive={false} />
      <Panel position="top-left" className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shadow-sm">
              <Workflow />
              Layout
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {LAYOUT_GROUPS.map((g, i) => (
              <div key={g.group}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                  {g.group}
                </DropdownMenuLabel>
                {g.layouts.map((l) => (
                  <DropdownMenuItem key={l.kind} onSelect={() => align(l.kind)}>
                    {l.name}
                  </DropdownMenuItem>
                ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="icon-sm"
          className="shadow-sm"
          aria-label="Undo move"
          title="Undo (⌘Z)"
          disabled={history.current.past.length === 0}
          onClick={undo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="shadow-sm"
          aria-label="Redo move"
          title="Redo (⇧⌘Z)"
          disabled={history.current.future.length === 0}
          onClick={redo}
        >
          <Redo2 />
        </Button>
      </Panel>
    </ReactFlow>
  )
}

/** Concept graph as a selector: concepts are nodes, relation fields are edges.
 *  `filter` (the toolbar's find input) dims nodes whose name doesn't match. */
export function ConceptGraphCanvas({
  selectedId,
  onSelect,
  filter = "",
}: {
  selectedId: string | null
  onSelect: (conceptId: string) => void
  filter?: string
}) {
  const graph = useQuery({ queryKey: ["conceptGraph"], queryFn: () => api.getConceptGraph() })
  // Saved canvas positions (org-shared). Refetched only on mount — while open,
  // the canvas is the source of truth and autosaves its own changes.
  const layout = useQuery({
    queryKey: ["graphLayout"],
    queryFn: () => api.getGraphLayout(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  if (graph.isPending || layout.isPending) return <Spinner />
  if (graph.error)
    return (
      <Card>
        <div className="p-6 text-sm text-destructive">Failed to load the concept graph.</div>
      </Card>
    )
  if (graph.data.nodes.length === 0)
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground">
          No concepts yet. Create a concept to get started.
        </div>
      </Card>
    )

  // Re-mount Flow (re-running layout) only when the underlying graph changes.
  const sig = `${graph.data.nodes.map((n) => n.id).join()}|${graph.data.edges.map((e) => e.id).join()}`

  return (
    <div
      className="space-y-3"
      // Captured OUTSIDE the force-light scope below, so the dot grid keeps
      // tracking the global theme while the graph items render light.
      style={{ "--graph-dots": "var(--border)" } as CSSProperties}
    >
      {graph.data.edges.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No relationships yet — add relation fields to your concepts to connect them.
        </p>
      )}
      <Card className="h-[calc(100dvh-220px)] min-h-[420px] w-full overflow-hidden">
        {/* Items (nodes, edges, controls) always render in the light palette;
            the canvas surface (card bg + dots) stays bound to the global theme. */}
        <div className="force-light h-full w-full bg-transparent">
          <ReactFlowProvider>
            <Flow
              key={sig}
              graph={graph.data}
              selectedId={selectedId}
              onSelect={onSelect}
              filter={filter}
              savedPositions={layout.data ?? {}}
            />
          </ReactFlowProvider>
        </div>
      </Card>
    </div>
  )
}
