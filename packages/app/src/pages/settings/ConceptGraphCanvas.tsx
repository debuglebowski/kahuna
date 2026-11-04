import "@xyflow/react/dist/style.css"
import { MEMBER_GRAPH_NODE_ID } from "@kahunalabs/contract"
import { useQuery } from "@tanstack/react-query"
import {
  Background,
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
import { Maximize, Redo2, Undo2, Users, ZoomIn, ZoomOut } from "lucide-react"
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { GraphLeaveConfirm, GraphSaveBar } from "../../components/graph/GraphSaveBar"
import { GraphStylePanel } from "../../components/graph/GraphStylePanel"
import { EdgeRoutesProvider, RoutedEdge, useEdgeRoutes } from "../../components/graph/RoutedEdge"
import { SatelliteEdge } from "../../components/graph/SatelliteEdge"
import { SelfLoopEdge } from "../../components/graph/SelfLoopEdge"
import { placeSatellites, SATELLITE_GAP } from "../../components/graph/satellites"
import { useGraphPositions } from "../../components/graph/useGraphPositions"
import { Card, Spinner } from "../../components/ui"
import { api, type ConceptGraph, type GraphLayout } from "../../lib/api"
import {
  computeLayout,
  LAYOUT_DIR,
  type LayoutDir,
  type LayoutInput,
  type LayoutKind,
  layoutDagre,
  withCanvasMeasures,
} from "../../lib/graphLayouts"
import { selfLoopGeometry } from "../../lib/graphRouting"
import {
  cardMetrics,
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
  const { label, selected, direction, icon, dimmed, managedBy, scale } = data as {
    label: string
    selected?: boolean
    direction?: LayoutDir
    icon?: string | null
    dimmed?: boolean
    managedBy?: string | null
    scale?: number
  }
  const [targetPos, sourcePos] = DIR_HANDLES[direction ?? "TB"]
  const m = cardMetrics(scale ?? 100)
  return (
    <div
      style={{
        fontSize: m.fontSize,
        padding: `${m.padY}px ${m.padX}px`,
        borderRadius: m.radius,
      }}
      className={
        (selected
          ? "cursor-pointer rounded-lg border-2 border-primary bg-background text-center font-medium text-foreground shadow"
          : `cursor-pointer rounded-lg text-center font-medium text-foreground shadow-sm hover:border-ring ${managedBy ? "border-2 border-dashed border-info/40 bg-[oklch(0.95_0.03_264)]" : "border border-input bg-background"}`) +
        (dimmed ? " opacity-30" : "")
      }
    >
      <Handle type="target" position={targetPos} className="!h-2 !w-2 !border-0 !opacity-0" />
      <span
        style={{ gap: m.gap }}
        className={`inline-flex items-center justify-center${managedBy ? " font-bold italic" : ""}`}
      >
        <ConceptIcon value={icon || DEFAULT_CONCEPT_ICON} size={m.icon} />
        {label}
      </span>
      <Handle type="source" position={sourcePos} className="!h-2 !w-2 !border-0 !opacity-0" />
    </div>
  )
}

/** Node id of the built-in Members box. Not a concept id, so the canvas never
 *  routes a click on it; its saved position sits in the layout under this key. */
const MEMBERS_NODE_ID = MEMBER_GRAPH_NODE_ID
/** Per-concept Member card ("satellite") ids: derived, never saved. */
const SATELLITE_PREFIX = `${MEMBERS_NODE_ID}:`
const satelliteId = (conceptId: string) => `${SATELLITE_PREFIX}${conceptId}`
const isBuiltin = (id: string) => id === MEMBERS_NODE_ID || id.startsWith(SATELLITE_PREFIX)

/** Satellite card size for these field names at a card size (fixed, so the
 *  router and placement know it before the DOM is measured). */
function satelliteSize(fields: ReadonlyArray<string>, scale: number) {
  const m = cardMetrics(scale)
  // Real text width (same font as the card), + icon + gap + padding + border + slack.
  const w = textWidth(fields.join(", "), m.satFont) + m.satIcon + 4 + 2 * m.satPadX + 2 + 4
  return { w: Math.ceil(Math.min(200 * (scale / 100), w)), h: m.satH }
}

let measureCtx: CanvasRenderingContext2D | null | undefined
/** Width of `text` in the page's font at `px` / weight 500 (cards' font-medium).
 *  Falls back to an em-based estimate where canvas isn't available. */
function textWidth(text: string, px: number): number {
  if (measureCtx === undefined)
    measureCtx =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")
  if (!measureCtx) return text.length * px * 0.62
  const family = getComputedStyle(document.body).fontFamily || "sans-serif"
  measureCtx.font = `500 ${px}px ${family}`
  return measureCtx.measureText(text).width
}

/** Look shared by every platform-defined (built-in, non-concept) node: a pill —
 *  a different shape from concept boxes — with a faint green tint + thin green
 *  border. Light fill, so it stays readable on the light AND dark canvas surface,
 *  but quieter than a concept (no shadow, muted text). */
const BUILTIN_NODE =
  "cursor-default rounded-full border border-success/40 bg-[oklch(0.97_0.02_150)] text-center font-medium text-success"

/** Org members — what `user` fields point at. Built-in, not a concept: {@link BUILTIN_NODE}
 *  pill, not clickable. Always shown, linked or not — members always exist. */
function MembersNode({ data }: NodeProps) {
  const { direction, dimmed, scale, fields } = data as {
    direction?: LayoutDir
    dimmed?: boolean
    scale?: number
    /** Set on a per-concept satellite: the member fields it stands for. */
    fields?: string[]
  }
  const [targetPos, sourcePos] = DIR_HANDLES[direction ?? "TB"]
  const m = cardMetrics(scale ?? 100)
  if (fields) {
    // Satellite: fixed size (node width/height), icon + the field names.
    return (
      <div
        title={`Member fields: ${fields.join(", ")}`}
        style={{ fontSize: m.satFont, paddingInline: m.satPadX }}
        className={`${BUILTIN_NODE} flex h-full w-full items-center justify-center gap-1${dimmed ? " opacity-30" : ""}`}
      >
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !opacity-0" />
        <Users size={m.satIcon} className="shrink-0" />
        <span className="truncate">{fields.join(", ")}</span>
      </div>
    )
  }
  return (
    <div
      title="Built-in: org members. User fields point here."
      style={{ fontSize: m.fontSize, padding: `${m.padY}px ${m.padX}px` }}
      className={`${BUILTIN_NODE}${dimmed ? " opacity-30" : ""}`}
    >
      <Handle type="target" position={targetPos} className="!h-2 !w-2 !border-0 !opacity-0" />
      <span style={{ gap: m.gap }} className="inline-flex items-center justify-center">
        <Users size={m.icon} />
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
const edgeTypes = { selfloop: SelfLoopEdge, routed: RoutedEdge, satellite: SatelliteEdge }

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

/** Icon button in the canvas dock. */
function DockButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** Card chrome shared by the dock and the save card beside it. */
const DOCK_CARD =
  "flex items-center gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lift"

const DockDivider = () => <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />

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
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  // Look settings: edited locally, persisted with the layout on Save.
  const [style, setStyle] = useState(savedStyle)
  const [styleBaseline, setStyleBaseline] = useState(savedStyle)
  const styleDirty = JSON.stringify(style) !== JSON.stringify(styleBaseline)
  const initial = useMemo(() => buildFlow(graph, savedPositions), [graph, savedPositions])
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)

  // Member fields per concept (for per-concept Member cards).
  const memberFields = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of graph.userEdges) m.set(e.from, [...(m.get(e.from) ?? []), e.fieldName])
    return m
  }, [graph.userEdges])
  const perConcept = style.builtinCards === "perConcept"

  // What's drawn: the stored nodes with the card size applied, and — in
  // per-concept mode — the shared Member card swapped for one small satellite
  // next to each concept with member fields. Satellites are derived from their
  // parent's box every render (so they follow drags) and never saved.
  const displayNodes = useMemo(() => {
    const sized = nodes.map((n) => ({ ...n, data: { ...n.data, scale: style.cardScale } }))
    if (!perConcept) return sized
    const shown = sized.filter((n) => n.id !== MEMBERS_NODE_ID)
    const boxOf = (n: Node) =>
      n.measured?.width && n.measured.height
        ? { x: n.position.x, y: n.position.y, w: n.measured.width, h: n.measured.height }
        : null
    const obstacles = shown.flatMap((n) => {
      const b = boxOf(n)
      return b ? [b] : []
    })
    // Self-loops occupy the top-right corner of their card.
    for (const e of edges)
      if (e.source === e.target) {
        const n = shown.find((x) => x.id === e.source)
        const b = n && boxOf(n)
        if (b)
          obstacles.push(...selfLoopGeometry(b, String(e.label ?? ""), style.labelScale).blocked)
      }
    const parents = shown.flatMap((n) => {
      const fields = memberFields.get(n.id)
      const b = boxOf(n)
      return fields && b ? [{ id: n.id, box: b, size: satelliteSize(fields, style.cardScale) }] : []
    })
    const placed = placeSatellites(parents, obstacles)
    const satellites: Node[] = parents.map((p) => {
      const parent = shown.find((n) => n.id === p.id)
      return {
        id: satelliteId(p.id),
        type: "members",
        position: placed.get(p.id) ?? { x: p.box.x + p.box.w + 24, y: p.box.y },
        width: p.size.w,
        height: p.size.h,
        // Rebuilt every render, so React Flow can't keep what it measured;
        // declaring size + the one target handle up front makes the node
        // "initialized" without a measure pass (otherwise its edge never draws).
        measured: { width: p.size.w, height: p.size.h },
        handles: [
          {
            type: "target" as const,
            position: Position.Left,
            x: 0,
            y: p.size.h / 2,
            width: 1,
            height: 1,
          },
        ],
        draggable: false,
        selectable: false,
        data: {
          fields: memberFields.get(p.id),
          scale: style.cardScale,
          dimmed: (parent?.data as { dimmed?: boolean } | undefined)?.dimmed,
        },
      }
    })
    return [...shown, ...satellites]
  }, [nodes, edges, perConcept, memberFields, style.cardScale, style.labelScale])

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
        // Per-concept Member cards: the edge goes to the concept's own card,
        // which already names the fields — so no label.
        const toSatellite = perConcept && d.userEdge
        return {
          ...e,
          ...(toSatellite
            ? {
                id: `${e.source}->${satelliteId(e.source)}`,
                target: satelliteId(e.source),
                type: "satellite",
              }
            : {}),
          label: toSatellite ? undefined : label || undefined,
          data: {
            ...e.data,
            cornerRadius: style.cornerRadius,
            smooth: style.lineShape === "smooth",
            labelScale: style.labelScale,
          },
          style: { ...e.style, strokeWidth: d.userEdge ? style.lineWidth * 0.85 : style.lineWidth },
        }
      }),
    [
      edges,
      perConcept,
      style.labels,
      style.cornerRadius,
      style.lineShape,
      style.lineWidth,
      style.labelScale,
    ],
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

  // Arrange: run the style's layout method (ELK — async), then refit the
  // viewport. A single undoable step — or, with `asBaseline`, the unsaved-free
  // starting point (first open with nothing saved). `opts.style` arranges
  // with settings not rendered yet (a preset just clicked): card sizes scale
  // linearly with `cardScale`, so the measured boxes are scaled to match
  // instead of waiting for a re-measure.
  const align = useCallback(
    (opts?: { asBaseline?: boolean; style?: GraphStyle }) => {
      const st = opts?.style ?? style
      const kind: LayoutKind = st.layoutMethod === "organic" ? "elk-stress" : "elk-layered"
      const sepCards = st.builtinCards === "perConcept"
      // Per-concept Member cards aren't laid out themselves: the shared Member
      // card and its edges leave the input, and each parent's box is widened
      // by its satellite so Auto keeps that room free on the right.
      const base = toLayoutInput(graph)
      const input = sepCards
        ? {
            ...base,
            nodes: base.nodes.filter((n) => n.id !== MEMBERS_NODE_ID),
            edges: base.edges.filter((e) => e.target !== MEMBERS_NODE_ID),
          }
        : base
      const measured = withCanvasMeasures(input, nodes, displayEdges)
      const ratio = st.cardScale / style.cardScale
      if (measured.sizes && (ratio !== 1 || sepCards)) {
        const sizes = new Map(
          [...measured.sizes].map(([id, s]) => [id, { w: s.w * ratio, h: s.h * ratio }] as const),
        )
        if (sepCards)
          for (const [id, fields] of memberFields) {
            const s = sizes.get(id)
            if (s)
              sizes.set(id, {
                w: s.w + SATELLITE_GAP + satelliteSize(fields, st.cardScale).w,
                h: s.h,
              })
          }
        Object.assign(measured, { sizes })
      }
      void computeLayout(kind, measured, {
        direction: st.direction,
        nodeSpacing: st.nodeSpacing,
        layerSpacing: st.layerSpacing,
        groupSpacing: st.groupSpacing,
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
      memberFields,
      style,
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
    align({ asBaseline: true })
  }, [nodesInitialized, align])

  // Satellite connectors are drawn straight (SatelliteEdge), not routed —
  // their cards still count as obstacles for every other line.
  const routedEdges = useMemo(
    () => displayEdges.filter((e) => e.type !== "satellite"),
    [displayEdges],
  )
  const routes = useEdgeRoutes(
    displayNodes,
    routedEdges,
    {
      clearance: style.clearance,
      lineSpacing: style.lineSpacing,
      labelsAlongLine: style.labelDirection === "along",
      smooth: style.lineShape === "smooth",
      labelScale: style.labelScale,
    },
    style.rerouteWhileDragging,
  )

  return (
    <EdgeRoutesProvider value={routes}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          if (!isBuiltin(node.id)) onSelect(node.id)
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
        {/* Bottom centre: the dock (settings, history, view) and — while
            there's something to save — a separate save card beside it. */}
        <Panel position="bottom-center" className="flex items-center gap-2">
          <div className={DOCK_CARD}>
            <GraphStylePanel
              style={style}
              onChange={setStyle}
              onArrange={() => align()}
              onApplyPreset={(next) => {
                setStyle(next)
                align({ style: next })
              }}
            />
            <DockDivider />
            <DockButton label="Undo move" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>
              <Undo2 />
            </DockButton>
            <DockButton label="Redo move" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
              <Redo2 />
            </DockButton>
            <DockDivider />
            <DockButton label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
              <ZoomOut />
            </DockButton>
            <DockButton label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
              <ZoomIn />
            </DockButton>
            <DockButton
              label="Fit to screen"
              onClick={() => fitView({ padding: 0.2, duration: 200 })}
            >
              <Maximize />
            </DockButton>
          </div>
          {dirty && (
            <div className={`${DOCK_CARD} animate-in fade-in slide-in-from-bottom-2 duration-200`}>
              <GraphSaveBar
                inline
                dirty={dirty}
                saving={saving}
                error={saveError}
                onSave={() => void saveAll()}
                onDiscard={discardAll}
              />
            </div>
          )}
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
