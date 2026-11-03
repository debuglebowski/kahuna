import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  type Node,
} from "@xyflow/react"
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import {
  type Box,
  DEFAULT_ROUTE_OPTIONS,
  loadAvoid,
  type Route,
  type RouteOptions,
  roundedPath,
  routeEdges,
  smoothPath,
} from "../../lib/graphRouting"

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

/**
 * Re-route all edges whenever node boxes change (drag, layout, measure).
 *
 * With `rerouteWhileDragging` off, a drag freezes routing: other lines keep
 * their last route, lines on the dragged boxes fall back to a plain curve
 * that follows the box (RoutedEdge's no-route path), and everything
 * re-routes once on drop.
 */
export function useEdgeRoutes(
  nodes: ReadonlyArray<Node>,
  edges: ReadonlyArray<Edge>,
  opts: RouteOptions = DEFAULT_ROUTE_OPTIONS,
  rerouteWhileDragging = true,
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
  const draggingKey = rerouteWhileDragging
    ? ""
    : nodes
        .filter((n) => n.dragging)
        .map((n) => n.id)
        .join(",")
  const frozen = draggingKey !== ""
  const lastRoutes = useRef<ReadonlyMap<string, Route>>(NO_ROUTES)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `geometry` stands in for `nodes`; while frozen the key is the dragged set, so mid-drag frames don't re-route
  return useMemo(() => {
    if (frozen) {
      const moving = new Set(draggingKey.split(","))
      const touching = new Set(
        edges.filter((e) => moving.has(e.source) || moving.has(e.target)).map((e) => e.id),
      )
      return new Map([...lastRoutes.current].filter(([id]) => !touching.has(id)))
    }
    if (!avoid) return NO_ROUTES
    const input = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
    }))
    try {
      const routes = routeEdges(avoid, boxesOf(nodes), input, {
        clearance: opts.clearance,
        lineSpacing: opts.lineSpacing,
        labelsAlongLine: opts.labelsAlongLine,
        smooth: opts.smooth,
      })
      lastRoutes.current = routes
      return routes
    } catch (err) {
      console.warn("edge routing failed — using plain edges", err)
      return NO_ROUTES
    }
  }, [
    avoid,
    frozen ? draggingKey : geometry,
    edges,
    opts.clearance,
    opts.lineSpacing,
    opts.labelsAlongLine,
    opts.smooth,
  ])
}

/** An edge drawn along its libavoid route (orthogonal, around other nodes).
 *  Before the router is ready it falls back to React Flow's bezier.
 *  `data.cornerRadius` (optional) rounds the elbows; default 8.
 *  `data.smooth` draws one continuous curve instead. */
export function RoutedEdge(props: EdgeProps) {
  const { id, label, markerEnd, style, data } = props
  const radius = typeof data?.cornerRadius === "number" ? data.cornerRadius : 8
  const smooth = data?.smooth === true
  const route = useContext(RoutesContext).get(id)
  const [fallbackPath, fx, fy] = getBezierPath(props)
  const path = useMemo(
    () =>
      route
        ? smooth
          ? smoothPath(route.points)
          : roundedPath(route.points, radius)
        : fallbackPath,
    [route, fallbackPath, radius, smooth],
  )
  const lx = route ? route.label.x : fx
  const ly = route ? route.label.y : fy
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{
              // Origin at the element's corner so the chain reads: centre on
              // (0,0), optionally turn, then move to the label point.
              transformOrigin: "0 0",
              transform: `translate(${lx}px, ${ly}px)${route?.labelVertical ? " rotate(-90deg)" : ""} translate(-50%, -50%)`,
            }}
            className="pointer-events-none absolute whitespace-nowrap rounded bg-card px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
