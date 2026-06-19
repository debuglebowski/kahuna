import "@xyflow/react/dist/style.css"
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
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import { ChevronDown, Redo2, Settings2, Undo2, Workflow } from "lucide-react"
import { type CSSProperties, useCallback, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type GraphLayout } from "../../lib/api"
import {
  computeLayout,
  LAYOUT_DIR,
  LAYOUT_GROUPS,
  type LayoutDir,
  type LayoutInput,
  type LayoutKind,
  layoutDagre,
  NODE_W,
} from "../../lib/graphLayouts"
import {
  buildInstanceGraph,
  DEFAULT_GRAPH_CONFIG,
  GRAPH_NODE_CAP,
  type InstanceGraph,
  type InstanceGraphConfig,
} from "../../lib/instanceGraph"
import { instanceLabel } from "../../lib/instanceLabel"
import { useInstanceViewPrefs } from "../../lib/instanceViews"
import { queryClient } from "../../lib/queryClient"
import { recordHref } from "../../lib/recordHref"
import { SelfLoopEdge } from "../graph/SelfLoopEdge"
import { useGraphPositions } from "../graph/useGraphPositions"
import { Button, pillStyle, Spinner } from "../ui"
import type { InstanceCtx } from "./types"

/** Stable empty fallback — a fresh `{}` would re-run the flow memo per render. */
const NO_SAVED: GraphLayout = {}

const KNOWN_LAYOUTS = new Set<string>(LAYOUT_GROUPS.flatMap((g) => g.layouts.map((l) => l.kind)))

/** Saved config, clamped so a stale/foreign prefs row can't break the render. */
function cfgOf(
  graphByConcept: Readonly<Record<string, InstanceGraphConfig>> | undefined,
  conceptId: string,
): InstanceGraphConfig {
  const saved = graphByConcept?.[conceptId]
  if (!saved) return DEFAULT_GRAPH_CONFIG
  return {
    fieldIds: saved.fieldIds,
    depth: Math.min(Math.max(Math.round(saved.depth), 1), 6),
    layout: KNOWN_LAYOUTS.has(saved.layout) ? saved.layout : DEFAULT_GRAPH_CONFIG.layout,
  }
}

/** Resolve neighbours: the page already holds the root's edges; everything
 *  else goes through the query cache so re-layouts don't refetch the world. */
const relatedFetcher = (ctx: InstanceCtx) => async (instanceId: string) => {
  if (instanceId === ctx.instance.id) return ctx.related
  const detail = await queryClient.fetchQuery({
    queryKey: ["instanceGraphDetail", instanceId],
    queryFn: () => api.getInstance(instanceId),
    staleTime: 15_000,
  })
  return detail.related
}

/** Handle sides per layout flow direction (target side first). */
const DIR_HANDLES: Record<LayoutDir, [Position, Position]> = {
  LR: [Position.Left, Position.Right],
  RL: [Position.Right, Position.Left],
  TB: [Position.Top, Position.Bottom],
  BT: [Position.Bottom, Position.Top],
}

/** One instance box: label + concept. The viewed instance gets the primary
 *  ring; dangling refs render as faded dashed ghosts and don't navigate. A
 *  concept color tints the border and renders the concept tag as the same
 *  `.km-pill` chip labels use (the root keeps its primary border either way). */
function InstanceNode({ data }: NodeProps) {
  const d = data as {
    label: string
    conceptName: string
    color?: string | null
    direction?: LayoutDir
    root?: boolean
    ghost?: boolean
  }
  const [targetPos, sourcePos] = DIR_HANDLES[d.direction ?? "TB"]
  const tinted = d.color && !d.root ? { borderColor: d.color } : undefined
  return (
    <div
      style={{ width: NODE_W, ...tinted, ...(d.color ? pillStyle(d.color) : undefined) }}
      className={
        "rounded-lg border bg-background px-3 py-1.5 text-center shadow-sm" +
        (d.root ? " border-2 border-primary" : " border-input") +
        (d.ghost ? " border-dashed opacity-50" : d.root ? "" : " cursor-pointer hover:border-ring")
      }
    >
      <Handle
        type="target"
        position={targetPos}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/50"
      />
      <div className="truncate text-sm font-medium text-foreground">{d.label}</div>
      {d.color ? (
        <div className="mt-0.5 flex justify-center">
          <span className="km-pill inline-flex max-w-full items-center rounded-full px-1.5 py-px text-[10px] font-medium">
            <span className="truncate">{d.conceptName}</span>
          </span>
        </div>
      ) : (
        <div className="truncate text-[10px] text-muted-foreground">{d.conceptName}</div>
      )}
      <Handle
        type="source"
        position={sourcePos}
        className="!h-2 !w-2 !border-0 !bg-muted-foreground/50"
      />
    </div>
  )
}

const nodeTypes = { instance: InstanceNode }
const edgeTypes = { selfloop: SelfLoopEdge }

/** The instance card's real footprint (label line + concept pill) — taller
 *  than the concept box, so layouts must reserve the extra height. */
const CARD_SIZE = { w: NODE_W, h: 60 }

/** Layout input: deduplicated endpoint pairs, self-loops excluded. */
function toLayoutInput(graph: InstanceGraph): LayoutInput {
  const pairs = new Set<string>()
  const edges: { source: string; target: string }[] = []
  for (const e of graph.edges) {
    if (e.source === e.target) continue
    const key = `${e.source}->${e.target}`
    if (pairs.has(key)) continue
    pairs.add(key)
    edges.push({ source: e.source, target: e.target })
  }
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, label: n.label })),
    edges,
    nodeSize: CARD_SIZE,
  }
}

/** Project the built graph into React Flow nodes + edges. Parallel relations
 *  between the same two items merge into one labelled edge. Saved positions
 *  win; nodes without one (newly connected items) fall back to dagre. */
function buildFlow(
  graph: InstanceGraph,
  saved: GraphLayout,
  colorByConcept: ReadonlyMap<string, string | null>,
): { nodes: Node[]; edges: Edge[] } {
  const merged = new Map<string, { source: string; target: string; labels: Set<string> }>()
  for (const e of graph.edges) {
    const key = `${e.source}->${e.target}`
    const m = merged.get(key) ?? { source: e.source, target: e.target, labels: new Set<string>() }
    m.labels.add(e.pinned ? `${e.label} (pinned)` : e.label)
    merged.set(key, m)
  }

  const fallback = layoutDagre(toLayoutInput(graph), "TB")
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "instance",
      position: saved[n.id] ?? fallback.get(n.id) ?? { x: 0, y: 0 },
      data: {
        label: n.label,
        conceptName: n.conceptName,
        color: colorByConcept.get(n.conceptId) ?? null,
        direction: "TB",
        root: n.root,
        ghost: n.ghost,
        instanceId: n.instanceId,
      },
    })),
    edges: [...merged.values()].map((m) => ({
      id: `${m.source}->${m.target}`,
      source: m.source,
      target: m.target,
      type: m.source === m.target ? "selfloop" : "default",
      label: [...m.labels].join(", "),
      labelStyle: { fontSize: 11, fontWeight: 500, fill: "var(--foreground)" },
      labelBgStyle: { fill: "var(--card)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--ring)" },
      style: { stroke: "var(--ring)", strokeWidth: 1.5 },
    })),
  }
}

/** Interactive canvas: drag to rearrange (persisted org-wide per root item,
 *  same debounced patch + undo/redo machinery as the concept canvas), Layout
 *  dropdown to auto-arrange, click-through navigation on nodes. */
function GraphFlow({
  graph,
  savedPositions,
  colorByConcept,
  saveLayout,
}: {
  graph: InstanceGraph
  savedPositions: GraphLayout
  colorByConcept: ReadonlyMap<string, string | null>
  saveLayout: (patch: GraphLayout) => Promise<unknown>
}) {
  const navigate = useNavigate()
  const { fitView } = useReactFlow()
  const initial = useMemo(
    () => buildFlow(graph, savedPositions, colorByConcept),
    [graph, savedPositions, colorByConcept],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)

  const {
    saveState,
    markDirty,
    scheduleSave,
    pushHistory,
    undo,
    redo,
    canUndo,
    canRedo,
    onNodeDragStart,
    onNodeDragStop,
  } = useGraphPositions(nodes, setNodes, saveLayout)

  // Run the chosen auto-layout (some are async — ELK), then refit the viewport.
  // Applying a layout is a single undoable step and autosaves like any move.
  const align = useCallback(
    (kind: LayoutKind) => {
      void computeLayout(kind, toLayoutInput(graph)).then((positions) => {
        pushHistory()
        const direction = LAYOUT_DIR[kind] ?? "TB"
        setNodes((ns) =>
          ns.map((n) => ({
            ...n,
            position: positions.get(n.id) ?? n.position,
            data: { ...n.data, direction },
          })),
        )
        markDirty("all")
        scheduleSave()
        requestAnimationFrame(() => fitView({ padding: 0.2 }))
      })
    },
    [graph, setNodes, fitView, pushHistory, markDirty, scheduleSave],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={(_, node) => {
        const d = node.data as { instanceId?: string | null; root?: boolean }
        if (d.instanceId && !d.root) navigate(recordHref(d.instanceId))
      }}
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
        {saveState !== "idle" && (
          <span
            className={
              saveState === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {saveState === "error" ? "Save failed — retrying" : "Saving…"}
          </span>
        )}
      </Panel>
      {graph.truncated && (
        <Panel
          position="bottom-left"
          className="rounded bg-card px-2 py-1 text-xs text-muted-foreground"
        >
          Showing the first {GRAPH_NODE_CAP} items — narrow the fields or depth.
        </Panel>
      )}
    </ReactFlow>
  )
}

export function GraphBody({ ctx }: { ctx: InstanceCtx }) {
  const { body, loaded } = useInstanceViewPrefs()
  const cfg = cfgOf(body.graphByConcept, ctx.concept.id)
  // Stable map so GraphFlow's layout effect doesn't re-run on every render.
  const colorByConcept = useMemo(
    () => new Map(ctx.concepts.map((c) => [c.id, c.color])),
    [ctx.concepts],
  )

  // Re-walk when the root's own edges change (add/remove via Connections).
  const relSig = ctx.related.map((r) => r.relationId).join(",")
  const graphQ = useQuery({
    queryKey: ["instanceGraph", ctx.instance.id, cfg.fieldIds, cfg.depth, relSig],
    queryFn: () =>
      buildInstanceGraph(
        {
          itemId: ctx.instance.itemId,
          instanceId: ctx.instance.id,
          label: instanceLabel(ctx.instance, ctx.fields, ctx.concept.titleFieldId),
          conceptId: ctx.concept.id,
          conceptName: ctx.concept.name,
        },
        relatedFetcher(ctx),
        cfg,
      ),
    enabled: loaded,
  })
  // Saved canvas positions (org-shared, keyed by this root item). Refetched
  // only on mount — while open, the canvas is the source of truth and
  // autosaves its own changes. A fetch error falls back to auto-layout.
  const layoutQ = useQuery({
    queryKey: ["instanceGraphLayout", ctx.instance.itemId],
    queryFn: () => api.getInstanceGraphLayout(ctx.instance.itemId),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const saveLayout = useCallback(
    (patch: GraphLayout) => api.saveInstanceGraphLayout(ctx.instance.itemId, patch),
    [ctx.instance.itemId],
  )

  if (!loaded || graphQ.isPending || layoutQ.isPending)
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center">
        <Spinner />
      </div>
    )
  if (graphQ.error)
    return <div className="p-6 text-sm text-destructive">Failed to load the graph.</div>
  if (graphQ.data.edges.length === 0)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Nothing connected yet — add connections (or widen the graph settings) to see the graph.
      </div>
    )

  // Re-mount the flow (re-seeding positions) only when the graph itself changes.
  const sig = `${graphQ.data.nodes.map((n) => n.id).join()}|${graphQ.data.edges
    .map((e) => e.id)
    .join()}`
  return (
    // Fill the tile/tab pane (definite height on wide screens); the min height
    // keeps the canvas usable in the narrow stacked layout where rows auto-size.
    <div
      className="h-full min-h-[360px] w-full"
      style={{ "--graph-dots": "var(--border)" } as CSSProperties}
    >
      <div className="force-light h-full w-full bg-transparent">
        <ReactFlowProvider>
          <GraphFlow
            key={sig}
            graph={graphQ.data}
            savedPositions={layoutQ.data ?? NO_SAVED}
            colorByConcept={colorByConcept}
            saveLayout={saveLayout}
          />
        </ReactFlowProvider>
      </div>
    </div>
  )
}

export function GraphActions({ ctx }: { ctx: InstanceCtx }) {
  const { body, loaded, update } = useInstanceViewPrefs()
  const cfg = cfgOf(body.graphByConcept, ctx.concept.id)
  // All relation fields in the org — the walk may cross concepts, so the
  // filter offers every edge type, grouped by the concept that owns it.
  const conceptGraph = useQuery({
    queryKey: ["conceptGraph"],
    queryFn: () => api.getConceptGraph(),
  })

  const save = (next: InstanceGraphConfig) =>
    update.mutate({
      ...body,
      graphByConcept: { ...(body.graphByConcept ?? {}), [ctx.concept.id]: next },
    })

  const relationFields = conceptGraph.data?.edges ?? []
  const conceptName = new Map((conceptGraph.data?.nodes ?? []).map((n) => [n.id, n.name]))
  const byConcept = new Map<string, typeof relationFields>()
  for (const f of relationFields) {
    const list = byConcept.get(f.from) ?? []
    byConcept.set(f.from, [...list, f])
  }
  const allFieldIds = relationFields.map((f) => f.id)
  const followAll = cfg.fieldIds === null
  const followed = new Set(cfg.fieldIds ?? allFieldIds)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={!loaded}>
          <Settings2 size={15} />
          Configure
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Depth</Label>
          <Select
            value={String(cfg.depth)}
            onValueChange={(v) => save({ ...cfg, depth: Number(v) })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6].map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} hop{d > 1 ? "s" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Relations to follow</Label>
          <div className="flex items-center gap-2">
            <Checkbox
              id="graph-follow-all"
              checked={followAll}
              onCheckedChange={(on) => save({ ...cfg, fieldIds: on === true ? null : allFieldIds })}
            />
            <Label htmlFor="graph-follow-all" className="text-sm font-normal text-foreground">
              All relations
            </Label>
          </div>
          {!followAll && (
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {[...byConcept.entries()].map(([conceptId, fs]) => (
                <div key={conceptId} className="space-y-1">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {conceptName.get(conceptId) ?? "?"}
                  </div>
                  {fs.map((f) => (
                    <div key={f.id} className="flex items-center gap-2 pl-1">
                      <Checkbox
                        id={`graph-field-${f.id}`}
                        checked={followed.has(f.id)}
                        onCheckedChange={(on) => {
                          const next = new Set(followed)
                          if (on === true) next.add(f.id)
                          else next.delete(f.id)
                          save({ ...cfg, fieldIds: [...next] })
                        }}
                      />
                      <Label
                        htmlFor={`graph-field-${f.id}`}
                        className="text-sm font-normal text-foreground"
                      >
                        {f.relationType}
                      </Label>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
