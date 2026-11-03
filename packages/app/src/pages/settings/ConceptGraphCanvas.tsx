import "@xyflow/react/dist/style.css"
import { MEMBER_GRAPH_NODE_ID } from "@kahunalabs/contract"
import { useQuery } from "@tanstack/react-query"
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import { ChevronDown, Redo2, Undo2, Users, Workflow } from "lucide-react"
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GraphLeaveConfirm, GraphSaveBar } from "../../components/graph/GraphSaveBar"
import { GraphStylePanel } from "../../components/graph/GraphStylePanel"
import { EdgeRoutesProvider, RoutedEdge, useEdgeRoutes } from "../../components/graph/RoutedEdge"
import { SelfLoopEdge } from "../../components/graph/SelfLoopEdge"
import { useGraphPositions } from "../../components/graph/useGraphPositions"
import { Card, Spinner } from "../../components/ui"
import { api, type ConceptGraph, type GraphLayout } from "../../lib/api"
import {
  computeLayout,
  DEFAULT_LAYOUT,
  LAYOUT_DIR,
  LAYOUTS,
  type LayoutDir,
  type LayoutInput,
  type LayoutKind,
  layoutDagre,
  withCanvasMeasures,
} from "../../lib/graphLayouts"
import {
  GRAPH_GRID,
  type GraphStyle,
  normalizeGraphStyle,
  relationLabel,
} from "../../lib/graphStyle"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "../../lib/icons"
import { queryClient } from "../../lib/queryClient"
import { useUnsavedGuard } from "../../lib/useUnsavedGuard"

/** Stable empty fallback — a fresh `{}` would re-run the layout memo per render. */
const NO_SAVED: GraphLayout = {}

/** Handle sides per layout flow direction (target side first). */
const DIR_HANDLES: Record<LayoutDir, [Position, Position]> = {
  LR: [Position.Left, Position.Right],
  RL: [Position.Right, Position.Left],
  TB: [Position.Top, Position.Bottom],
  BT: [Position.Bottom, Position.Top],
}

/** Concept box. Click selects it for editing; the active concept is highlighted,
 *  and nodes missed by the toolbar's find-filter render dimmed. Connector-managed
 *  ("integration") concepts get a thicker dashed border + a blue-tinted fill and a
 *  bold-italic title so they read as read-only, sync-owned records. */
function ConceptNode({ data }: NodeProps) {
  const { label, selected, direction, icon, dimmed, managedBy } = data as {
    label: string
    selected?: boolean
    direction?: LayoutDir
    icon?: string | null
    dimmed?: boolean
    managedBy?: string | null
  }
  const [targetPos, sourcePos] = DIR_HANDLES[direction ?? "TB"]
  return (
    <div
      className={
        (selected
          ? "cursor-pointer rounded-lg border-2 border-primary bg-background px-4 py-2 text-center text-sm font-medium text-foreground shadow"
          : `cursor-pointer rounded-lg px-4 py-2 text-center text-sm font-medium text-foreground shadow-sm hover:border-ring ${managedBy ? "border-2 border-dashed border-info/40 bg-[oklch(0.95_0.03_264)]" : "border border-input bg-background"}`) +
        (dimmed ? " opacity-30" : "")
      }
    >
      <Handle type="target" position={targetPos} className="!h-2 !w-2 !border-0 !opacity-0" />
      <span
        className={`inline-flex items-center justify-center gap-1.5${managedBy ? " font-bold italic" : ""}`}
      >
        <ConceptIcon value={icon || DEFAULT_CONCEPT_ICON} size={15} />
        {label}
      </span>
      <Handle type="source" position={sourcePos} className="!h-2 !w-2 !border-0 !opacity-0" />
    </div>
  )
}

/** Node id of the built-in Members box. Not a concept id, so the canvas never
 *  routes a click on it; its saved position sits in the layout under this key. */
const MEMBERS_NODE_ID = MEMBER_GRAPH_NODE_ID

/** Look shared by every platform-defined (built-in, non-concept) node: a pill —
 *  a different shape from concept boxes — with a faint green tint + thin green
 *  border. Light fill, so it stays readable on the light AND dark canvas surface,
 *  but quieter than a concept (no shadow, muted text). */
const BUILTIN_NODE =
  "cursor-default rounded-full border border-success/40 bg-[oklch(0.97_0.02_150)] px-4 py-2 text-center text-sm font-medium text-success"

/** Org members — what `user` fields point at. Built-in, not a concept: {@link BUILTIN_NODE}
 *  pill, not clickable. Always shown, linked or not — members always exist. */
function MembersNode({ data }: NodeProps) {
  const { direction, dimmed } = data as { direction?: LayoutDir; dimmed?: boolean }
  const [targetPos, sourcePos] = DIR_HANDLES[direction ?? "TB"]
  return (
    <div
      title="Built-in: org members. User fields point here."
      className={`${BUILTIN_NODE}${dimmed ? " opacity-30" : ""}`}
    >
      <Handle type="target" position={targetPos} className="!h-2 !w-2 !border-0 !opacity-0" />
      <span className="inline-flex items-center justify-center gap-1.5">
        <Users size={15} />
        Member
        <span className="rounded-full bg-success/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide">
          built-in
        </span>
      </span>
      <Handle type="source" position={sourcePos} className="!h-2 !w-2 !border-0 !opacity-0" />
    </div>
  )
}

const nodeTypes = { concept: ConceptNode, members: MembersNode }
const edgeTypes = { selfloop: SelfLoopEdge, routed: RoutedEdge }

/** Layout input: deduplicated relation pairs, self-loops excluded, plus the
 *  Members node + its user-field edges when any exist. */
function toLayoutInput(graph: ConceptGraph): LayoutInput {
  const pairs = new Set<string>()
  const edges: { source: string; target: string }[] = []
  const all = [
    ...graph.edges,
    ...graph.userEdges.map((e) => ({ from: e.from, to: MEMBERS_NODE_ID })),
  ]
  for (const e of all) {
    if (e.from === e.to) continue
    const key = `${e.from}->${e.to}`
    if (pairs.has(key)) continue
    pairs.add(key)
    edges.push({ source: e.from, target: e.to })
  }
  const nodes = graph.nodes.map((n) => ({ id: n.id, label: n.name }))
  nodes.push({ id: MEMBERS_NODE_ID, label: "Member" })
  return { nodes, edges }
}

/** Project the concept graph into React Flow nodes + edges. Saved positions
 *  win; nodes without one (e.g. freshly created concepts) fall back to dagre. */
function buildFlow(graph: ConceptGraph, saved: GraphLayout): { nodes: Node[]; edges: Edge[] } {
  // Collapse multiple relation fields with the same direction into one labelled edge.
  // Each relation keeps its forward + inverse names; the label text is built
  // per the look settings' label mode at render time (see `displayEdges`).
  const merged = new Map<
    string,
    { from: string; to: string; rels: { forward: string; inverse: string | null }[] }
  >()
  for (const e of graph.edges) {
    const key = `${e.from}->${e.to}`
    const m = merged.get(key) ?? { from: e.from, to: e.to, rels: [] }
    m.rels.push({ forward: e.relationType, inverse: e.inverseName })
    merged.set(key, m)
  }

  const edges: Edge[] = [...merged.values()].map((m) => ({
    id: `${m.from}->${m.to}`,
    source: m.from,
    target: m.to,
    type: m.from === m.to ? "selfloop" : "routed",
    label: m.rels.map((r) => relationLabel("both", r.forward, r.inverse)).join(", "),
    data: { rels: m.rels },
    // CSS vars (not hex) so edge chrome follows the active theme.
    labelStyle: { fontSize: 11, fontWeight: 500, fill: "var(--foreground)" },
    labelBgStyle: { fill: "var(--card)" },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--ring)" },
    style: { stroke: "var(--ring)", strokeWidth: 1.5 },
  }))

  // User fields → Members: one dashed edge per concept, labelled with its fields.
  const userMerged = new Map<string, Set<string>>()
  for (const e of graph.userEdges) {
    const labels = userMerged.get(e.from) ?? new Set<string>()
    labels.add(e.fieldName)
    userMerged.set(e.from, labels)
  }
  for (const [from, labels] of userMerged) {
    edges.push({
      id: `${from}->${MEMBERS_NODE_ID}`,
      source: from,
      target: MEMBERS_NODE_ID,
      type: "routed",
      label: [...labels].join(", "),
      data: { rels: [...labels].map((forward) => ({ forward, inverse: null })), userEdge: true },
      labelStyle: { fontSize: 11, fontWeight: 500, fill: "var(--muted-foreground)" },
      labelBgStyle: { fill: "var(--card)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: "var(--muted-foreground)",
      },
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.25, strokeDasharray: "5 4" },
    })
  }

  const fallback = layoutDagre(toLayoutInput(graph), "TB")
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "concept",
    position: saved[n.id] ?? fallback.get(n.id) ?? { x: 0, y: 0 },
    data: { label: n.name, selected: false, direction: "TB", icon: n.icon, managedBy: n.managedBy },
  }))
  nodes.push({
    id: MEMBERS_NODE_ID,
    type: "members",
    position: saved[MEMBERS_NODE_ID] ?? fallback.get(MEMBERS_NODE_ID) ?? { x: 0, y: 0 },
    data: { label: "Member", direction: "TB" },
  })

  return { nodes, edges }
}

/** Save the full layout and refresh the cached copy, so a remount (e.g. after
 *  a concept is added) starts from what was just saved. */
const persistPositions = (positions: GraphLayout) =>
  api.saveGraphLayout(positions).then((saved) => {
    queryClient.setQueryData(["graphLayout"], saved)
    return saved
  })

/** Interactive canvas — separated so its layout is computed once per data load. */
function Flow({
  graph,
  selectedId,
  onSelect,
  filter,
  savedPositions,
  savedStyle,
}: {
  graph: ConceptGraph
  selectedId: string | null
  onSelect: (conceptId: string) => void
  filter: string
  savedPositions: GraphLayout
  savedStyle: GraphStyle
}) {
  const { fitView } = useReactFlow()
  // Look settings: edited locally, persisted with the layout on Save.
  const [style, setStyle] = useState(savedStyle)
  const [styleBaseline, setStyleBaseline] = useState(savedStyle)
  const styleDirty = JSON.stringify(style) !== JSON.stringify(styleBaseline)
  const initial = useMemo(() => buildFlow(graph, savedPositions), [graph, savedPositions])
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)

  // Line settings applied live on top of the stored edges.
  const displayEdges = useMemo(
    () =>
      edges.map((e) => {
        const d = e.data as {
          rels?: { forward: string; inverse: string | null }[]
          userEdge?: boolean
        }
        const label = d.rels
          ? d.rels.map((r) => relationLabel(style.labels, r.forward, r.inverse)).join(", ")
          : e.label
        return {
          ...e,
          label: label || undefined,
          data: {
            ...e.data,
            cornerRadius: style.cornerRadius,
            smooth: style.lineShape === "smooth",
          },
          style: { ...e.style, strokeWidth: d.userEdge ? style.lineWidth * 0.85 : style.lineWidth },
        }
      }),
    [edges, style.labels, style.cornerRadius, style.lineShape, style.lineWidth],
  )

  // Positions: local until Save; undo/redo (see the hook).
  const {
    dirty: positionsDirty,
    savePositions,
    discard: discardPositions,
    adoptAsBaseline,
    pushHistory,
    undo,
    redo,
    canUndo,
    canRedo,
    onNodeDragStart,
    onNodeDragStop,
  } = useGraphPositions(nodes, setNodes, persistPositions)

  const dirty = positionsDirty || styleDirty
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const saveAll = useCallback(async () => {
    setSaving(true)
    setSaveError(false)
    try {
      if (positionsDirty) await savePositions()
      if (styleDirty) {
        queryClient.setQueryData(["graphStyle"], await api.saveGraphStyle(style))
        setStyleBaseline(style)
      }
    } catch (e) {
      console.warn("graph save failed", e)
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }, [positionsDirty, savePositions, styleDirty, style])
  const discardAll = useCallback(() => {
    discardPositions()
    setStyle(styleBaseline)
    setSaveError(false)
  }, [discardPositions, styleBaseline])
  const { blocker } = useUnsavedGuard(dirty)

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
  // Applying a layout is a single undoable step — or, with `asBaseline`, the
  // unsaved-free starting point (first open with nothing saved).
  const align = useCallback(
    (kind: LayoutKind, opts?: { asBaseline?: boolean }) => {
      void computeLayout(kind, withCanvasMeasures(toLayoutInput(graph), nodes, displayEdges), {
        direction: style.direction,
        nodeSpacing: style.nodeSpacing,
        layerSpacing: style.layerSpacing,
        groupSpacing: style.groupSpacing,
      }).then((positions) => {
        if (opts?.asBaseline)
          adoptAsBaseline(
            Object.fromEntries(nodes.map((n) => [n.id, positions.get(n.id) ?? n.position])),
          )
        else pushHistory()
        const direction = LAYOUT_DIR[kind] ?? "TB"
        setNodes((ns) =>
          ns.map((n) => ({
            ...n,
            position: positions.get(n.id) ?? n.position,
            data: { ...n.data, direction, selected: n.id === selectedId },
          })),
        )
        requestAnimationFrame(() => fitView({ padding: 0.2 }))
      })
    },
    [
      graph,
      selectedId,
      setNodes,
      fitView,
      pushHistory,
      adoptAsBaseline,
      nodes,
      displayEdges,
      style.direction,
      style.nodeSpacing,
      style.layerSpacing,
      style.groupSpacing,
    ],
  )

  // Nothing arranged yet (fresh org / never-opened record graph): run Auto
  // once the nodes are measured, so the first view is the routed layout
  // rather than dagre's sync fallback. Not saved: it re-runs identically on
  // each visit until someone arranges and saves.
  const nodesInitialized = useNodesInitialized()
  const autoLaidOut = useRef(Object.keys(savedPositions).length > 0)
  useEffect(() => {
    if (!nodesInitialized || autoLaidOut.current) return
    autoLaidOut.current = true
    align(DEFAULT_LAYOUT, { asBaseline: true })
  }, [nodesInitialized, align])

  const routes = useEdgeRoutes(
    nodes,
    displayEdges,
    {
      clearance: style.clearance,
      lineSpacing: style.lineSpacing,
      labelsAlongLine: style.labelDirection === "along",
      smooth: style.lineShape === "smooth",
    },
    style.rerouteWhileDragging,
  )

  return (
    <EdgeRoutesProvider value={routes}>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          if (node.id !== MEMBERS_NODE_ID) onSelect(node.id)
        }}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        nodesConnectable={false}
        snapToGrid={style.snapToGrid}
        snapGrid={[GRAPH_GRID, GRAPH_GRID]}
        minZoom={0.2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        style={{ width: "100%", height: "100%" }}
      >
        <Background color="var(--graph-dots)" gap={GRAPH_GRID} />
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
            <DropdownMenuContent align="start" className="w-40">
              {LAYOUTS.map((l) => (
                <DropdownMenuItem key={l.kind} onSelect={() => align(l.kind)}>
                  {l.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="icon-sm"
            className="shadow-sm"
            aria-label="Undo move"
            title="Undo (⌘Z)"
            disabled={!canUndo}
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
            disabled={!canRedo}
            onClick={redo}
          >
            <Redo2 />
          </Button>
          <GraphStylePanel
            style={style}
            onChange={setStyle}
            onRerunAuto={() => align(DEFAULT_LAYOUT)}
          />
        </Panel>
        <Panel position="bottom-center">
          <GraphSaveBar
            dirty={dirty}
            saving={saving}
            error={saveError}
            onSave={() => void saveAll()}
            onDiscard={discardAll}
          />
        </Panel>
      </ReactFlow>
      <GraphLeaveConfirm
        blocked={blocker.state === "blocked"}
        onLeave={() => blocker.proceed?.()}
        onStay={() => blocker.reset?.()}
      />
    </EdgeRoutesProvider>
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
  // the canvas is the source of truth and writes the cache back on Save.
  const layout = useQuery({
    queryKey: ["graphLayout"],
    queryFn: () => api.getGraphLayout(),
    staleTime: Number.POSITIVE_INFINITY,
  })
  // Look settings (org-shared). A failed load falls back to defaults rather
  // than blocking the canvas — they're cosmetic.
  const lookStyle = useQuery({
    queryKey: ["graphStyle"],
    queryFn: () => api.getGraphStyle(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  if (graph.isPending || layout.isPending || lookStyle.isPending) return <Spinner />
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
  const sig = `${graph.data.nodes.map((n) => n.id).join()}|${graph.data.edges.map((e) => e.id).join()}|${graph.data.userEdges.map((e) => `${e.id}:${e.fieldName}`).join()}`

  return (
    <div
      className="flex h-full flex-col gap-3"
      // Captured OUTSIDE the force-light scope below, so the dot grid keeps
      // tracking the global theme while the graph items render light.
      style={{ "--graph-dots": "var(--border)" } as CSSProperties}
    >
      {graph.data.edges.length === 0 && graph.data.userEdges.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No relationships yet — add relation fields to your concepts to connect them.
        </p>
      )}
      <Card className="min-h-0 w-full flex-1 overflow-hidden">
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
              savedPositions={layout.data ?? NO_SAVED}
              savedStyle={normalizeGraphStyle(lookStyle.data)}
            />
          </ReactFlowProvider>
        </div>
      </Card>
    </div>
  )
}
