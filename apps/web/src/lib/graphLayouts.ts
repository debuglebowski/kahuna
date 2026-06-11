import Dagre from "@dagrejs/dagre"
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"

export const NODE_W = 168
export const NODE_H = 44

export type LayoutDir = "LR" | "RL" | "TB" | "BT"

export type LayoutKind =
  | "dagre-tb"
  | "dagre-lr"
  | "elk-layered"
  | "force"
  | "elk-stress"
  | "circle"
  | "concentric"
  | "radial"
  | "elk-radial"
  | "elk-mrtree"
  | "grid"

/** Which way relation arrows flow for a layout — drives node handle placement. */
export const LAYOUT_DIR: Partial<Record<LayoutKind, LayoutDir>> = {
  "dagre-lr": "LR",
  "dagre-tb": "TB",
  "elk-layered": "LR",
}

/** Menu catalog, grouped the way the layout dropdown renders it. */
export const LAYOUT_GROUPS: ReadonlyArray<{
  group: string
  layouts: ReadonlyArray<{ kind: LayoutKind; name: string }>
}> = [
  {
    group: "Hierarchical",
    layouts: [
      { kind: "dagre-tb", name: "Layered ↓ down" },
      { kind: "dagre-lr", name: "Layered → right" },
      { kind: "elk-layered", name: "Layered (ELK)" },
    ],
  },
  {
    group: "Organic",
    layouts: [
      { kind: "force", name: "Force-directed" },
      { kind: "elk-stress", name: "Stress (ELK)" },
    ],
  },
  {
    group: "Radial",
    layouts: [
      { kind: "circle", name: "Circle" },
      { kind: "concentric", name: "Concentric by degree" },
      { kind: "radial", name: "Radial tree" },
      { kind: "elk-radial", name: "Radial (ELK)" },
    ],
  },
  {
    group: "Trees & grids",
    layouts: [
      { kind: "elk-mrtree", name: "Tree (ELK)" },
      { kind: "grid", name: "Grid" },
    ],
  },
]

export interface LayoutInput {
  nodes: ReadonlyArray<{ id: string; label: string }>
  /** Deduplicated, self-loops excluded (they don't affect placement). */
  edges: ReadonlyArray<{ source: string; target: string }>
  /** The card footprint layouts reserve per node — taller cards (e.g. the
   *  instance graph's label + concept pill) get proportionally more room.
   *  Defaults to the concept-canvas box. */
  nodeSize?: { w: number; h: number }
}

const sizeOf = (input: LayoutInput) => input.nodeSize ?? { w: NODE_W, h: NODE_H }

/** Node id → top-left position (React Flow coordinates). */
export type Positions = Map<string, { x: number; y: number }>

const center = (x: number, y: number, w = NODE_W, h = NODE_H) => ({ x: x - w / 2, y: y - h / 2 })

/** Repulsion radius covering the card's corners, with breathing room. */
const collideRadius = (w: number, h: number) => Math.hypot(w, h) / 2 + 32

/** Undirected degree per node (how connected it is). */
function degrees(input: LayoutInput): Map<string, number> {
  const deg = new Map<string, number>(input.nodes.map((n) => [n.id, 0]))
  for (const e of input.edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  return deg
}

const byLabel = (input: LayoutInput) =>
  [...input.nodes].sort((a, b) => a.label.localeCompare(b.label))

/** Sugiyama-style ranks via dagre (also used for the initial render). */
export function layoutDagre(input: LayoutInput, dir: LayoutDir): Positions {
  const { w, h } = sizeOf(input)
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: dir,
    nodesep: Math.max(48, Math.round(w * 0.3)),
    ranksep: Math.max(96, Math.round(h * 1.8)),
    // The lane reserved for edges that pass THROUGH a rank (dagre's default is
    // 10px). A rank-spanning edge renders as a near-straight line through the
    // middle ranks, so nodes there need to clear both the line and its label —
    // separation from a node is (nodesep + edgesep) / 2.
    edgesep: Math.max(170, Math.round(w * 1.0)),
  })
  for (const n of input.nodes) g.setNode(n.id, { width: w, height: h })
  // Reserve a label-sized box on every edge: rank-spanning edges then carry
  // real width through intermediate ranks, pushing those ranks' nodes clear of
  // the rendered line AND its label (React Flow centers labels mid-edge).
  for (const e of input.edges)
    g.setEdge(e.source, e.target, { width: 190, height: 32, labelpos: "c" })
  Dagre.layout(g)
  return new Map(
    input.nodes.map((n) => {
      const p = g.node(n.id)
      return [n.id, center(p.x, p.y, w, h)]
    }),
  )
}

function layoutCircle(input: LayoutInput): Positions {
  const { w, h } = sizeOf(input)
  const sorted = byLabel(input)
  const r = Math.max(180 + h, (sorted.length * (w + 56)) / (2 * Math.PI))
  return new Map(
    sorted.map((n, i) => {
      const a = (2 * Math.PI * i) / sorted.length - Math.PI / 2
      return [n.id, center(Math.cos(a) * r, Math.sin(a) * r, w, h)]
    }),
  )
}

function layoutGrid(input: LayoutInput): Positions {
  const { w, h } = sizeOf(input)
  const sorted = byLabel(input)
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
  return new Map(
    sorted.map((n, i) => [n.id, { x: (i % cols) * (w + 64), y: Math.floor(i / cols) * (h + 64) }]),
  )
}

/** Rings by connectivity: the best-connected nodes sit in the middle. */
function layoutConcentric(input: LayoutInput): Positions {
  const { w, h } = sizeOf(input)
  const deg = degrees(input)
  const ringsByDegree = new Map<number, typeof input.nodes>()
  for (const n of byLabel(input)) {
    const d = deg.get(n.id) ?? 0
    ringsByDegree.set(d, [...(ringsByDegree.get(d) ?? []), n])
  }
  const rings = [...ringsByDegree.entries()].sort((a, b) => b[0] - a[0]).map(([, ns]) => ns)

  const pos: Positions = new Map()
  let r = 0
  rings.forEach((ring, i) => {
    if (i === 0 && ring.length === 1 && ring[0]) {
      pos.set(ring[0].id, center(0, 0, w, h))
      return
    }
    r = Math.max(r + 190 + h, (ring.length * (w + 56)) / (2 * Math.PI))
    ring.forEach((n, j) => {
      // Stagger ring start angles so spokes don't line up.
      const a = (2 * Math.PI * j) / ring.length - Math.PI / 2 + i * 0.5
      pos.set(n.id, center(Math.cos(a) * r, Math.sin(a) * r, w, h))
    })
  })
  return pos
}

/** BFS rings from the best-connected node; depth = distance from the root. */
function layoutRadialTree(input: LayoutInput): Positions {
  const { w, h } = sizeOf(input)
  const deg = degrees(input)
  const adj = new Map<string, Set<string>>(input.nodes.map((n) => [n.id, new Set()]))
  for (const e of input.edges) {
    adj.get(e.source)?.add(e.target)
    adj.get(e.target)?.add(e.source)
  }
  const roots = byLabel(input).sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0))

  const levels: string[][] = []
  const seen = new Set<string>()
  // BFS from the top hub; restart from the next unseen hub so disconnected
  // components still land on sensible rings instead of vanishing.
  for (const root of roots) {
    if (seen.has(root.id)) continue
    let frontier = [root.id]
    seen.add(root.id)
    for (let depth = 0; frontier.length > 0; depth++) {
      levels[depth] = [...(levels[depth] ?? []), ...frontier]
      const next: string[] = []
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb)
            next.push(nb)
          }
        }
      }
      frontier = next
    }
  }

  const pos: Positions = new Map()
  levels.forEach((level, depth) => {
    if (depth === 0 && level.length === 1 && level[0]) {
      pos.set(level[0], center(0, 0, w, h))
      return
    }
    const r = Math.max(depth * (210 + h), (level.length * (w + 56)) / (2 * Math.PI))
    level.forEach((id, j) => {
      const a = (2 * Math.PI * j) / level.length - Math.PI / 2 + depth * 0.4
      pos.set(id, center(Math.cos(a) * r, Math.sin(a) * r, w, h))
    })
  })
  return pos
}

/** Spring-embedder physics (d3-force), ticked synchronously — small graphs only. */
function layoutForce(input: LayoutInput): Positions {
  const { w, h } = sizeOf(input)
  interface SimNode extends SimulationNodeDatum {
    id: string
  }
  const simNodes: SimNode[] = input.nodes.map((n) => ({ id: n.id }))
  const links: SimulationLinkDatum<SimNode>[] = input.edges.map((e) => ({
    source: e.source,
    target: e.target,
  }))
  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((d) => d.id)
        .distance(Math.max(260, w * 1.6))
        .strength(0.6),
    )
    .force("charge", forceManyBody().strength(-1400))
    // Collision covers the card's corners (not just its half-width), so tall
    // cards can't overlap vertically.
    .force("collide", forceCollide(collideRadius(w, h)))
    .force("center", forceCenter(0, 0))
    // Weak gravity so disconnected components don't fly off to the horizon.
    .force("x", forceX(0).strength(0.06))
    .force("y", forceY(0).strength(0.06))
    .stop()
  sim.tick(300)
  return new Map(simNodes.map((n) => [n.id, center(n.x ?? 0, n.y ?? 0, w, h)]))
}

/** ELK algorithms (layered / stress / radial / mrtree) via the bundled build.
 *  Imported lazily — ELK is ~1.3MB and only needed once an ELK layout is picked. */
async function layoutElk(input: LayoutInput, algorithm: string): Promise<Positions> {
  const { w, h } = sizeOf(input)
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js")
  const elk = new ELK()
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm,
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": String(Math.max(72, Math.round(h * 1.2))),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(Math.max(100, Math.round(h * 1.8))),
      // Keep layer-crossing edges (and their labels) clear of the nodes they pass.
      "elk.spacing.edgeNode": String(Math.max(64, Math.round(w * 0.4))),
      "elk.layered.spacing.edgeNodeBetweenLayers": "48",
      "elk.stress.desiredEdgeLength": String(Math.max(280, Math.round(w * 1.7))),
    },
    children: input.nodes.map((n) => ({ id: n.id, width: w, height: h })),
    edges: input.edges.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
  })
  return new Map((res.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))
}

/** Run the chosen auto-layout and return node positions. */
export function computeLayout(kind: LayoutKind, input: LayoutInput): Promise<Positions> {
  switch (kind) {
    case "dagre-lr":
    case "dagre-tb":
      return Promise.resolve(layoutDagre(input, LAYOUT_DIR[kind] ?? "TB"))
    case "circle":
      return Promise.resolve(layoutCircle(input))
    case "grid":
      return Promise.resolve(layoutGrid(input))
    case "concentric":
      return Promise.resolve(layoutConcentric(input))
    case "radial":
      return Promise.resolve(layoutRadialTree(input))
    case "force":
      return Promise.resolve(layoutForce(input))
    case "elk-layered":
      return layoutElk(input, "layered")
    case "elk-stress":
      return layoutElk(input, "stress")
    case "elk-radial":
      return layoutElk(input, "radial")
    case "elk-mrtree":
      return layoutElk(input, "mrtree")
  }
}
