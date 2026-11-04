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
  /** Turn the label sideways: it sits on a vertical segment and labels
   *  follow the line direction. */
  readonly labelVertical: boolean
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
export interface RouteOptions {
  /** Clearance libavoid keeps between a route and any box it isn't attached to. */
  readonly clearance: number
  /** Target gap between parallel segments after nudging. */
  readonly lineSpacing: number
  /** Labels on vertical segments read along the line (rotated) rather than
   *  always horizontal. Changes their footprint for collision checks too. */
  readonly labelsAlongLine: boolean
  /** Lines are drawn with {@link smoothPath}; labels are placed on that curve. */
  readonly smooth: boolean
  /** Edge label size as % of the 11px base — feeds label collision boxes. */
  readonly labelScale: number
}
export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
  clearance: 14,
  lineSpacing: 12,
  labelsAlongLine: false,
  smooth: false,
  labelScale: 100,
}

/** Rough label footprint at the canvases' 11px/500 label style. */
export const labelSize = (text: string, scalePct = 100) => {
  const k = scalePct / 100
  return { w: (text.length * 6.2 + 14) * k, h: 20 * k }
}

/** Inline style for an edge label at a size % (base: 11px text, 6×2 padding). */
export const labelStyle = (scalePct = 100) => {
  const k = scalePct / 100
  return { fontSize: 11 * k, padding: `${2 * k}px ${6 * k}px`, borderRadius: 4 * k }
}

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
/** Point at fraction `t` of the polyline's length, and whether it lies on a
 *  vertical segment. */
function along(pts: ReadonlyArray<Pt>, t: number): Pt & { vertical: boolean } {
  const segs = pts.slice(1).map((p, i) => {
    const a = pts[i] as Pt
    return { a, b: p, len: Math.abs(p.x - a.x) + Math.abs(p.y - a.y) }
  })
  let left = segs.reduce((s, x) => s + x.len, 0) * t
  for (const s of segs) {
    if (left <= s.len && s.len > 0) {
      const f = left / s.len
      return {
        x: s.a.x + (s.b.x - s.a.x) * f,
        y: s.a.y + (s.b.y - s.a.y) * f,
        vertical: Math.abs(s.b.x - s.a.x) < Math.abs(s.b.y - s.a.y),
      }
    }
    left -= s.len
  }
  const last = pts[pts.length - 1] ?? { x: 0, y: 0 }
  return { x: last.x, y: last.y, vertical: false }
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const LABEL_SLOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]

/** How far a self-loop reaches out from its box. */
const LOOP_REACH = 22
/** Where a self-loop leaves the top edge, measured in from the right corner. */
const LOOP_INSET = 18

/**
 * Geometry of a self-loop on `box`: a small loop round the top-right corner —
 * out of the top edge, round the corner, back into the right side. Shared by
 * the edge component (drawing) and {@link routeEdges} (which keeps other
 * lines and labels clear of it). `blocked` lies entirely OUTSIDE the box, so
 * it never swallows the box's own connection pin.
 */
export function selfLoopGeometry(box: Box, label?: string, labelScale = 100) {
  const right = box.x + box.w
  const startX = right - Math.min(LOOP_INSET, box.w / 3)
  const entryY = box.y + Math.min(12, box.h / 3)
  const top = box.y - LOOP_REACH
  const points: Pt[] = [
    { x: startX, y: box.y },
    { x: startX, y: top },
    { x: right + LOOP_REACH, y: top },
    { x: right + LOOP_REACH, y: entryY },
    { x: right, y: entryY },
  ]
  /** Label: left edge just outside the loop's outer corner, vertically centred on it. */
  const labelAt: Pt = { x: right + LOOP_REACH + 6, y: top }
  const blocked: Box[] = [
    { x: startX, y: top, w: right + LOOP_REACH - startX, h: LOOP_REACH },
    { x: right, y: box.y, w: LOOP_REACH, h: entryY - box.y },
  ]
  if (label) {
    const { w, h } = labelSize(label, labelScale)
    blocked.push({ x: labelAt.x, y: labelAt.y - h / 2, w, h })
  }
  return { points, labelAt, blocked }
}

/**
 * Route every non-self-loop edge around the given boxes (and around any
 * self-loops on them, which are drawn separately). Edges whose endpoint
 * box is missing (not yet measured) are left out — callers fall back for those.
 */
export function routeEdges(
  avoid: Avoid,
  boxes: ReadonlyMap<string, Box>,
  edges: ReadonlyArray<RouteEdge>,
  opts: RouteOptions = DEFAULT_ROUTE_OPTIONS,
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
    router.setRoutingParameter(A.shapeBufferDistance, opts.clearance)
    router.setRoutingParameter(A.idealNudgingDistance, opts.lineSpacing)
    // Bends cost: prefer one clean elbow over a staircase.
    router.setRoutingParameter(A.segmentPenalty, 50)
    router.setRoutingParameter(A.crossingPenalty, 100)
    router.setRoutingOption(A.nudgeOrthogonalSegmentsConnectedToShapes, true)
    router.setRoutingOption(A.nudgeSharedPathsWithCommonEndPoint, true)
    router.setRoutingOption(A.performUnifyingNudgingPreprocessingStep, true)

    const rectOf = (b: Box) =>
      tmp(new A.Rectangle(tmp(new A.Point(b.x, b.y)), tmp(new A.Point(b.x + b.w, b.y + b.h))))
    const shapes = new Map<string, AvoidObj>()
    for (const [id, b] of boxes) {
      const shape = new A.ShapeRef(router, rectOf(b))
      new A.ShapeConnectionPin(shape, PIN, 0.5, 0.5, true, 0, A.ConnDirAll)
      shapes.set(id, shape)
    }
    // Self-loops (and their labels) are pin-less obstacles: lines go round them.
    const loopRects: Box[] = []
    for (const e of edges) {
      const b = e.source === e.target ? boxes.get(e.source) : undefined
      if (!b) continue
      for (const r of selfLoopGeometry(b, e.label, opts.labelScale).blocked) {
        new A.ShapeRef(router, rectOf(r))
        loopRects.push(r)
      }
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
    const nodeRects = [...boxes.values(), ...loopRects]
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
      // Labels go on the line as drawn — the curve, when smooth.
      const drawn = opts.smooth ? flattenSmooth(points) : points
      let label = along(drawn, 0.5)
      if (e.label) {
        const size = labelSize(e.label, opts.labelScale)
        for (const t of LABEL_SLOTS) {
          const c = along(drawn, t)
          const turned = opts.labelsAlongLine && c.vertical
          const w = turned ? size.h : size.w
          const h = turned ? size.w : size.h
          const r = { x: c.x - w / 2, y: c.y - h / 2, w, h }
          if (!nodeRects.some((n) => overlaps(r, n)) && !placed.some((p) => overlaps(r, p))) {
            label = c
            placed.push(r)
            break
          }
        }
      }
      routes.set(e.id, {
        points,
        label: { x: label.x, y: label.y },
        labelVertical: opts.labelsAlongLine && label.vertical,
      })
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

/**
 * One smooth curve along the route: a quadratic per bend, with the bend as its
 * control point, joined at segment midpoints (so tangents match) — except the
 * first and last segments, which are used whole. An L becomes a single arc,
 * a Z an S; the curve still leaves and enters boxes perpendicular to their
 * sides, so arrowheads point straight in.
 */
export function smoothPath(pts: ReadonlyArray<Pt>): string {
  const first = pts[0]
  if (!first) return ""
  let d = `M ${first.x} ${first.y}`
  if (pts.length < 3) {
    const last = pts[pts.length - 1] as Pt
    return `${d} L ${last.x} ${last.y}`
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i] as Pt
    const next = pts[i + 1] as Pt
    const end = i === pts.length - 2 ? next : { x: (c.x + next.x) / 2, y: (c.y + next.y) / 2 }
    d += ` Q ${c.x} ${c.y} ${end.x} ${end.y}`
  }
  return d
}

/** {@link smoothPath} sampled back into a polyline (for label placement). */
function flattenSmooth(pts: ReadonlyArray<Pt>): Pt[] {
  if (pts.length < 3) return [...pts]
  const out: Pt[] = [pts[0] as Pt]
  let start = pts[0] as Pt
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i] as Pt
    const next = pts[i + 1] as Pt
    const end = i === pts.length - 2 ? next : { x: (c.x + next.x) / 2, y: (c.y + next.y) / 2 }
    for (let k = 1; k <= 8; k++) {
      const t = k / 8
      const u = 1 - t
      out.push({
        x: u * u * start.x + 2 * u * t * c.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * c.y + t * t * end.y,
      })
    }
    start = end
  }
  return out
}
