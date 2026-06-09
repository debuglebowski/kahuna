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
  | "dagre-lr"
  | "dagre-tb"
  | "dagre-rl"
  | "dagre-bt"
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
  "dagre-rl": "RL",
  "dagre-tb": "TB",
  "dagre-bt": "BT",
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
      { kind: "dagre-lr", name: "Layered → right" },
      { kind: "dagre-tb", name: "Layered ↓ down" },
      { kind: "dagre-rl", name: "Layered ← left" },
      { kind: "dagre-bt", name: "Layered ↑ up" },
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
}

/** Node id → top-left position (React Flow coordinates). */
export type Positions = Map<string, { x: number; y: number }>

const center = (x: number, y: number) => ({ x: x - NODE_W / 2, y: y - NODE_H / 2 })

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
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: dir, nodesep: 40, ranksep: 90 })
  for (const n of input.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of input.edges) g.setEdge(e.source, e.target)
  Dagre.layout(g)
  return new Map(
    input.nodes.map((n) => {
      const p = g.node(n.id)
      return [n.id, center(p.x, p.y)]
    }),
  )
}

function layoutCircle(input: LayoutInput): Positions {
  const sorted = byLabel(input)
  const r = Math.max(180, (sorted.length * (NODE_W + 40)) / (2 * Math.PI))
  return new Map(
    sorted.map((n, i) => {
      const a = (2 * Math.PI * i) / sorted.length - Math.PI / 2
      return [n.id, center(Math.cos(a) * r, Math.sin(a) * r)]
    }),
  )
}

function layoutGrid(input: LayoutInput): Positions {
  const sorted = byLabel(input)
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
  return new Map(
    sorted.map((n, i) => [
      n.id,
      { x: (i % cols) * (NODE_W + 60), y: Math.floor(i / cols) * (NODE_H + 60) },
    ]),
  )
}

/** Rings by connectivity: the best-connected nodes sit in the middle. */
function layoutConcentric(input: LayoutInput): Positions {
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
      pos.set(ring[0].id, center(0, 0))
      return
    }
    r = Math.max(r + 200, (ring.length * (NODE_W + 48)) / (2 * Math.PI))
    ring.forEach((n, j) => {
      // Stagger ring start angles so spokes don't line up.
      const a = (2 * Math.PI * j) / ring.length - Math.PI / 2 + i * 0.5
      pos.set(n.id, center(Math.cos(a) * r, Math.sin(a) * r))
    })
  })
  return pos
}

/** BFS rings from the best-connected node; depth = distance from the root. */
function layoutRadialTree(input: LayoutInput): Positions {
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
      pos.set(level[0], center(0, 0))
      return
    }
    const r = Math.max(depth * 230, (level.length * (NODE_W + 48)) / (2 * Math.PI))
    level.forEach((id, j) => {
      const a = (2 * Math.PI * j) / level.length - Math.PI / 2 + depth * 0.4
      pos.set(id, center(Math.cos(a) * r, Math.sin(a) * r))
    })
  })
  return pos
}

/** Spring-embedder physics (d3-force), ticked synchronously — small graphs only. */
function layoutForce(input: LayoutInput): Positions {
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
        .distance(240)
        .strength(0.6),
    )
    .force("charge", forceManyBody().strength(-900))
    .force("collide", forceCollide(NODE_W / 2 + 28))
    .force("center", forceCenter(0, 0))
    // Weak gravity so disconnected components don't fly off to the horizon.
    .force("x", forceX(0).strength(0.06))
    .force("y", forceY(0).strength(0.06))
    .stop()
  sim.tick(300)
  return new Map(simNodes.map((n) => [n.id, center(n.x ?? 0, n.y ?? 0)]))
}

/** ELK algorithms (layered / stress / radial / mrtree) via the bundled build.
 *  Imported lazily — ELK is ~1.3MB and only needed once an ELK layout is picked. */
async function layoutElk(input: LayoutInput, algorithm: string): Promise<Positions> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js")
  const elk = new ELK()
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm,
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.stress.desiredEdgeLength": "260",
    },
    children: input.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: input.edges.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
  })
  return new Map((res.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))
}

/** Run the chosen auto-layout and return node positions. */
export function computeLayout(kind: LayoutKind, input: LayoutInput): Promise<Positions> {
  switch (kind) {
    case "dagre-lr":
    case "dagre-rl":
    case "dagre-tb":
    case "dagre-bt":
      return Promise.resolve(layoutDagre(input, LAYOUT_DIR[kind] ?? "LR"))
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
