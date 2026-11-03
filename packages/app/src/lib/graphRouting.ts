/**
 * Orthogonal, obstacle-avoiding edge routing for the graph canvases, via
 * libavoid (the Adaptagrams connector router, compiled to WASM).
 *
 * Routing is a pure function of the CURRENT node boxes — not of whichever
 * layout placed them — so routes stay correct after a drag, a reload of saved
 * positions, or a newly created node. Every edge attaches to a centre pin that
 * may leave in any direction; libavoid picks the side, then nudges parallel
 * segments apart so edges sharing a node spread along its border instead of
 * meeting in one point. The centre-to-centre route is then clipped to the box
 * borders so arrowheads land on the node outline.
 *
 * The WASM (~480KB) loads lazily on first use; until then (or if it fails)
 * callers get no routes and render their fallback edge.
 */

export interface Pt {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Route {
  readonly points: ReadonlyArray<Pt>
  /** Where the edge label (if any) goes — clear of nodes and other labels. */
  readonly label: Pt
}
export interface RouteEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label?: string
}

/* Minimal typing of the WebIDL bindings we touch (the package's own .d.ts is
 * a loose `any` bag). */
interface AvoidObj {
  readonly __brand?: never
}
interface AvoidPolyLine {
  size(): number
  get_ps(i: number): Pt
}
interface AvoidRouter extends AvoidObj {
  setRoutingParameter(p: number, v: number): void
  setRoutingOption(o: number, v: boolean): void
  processTransaction(): void
}
interface AvoidConnRef extends AvoidObj {
  displayRoute(): AvoidPolyLine
}
interface Avoid {
  Router: new (flags: number) => AvoidRouter
  Point: new (x: number, y: number) => AvoidObj
  Rectangle: new (topLeft: AvoidObj, bottomRight: AvoidObj) => AvoidObj
  ShapeRef: new (router: AvoidRouter, poly: AvoidObj) => AvoidObj
  ShapeConnectionPin: new (
    shape: AvoidObj,
    classId: number,
    x: number,
    y: number,
    proportional: boolean,
    insideOffset: number,
    dirs: number,
  ) => AvoidObj
  ConnEnd: new (shape: AvoidObj, classId: number) => AvoidObj
  ConnRef: new (router: AvoidRouter, src: AvoidObj, dst: AvoidObj) => AvoidConnRef
  destroy(o: AvoidObj): void
  OrthogonalRouting: number
  ConnDirAll: number
  shapeBufferDistance: number
  idealNudgingDistance: number
  segmentPenalty: number
  crossingPenalty: number
  nudgeOrthogonalSegmentsConnectedToShapes: number
  nudgeSharedPathsWithCommonEndPoint: number
  performUnifyingNudgingPreprocessingStep: number
}

let avoidPromise: Promise<Avoid> | null = null

/** Load (once) and return the libavoid instance. */
export function loadAvoid(): Promise<Avoid> {
  avoidPromise ??= (async () => {
    const [{ AvoidLib }, { default: wasmUrl }] = await Promise.all([
      import("libavoid-js"),
      import("libavoid-wasm?url"),
    ])
    await AvoidLib.load(wasmUrl)
    return AvoidLib.getInstance() as unknown as Avoid
  })()
  // A failed load must not poison every later attempt.
  avoidPromise.catch(() => {
    avoidPromise = null
  })
  return avoidPromise
}

const PIN = 1
/** Clearance libavoid keeps between a route and any box it isn't attached to. */
const BUFFER = 14
/** Target gap between parallel segments after nudging. */
const NUDGE = 12

/** Rough label footprint at the canvases' 11px/500 label style. */
export const labelSize = (text: string) => ({ w: text.length * 6.2 + 14, h: 20 })

const inside = (p: Pt, b: Box) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h

/** Where the axis-aligned segment a→b (a inside, b outside) crosses the box border. */
function exitPoint(a: Pt, b: Pt, box: Box): Pt {
  if (a.x === b.x) return { x: a.x, y: b.y > a.y ? box.y + box.h : box.y }
  return { x: b.x > a.x ? box.x + box.w : box.x, y: a.y }
}

/** Trim the route's leading points that sit inside `box`, ending on its border. */
function clipStart(pts: Pt[], box: Box): Pt[] {
  const i = pts.findIndex((p) => !inside(p, box))
  const prev = pts[i - 1]
  const first = pts[i]
  if (i <= 0 || !prev || !first) return pts
  return [exitPoint(prev, first, box), ...pts.slice(i)]
}

const clipBoth = (pts: Pt[], src: Box, dst: Box) =>
  clipStart(clipStart(pts, src).reverse(), dst).reverse()

/** Point at fraction `t` of the polyline's length. */
function along(pts: ReadonlyArray<Pt>, t: number): Pt {
  const segs = pts.slice(1).map((p, i) => {
    const a = pts[i] as Pt
    return { a, b: p, len: Math.abs(p.x - a.x) + Math.abs(p.y - a.y) }
  })
  let left = segs.reduce((s, x) => s + x.len, 0) * t
  for (const s of segs) {
    if (left <= s.len && s.len > 0) {
      const f = left / s.len
      return { x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f }
    }
    left -= s.len
  }
  return pts[pts.length - 1] ?? { x: 0, y: 0 }
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const LABEL_SLOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]

/**
 * Route every non-self-loop edge around the given boxes. Edges whose endpoint
 * box is missing (not yet measured) are left out — callers fall back for those.
 */
export function routeEdges(
  avoid: Avoid,
  boxes: ReadonlyMap<string, Box>,
  edges: ReadonlyArray<RouteEdge>,
): Map<string, Route> {
  const A = avoid
  const temps: AvoidObj[] = []
  const tmp = <T extends AvoidObj>(o: T) => {
    temps.push(o)
    return o
  }
  const router = new A.Router(A.OrthogonalRouting)
  const routes = new Map<string, Route>()
  try {
    router.setRoutingParameter(A.shapeBufferDistance, BUFFER)
    router.setRoutingParameter(A.idealNudgingDistance, NUDGE)
    // Bends cost: prefer one clean elbow over a staircase.
    router.setRoutingParameter(A.segmentPenalty, 50)
    router.setRoutingParameter(A.crossingPenalty, 100)
    router.setRoutingOption(A.nudgeOrthogonalSegmentsConnectedToShapes, true)
    router.setRoutingOption(A.nudgeSharedPathsWithCommonEndPoint, true)
    router.setRoutingOption(A.performUnifyingNudgingPreprocessingStep, true)

    const shapes = new Map<string, AvoidObj>()
    for (const [id, b] of boxes) {
      const rect = tmp(
        new A.Rectangle(tmp(new A.Point(b.x, b.y)), tmp(new A.Point(b.x + b.w, b.y + b.h))),
      )
      const shape = new A.ShapeRef(router, rect)
      new A.ShapeConnectionPin(shape, PIN, 0.5, 0.5, true, 0, A.ConnDirAll)
      shapes.set(id, shape)
    }

    const conns: { e: RouteEdge; conn: AvoidConnRef }[] = []
    for (const e of edges) {
      if (e.source === e.target) continue
      const s = shapes.get(e.source)
      const t = shapes.get(e.target)
      if (!s || !t) continue
      const conn = new A.ConnRef(router, tmp(new A.ConnEnd(s, PIN)), tmp(new A.ConnEnd(t, PIN)))
      conns.push({ e, conn })
    }
    router.processTransaction()

    // Labels: greedy slotting along each route, skipping
    // spots that would cover a node or an already-placed label.
    const nodeRects = [...boxes.values()]
    const placed: Box[] = []
    const withPts = conns.map(({ e, conn }) => {
      const pl = conn.displayRoute()
      const raw: Pt[] = []
      for (let i = 0; i < pl.size(); i++) {
        const p = pl.get_ps(i)
        raw.push({ x: p.x, y: p.y })
      }
      const points = clipBoth(raw, boxes.get(e.source) as Box, boxes.get(e.target) as Box)
      return { e, points }
    })
    for (const { e, points } of withPts) {
      let label = along(points, 0.5)
      if (e.label) {
        const { w, h } = labelSize(e.label)
        for (const t of LABEL_SLOTS) {
          const c = along(points, t)
          const r = { x: c.x - w / 2, y: c.y - h / 2, w, h }
          if (!nodeRects.some((n) => overlaps(r, n)) && !placed.some((p) => overlaps(r, p))) {
            label = c
            placed.push(r)
            break
          }
        }
      }
      routes.set(e.id, { points, label })
    }
  } finally {
    // Router owns its shapes, pins and connectors; the rest we allocated.
    A.destroy(router)
    for (const o of temps) A.destroy(o)
  }
  return routes
}

/** SVG path through the points with softly rounded elbows. */
export function roundedPath(pts: ReadonlyArray<Pt>, radius = 8): string {
  const first = pts[0]
  if (!first) return ""
  let d = `M ${first.x} ${first.y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i] as Pt
    const a = pts[i - 1] as Pt
    const b = pts[i + 1] as Pt
    const la = Math.hypot(p.x - a.x, p.y - a.y)
    const lb = Math.hypot(b.x - p.x, b.y - p.y)
    const r = Math.min(radius, la / 2, lb / 2)
    if (r < 0.5) {
      d += ` L ${p.x} ${p.y}`
      continue
    }
    const inPt = { x: p.x + ((a.x - p.x) / la) * r, y: p.y + ((a.y - p.y) / la) * r }
    const outPt = { x: p.x + ((b.x - p.x) / lb) * r, y: p.y + ((b.y - p.y) / lb) * r }
    d += ` L ${inPt.x} ${inPt.y} Q ${p.x} ${p.y} ${outPt.x} ${outPt.y}`
  }
  const last = pts[pts.length - 1] as Pt
  d += ` L ${last.x} ${last.y}`
  return d
}
