import Dagre from "@dagrejs/dagre"
export const NODE_W = 168
export const NODE_H = 44

export type LayoutDir = "LR" | "RL" | "TB" | "BT"

/** Menu layouts. dagre is no longer one of them — it only places nodes that
 *  have no saved position (sync, so the first paint has somewhere to put them). */
export type LayoutKind = "elk-layered" | "elk-stress" | "grid"

/** What a canvas runs when nothing has been arranged yet. */
export const DEFAULT_LAYOUT: LayoutKind = "elk-layered"

/** Which way relation arrows flow for a layout — drives node handle placement. */
export const LAYOUT_DIR: Partial<Record<LayoutKind, LayoutDir>> = {
  "elk-layered": "TB",
}

/** Menu catalog, grouped the way the layout dropdown renders it. */
export const LAYOUT_GROUPS: ReadonlyArray<{
  group: string
  layouts: ReadonlyArray<{ kind: LayoutKind; name: string }>
}> = [
  {
    group: "Layout",
    layouts: [
      { kind: "elk-layered", name: "Auto" },
      { kind: "elk-stress", name: "Organic" },
      { kind: "grid", name: "Grid" },
    ],
  },
]

export interface LayoutInput {
  nodes: ReadonlyArray<{ id: string; label: string }>
  /** Deduplicated, self-loops excluded (they don't affect placement). The
   *  optional label lets layouts that support it reserve room for it. */
  edges: ReadonlyArray<{ source: string; target: string; label?: string }>
  /** The card footprint layouts reserve per node — taller cards (e.g. the
   *  record version graph's label + concept pill) get proportionally more room.
   *  Defaults to the concept-canvas box. */
  nodeSize?: { w: number; h: number }
  /** Real rendered sizes per node (from React Flow's measurement); beats
   *  `nodeSize` for layouts that can use per-node sizes. */
  sizes?: ReadonlyMap<string, { w: number; h: number }>
}

/** Enrich a layout input with what only the live canvas knows: measured node
 *  sizes and the rendered edge labels (keyed by source→target pair). */
export function withCanvasMeasures(
  input: LayoutInput,
  nodes: ReadonlyArray<{ id: string; measured?: { width?: number; height?: number } }>,
  edges: ReadonlyArray<{ source: string; target: string; label?: unknown }>,
): LayoutInput {
  const sizes = new Map<string, { w: number; h: number }>()
  for (const n of nodes) {
    const w = n.measured?.width
    const h = n.measured?.height
    if (w && h) sizes.set(n.id, { w, h })
  }
  const labels = new Map<string, string>()
  for (const e of edges) {
    if (typeof e.label === "string" && e.label) labels.set(`${e.source}->${e.target}`, e.label)
  }
  return {
    ...input,
    sizes,
    edges: input.edges.map((e) => ({
      ...e,
      label: e.label ?? labels.get(`${e.source}->${e.target}`),
    })),
  }
}

const sizeOf = (input: LayoutInput) => input.nodeSize ?? { w: NODE_W, h: NODE_H }

/** Node id → top-left position (React Flow coordinates). */
export type Positions = Map<string, { x: number; y: number }>

const center = (x: number, y: number, w = NODE_W, h = NODE_H) => ({ x: x - w / 2, y: y - h / 2 })

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

function layoutGrid(input: LayoutInput): Positions {
  const { w, h } = sizeOf(input)
  const sorted = byLabel(input)
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
  return new Map(
    sorted.map((n, i) => [n.id, { x: (i % cols) * (w + 64), y: Math.floor(i / cols) * (h + 64) }]),
  )
}

/** Rough label footprint at the canvases' 11px/500 label style. */
const labelBox = (text: string) => ({ width: text.length * 6.2 + 14, height: 20 })

type ElkApi = InstanceType<typeof import("elkjs/lib/elk.bundled.js")["default"]>

const loadElk = async (): Promise<ElkApi> => {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js")
  return new ELK()
}

/** ELK stress via the bundled build.
 *  Imported lazily — ELK is ~1.3MB and only needed once an ELK layout is picked. */
async function layoutElk(input: LayoutInput, algorithm: string): Promise<Positions> {
  const { w, h } = sizeOf(input)
  const elk = await loadElk()
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm,
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": String(Math.max(72, Math.round(h * 1.2))),
      "elk.spacing.edgeNode": String(Math.max(64, Math.round(w * 0.4))),
      "elk.stress.desiredEdgeLength": String(Math.max(280, Math.round(w * 1.7))),
    },
    children: input.nodes.map((n) => {
      const s = input.sizes?.get(n.id)
      return { id: n.id, width: s?.w ?? w, height: s?.h ?? h }
    }),
    edges: input.edges.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
  })
  return new Map((res.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))
}

/** Connected components (undirected), biggest first; ties by first label. */
function components(input: LayoutInput): string[][] {
  const parent = new Map(input.nodes.map((n) => [n.id, n.id]))
  const find = (x: string): string => {
    const p = parent.get(x) ?? x
    if (p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  for (const e of input.edges) {
    if (parent.has(e.source) && parent.has(e.target)) parent.set(find(e.source), find(e.target))
  }
  const groups = new Map<string, string[]>()
  for (const n of byLabel(input)) {
    const r = find(n.id)
    groups.set(r, [...(groups.get(r) ?? []), n.id])
  }
  return [...groups.values()].sort((a, b) => b.length - a.length)
}

const COMPONENT_GAP = 96
/** Width:height the packed block aims for — roughly a canvas viewport. */
const TARGET_ASPECT = 1.6

/**
 * The routed canvases' default: ELK layered, top-down, per connected component,
 * then the components shelf-packed into a screen-shaped block.
 *
 * Each component gets real node sizes and its edge labels as layout objects
 * (so labels get their own room between layers). Components are laid out
 * separately because ELK's own component packing stacks them into one tall
 * column for downward layouts; isolated nodes become a compact grid of their own.
 */
async function layoutElkLayered(input: LayoutInput): Promise<Positions> {
  const { w, h } = sizeOf(input)
  const sizeOfNode = (id: string) => input.sizes?.get(id) ?? { w, h }
  const elk = await loadElk()

  const comps = components(input)
  const singles = comps.filter((c) => c.length === 1).flat()
  const connected = comps.filter((c) => c.length > 1)

  type Block = { width: number; height: number; pos: Positions }
  const blocks: Block[] = await Promise.all(
    connected.map(async (ids) => {
      const inComp = new Set(ids)
      const res = await elk.layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.layered.thoroughness": "40",
          "elk.spacing.nodeNode": "48",
          "elk.layered.spacing.nodeNodeBetweenLayers": "64",
          "elk.spacing.edgeNode": "28",
          "elk.layered.spacing.edgeNodeBetweenLayers": "28",
          "elk.spacing.edgeEdge": "14",
          "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
          "elk.spacing.edgeLabel": "6",
          "elk.edgeLabels.placement": "CENTER",
          "elk.padding": "[top=0,left=0,bottom=0,right=0]",
        },
        children: ids.map((id) => ({ id, width: sizeOfNode(id).w, height: sizeOfNode(id).h })),
        edges: input.edges
          .filter((e) => inComp.has(e.source) && inComp.has(e.target))
          .map((e, i) => ({
            id: `e${i}`,
            sources: [e.source],
            targets: [e.target],
            ...(e.label ? { labels: [{ text: e.label, ...labelBox(e.label) }] } : {}),
          })),
      })
      const pos: Positions = new Map(
        (res.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]),
      )
      // Block extent from the nodes themselves (labels/routes stay inside it).
      let width = 0
      let height = 0
      for (const [id, p] of pos) {
        width = Math.max(width, p.x + sizeOfNode(id).w)
        height = Math.max(height, p.y + sizeOfNode(id).h)
      }
      return { width, height, pos }
    }),
  )

  // Unconnected nodes: one compact grid block.
  if (singles.length > 0) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(singles.length * TARGET_ASPECT)))
    const cellW = Math.max(...singles.map((id) => sizeOfNode(id).w)) + 32
    const cellH = Math.max(...singles.map((id) => sizeOfNode(id).h)) + 32
    const pos: Positions = new Map(
      singles.map((id, i) => [id, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH }]),
    )
    blocks.push({
      width: Math.min(cols, singles.length) * cellW - 32,
      height: Math.ceil(singles.length / cols) * cellH - 32,
      pos,
    })
  }

  return shelfPack(blocks)
}

/** Shelf-pack blocks (tallest first, left to right, wrapping) at the wrap width
 *  whose overall bounding box is closest to TARGET_ASPECT. Candidate widths are
 *  every prefix of the row, so 2-5 big components still land side by side. */
function shelfPack(blocks: ReadonlyArray<{ width: number; height: number; pos: Positions }>) {
  const sorted = [...blocks].sort((p, q) => q.height - p.height)
  const place = (maxW: number) => {
    const out: Positions = new Map()
    let x = 0
    let y = 0
    let shelfH = 0
    let totalW = 0
    for (const b of sorted) {
      if (x > 0 && x + b.width > maxW) {
        x = 0
        y += shelfH + COMPONENT_GAP
        shelfH = 0
      }
      for (const [id, p] of b.pos) out.set(id, { x: p.x + x, y: p.y + y })
      totalW = Math.max(totalW, x + b.width)
      x += b.width + COMPONENT_GAP
      shelfH = Math.max(shelfH, b.height)
    }
    return { out, aspect: totalW / Math.max(1, y + shelfH) }
  }
  let best: ReturnType<typeof place> | null = null
  let rowW = 0
  for (const b of sorted) {
    rowW += (rowW > 0 ? COMPONENT_GAP : 0) + b.width
    const cand = place(rowW)
    if (
      !best ||
      Math.abs(Math.log(cand.aspect / TARGET_ASPECT)) <
        Math.abs(Math.log(best.aspect / TARGET_ASPECT))
    )
      best = cand
  }
  return best?.out ?? new Map()
}

/** Run the chosen auto-layout and return node positions. */
export function computeLayout(kind: LayoutKind, input: LayoutInput): Promise<Positions> {
  switch (kind) {
    case "elk-layered":
      return layoutElkLayered(input)
    case "elk-stress":
      return layoutElk(input, "stress")
    case "grid":
      return Promise.resolve(layoutGrid(input))
  }
}
