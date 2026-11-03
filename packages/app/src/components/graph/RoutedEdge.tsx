import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  type Node,
} from "@xyflow/react"
import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { type Box, loadAvoid, type Route, roundedPath, routeEdges } from "../../lib/graphRouting"

const NO_ROUTES: ReadonlyMap<string, Route> = new Map()
const RoutesContext = createContext<ReadonlyMap<string, Route>>(NO_ROUTES)
export const EdgeRoutesProvider = RoutesContext.Provider

type Avoid = Awaited<ReturnType<typeof loadAvoid>>

/** Measured node boxes (absolute — the canvases have no parent nodes). */
function boxesOf(nodes: ReadonlyArray<Node>): Map<string, Box> {
  const boxes = new Map<string, Box>()
  for (const n of nodes) {
    const w = n.measured?.width
    const h = n.measured?.height
    if (w && h) boxes.set(n.id, { x: n.position.x, y: n.position.y, w, h })
  }
  return boxes
}

/** Re-route all edges whenever node boxes change (drag, layout, measure). */
export function useEdgeRoutes(
  nodes: ReadonlyArray<Node>,
  edges: ReadonlyArray<Edge>,
): ReadonlyMap<string, Route> {
  const [avoid, setAvoid] = useState<Avoid | null>(null)
  useEffect(() => {
    let live = true
    loadAvoid().then(
      (a) => live && setAvoid(a),
      (e) => console.warn("edge router failed to load — using plain edges", e),
    )
    return () => {
      live = false
    }
  }, [])
  // Only geometry matters; key the memo on it so selection/dim updates don't re-route.
  const geometry = nodes
    .map(
      (n) => `${n.id}:${n.position.x},${n.position.y},${n.measured?.width},${n.measured?.height}`,
    )
    .join("|")
  // biome-ignore lint/correctness/useExhaustiveDependencies: `geometry` stands in for `nodes`
  return useMemo(() => {
    if (!avoid) return NO_ROUTES
    const input = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
    }))
    try {
      return routeEdges(avoid, boxesOf(nodes), input)
    } catch (err) {
      console.warn("edge routing failed — using plain edges", err)
      return NO_ROUTES
    }
  }, [avoid, geometry, edges])
}

/** An edge drawn along its libavoid route (orthogonal, around other nodes).
 *  Before the router is ready it falls back to React Flow's bezier. */
export function RoutedEdge(props: EdgeProps) {
  const { id, label, markerEnd, style } = props
  const route = useContext(RoutesContext).get(id)
  const [fallbackPath, fx, fy] = getBezierPath(props)
  const path = useMemo(
    () => (route ? roundedPath(route.points) : fallbackPath),
    [route, fallbackPath],
  )
  const lx = route ? route.label.x : fx
  const ly = route ? route.label.y : fy
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            className="pointer-events-none absolute whitespace-nowrap rounded bg-card px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
