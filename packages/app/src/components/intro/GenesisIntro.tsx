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
import { useEffect, useRef } from "react"
import type { IntroProps } from "./types"

/**
 * GENESIS — the org's universe is born, then becomes the app.
 *
 * Film timeline (seconds, one rAF clock):
 *
 *   VOID        0.00 ─ 0.42   a faint dot grid breathes in out of black
 *   BIRTH       0.30 ─ 1.51   concept stars ping in (sonar ring + bloom + name)
 *   WEAVE       1.02 ─ 1.94   relation edges draw themselves, light pulses board
 *   PULSE       1.90 ─ 2.24   one heartbeat — a radial wave crosses the field
 *   HOMECOMING  2.28 ─ 2.87   every star flies a curved path into the app skeleton
 *   OUTRO       3.00 ─ 3.26   the overlay lifts, revealing the real app beneath
 *
 * Editorial notes from the tuning pass:
 * - The prewarmed constellation is normalized to command the frame: positions
 *   are scaled + centered to a radius of ~0.3 × min(w, h) (clamped so every
 *   label stays in-bounds), then the link/charge forces are re-seated at the
 *   new scale so the residual BIRTH ticks breathe without contracting.
 * - Presence raised across the board (cores, halos, labels, edges, rings,
 *   plus a birth bloom) so the first pings are unmistakable by ~0.5s.
 * - HOMECOMING departures span a fixed window (all gone by ~2.5s, landed by
 *   ~2.9s regardless of concept count); arcs fan out on per-row lanes instead
 *   of random signs, morph rects stay crisp (no glow trail while flying), and
 *   the glow only pops on landing.
 * - WEAVE was tightened (stagger .05→.042, draw .5→.46) so the final edge
 *   completes exactly as the heartbeat fires — the graph finishes, then breathes.
 * - A 40ms rest was inserted between the wave completing (2.24) and the first
 *   departure (2.28) so the heartbeat lands before the exhale.
 * - Widget ghosts depart keyed by widget slot (not sidebar row) so the dashboard
 *   lights up while the sidebar is still assembling, and lands before the outro.
 * - The outro holds an extra beat (2.91→3.00) so the finished skeleton registers.
 */

/* ------------------------------------------------------------------------- */
/* TIMELINE — every act boundary, all tunable                                 */
/* ------------------------------------------------------------------------- */

const T = {
  /** Act 1 — VOID */
  gridIn0: 0,
  gridIn1: 0.42,
  /** Act 2 — BIRTH */
  birth0: 0.3,
  birthStagger: 0.09,
  birthDur: 0.58,
  birthRingDur: 0.66,
  /** Act 3 — WEAVE */
  weave0: 1.02,
  weaveStagger: 0.042,
  edgeDur: 0.46,
  /** Act 4 — PULSE */
  pulse0: 1.9,
  pulse1: 2.24,
  pulseRingDur: 0.52,
  /** Act 5 — HOMECOMING */
  home0: 2.28,
  /** departures spread across this window — last node leaves by home0 + homeSpan */
  homeSpan: 0.2,
  flightDur: 0.34,
  ghostDelay: 0.05,
  ghostStagger: 0.07,
  ghostDur: 0.4,
  dissolve: 0.3,
  skel0: 2.34,
  skelDur: 0.36,
  landFx: 0.2,
  /** OUTRO */
  outro0: 3.0,
  outroDur: 0.26,
  /** UX */
  hintAt: 1.2,
  hintFade: 0.45,
  skipDur: 0.2,
  /** prefers-reduced-motion variant */
  calmFade: 0.6,
  calmHold: 0.45,
} as const

/* ------------------------------------------------------------------------- */
/* PALETTE — monochrome plus one cool accent                                  */
/* ------------------------------------------------------------------------- */

const ACCENT_RGB = "207, 226, 255" // #cfe2ff
const CORE_RGB = "244, 248, 255"
const ACCENT = `rgb(${ACCENT_RGB})`
const CORE = `rgb(${CORE_RGB})`
const WHITE = "rgb(255, 255, 255)"
const BG_INNER = "#0a0c11"
const BG_OUTER = "#020204"

const A = {
  grid: 0.06,
  edge: 0.35,
  label: 0.85,
  halo: 0.16,
  haloBySize: 0.28,
  skeleton: 0.16,
  rowFill: 0.06,
  rowStroke: 0.13,
} as const

/* ------------------------------------------------------------------------- */
/* FORCES — d3 layout parameters                                              */
/* ------------------------------------------------------------------------- */

const F = {
  charge: -180,
  linkDistance: 110,
  linkStrength: 0.55,
  collidePad: 18,
  axisPull: 0.05,
  prewarmTicks: 120,
  birthAlpha: 0.09,
  restAlpha: 0.012,
  /** settled layout is normalized to this radius fraction of min(w, h) */
  spreadFrac: 0.3,
  spreadMargin: 28,
  spreadMin: 0.7,
  spreadMax: 3.2,
} as const

/* ------------------------------------------------------------------------- */
/* LAYOUT — constellation + skeleton app geometry                             */
/* ------------------------------------------------------------------------- */

const L = {
  rMin: 4,
  rMax: 14,
  rScale: 0.7,
  haloScale: 4.2,
  ringSpan: 92,
  pulseRingSpan: 64,
  labelGap: 9,
  gridStep: 56,
  // flight arcs — perpendicular bezier offsets fan out by sidebar-row lane
  flightFan: 38,
  flightJitter: 24,
  flightFanMax: 190,
  ghostFan: 110,
  // skeleton app
  sbX: 24,
  sbW: 220,
  sbTop: 96,
  rowH: 32,
  rowGap: 8,
  rowR: 8,
  pad: 24,
  topbarY: 72,
  contentInset: 16,
  widgetH: 144,
  widgetGap: 16,
} as const

const fontLabel = (size: number) =>
  `500 ${size}px "Geist Variable", ui-sans-serif, system-ui, sans-serif`
const FONT_LABEL = fontLabel(12.5)
const FONT_BRAND = '600 13px "Geist Variable", ui-sans-serif, system-ui, sans-serif'
const FONT_COUNT = '500 11px "Geist Variable", ui-sans-serif, system-ui, sans-serif'
const FONT_WIDGET_NAME = '500 12px "Geist Variable", ui-sans-serif, system-ui, sans-serif'
const FONT_WIDGET_COUNT = '600 30px "Geist Variable", ui-sans-serif, system-ui, sans-serif'

const WAVE = {
  pad: 90,
  band: 150,
  lift: 0.45,
} as const

const SEED = 20260610

interface ConceptDatum {
  name: string
  count: number
}

const DEFAULT_CONCEPTS: ConceptDatum[] = [
  { name: "Vendor", count: 128 },
  { name: "Project", count: 34 },
  { name: "Task", count: 412 },
  { name: "Person", count: 56 },
  { name: "Document", count: 203 },
  { name: "Event", count: 17 },
  { name: "Invoice", count: 88 },
  { name: "Meeting", count: 41 },
]

/* ------------------------------------------------------------------------- */
/* MATH — easings (nothing moves linearly) + tiny seeded LCG                  */
/* ------------------------------------------------------------------------- */

const TAU = Math.PI * 2
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOutBack = (t: number, k = 1.35) => {
  const u = t - 1
  return 1 + (k + 1) * u ** 3 + k * u * u
}
const bell = (t: number) => Math.sin(Math.PI * clamp01(t))
/** Quadratic bezier on one axis — works for t slightly > 1 (landing overshoot). */
const qBez = (a: number, c: number, b: number, p: number) => {
  const q = 1 - p
  return q * q * a + 2 * q * p * c + p * p * b
}

function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function makeGlowSprite(size: number, rgb: string) {
  const c = document.createElement("canvas")
  c.width = size
  c.height = size
  const g = c.getContext("2d")
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, `rgba(${rgb}, 1)`)
    grad.addColorStop(0.22, `rgba(${rgb}, 0.5)`)
    grad.addColorStop(0.55, `rgba(${rgb}, 0.13)`)
    grad.addColorStop(1, `rgba(${rgb}, 0)`)
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  }
  return c
}

/** Rounded-rect path via arcTo — no reliance on ctx.roundRect. */
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2))
  g.beginPath()
  g.moveTo(x + rad, y)
  g.arcTo(x + w, y, x + w, y + h, rad)
  g.arcTo(x + w, y + h, x, y + h, rad)
  g.arcTo(x, y + h, x, y, rad)
  g.arcTo(x, y, x + w, y, rad)
  g.closePath()
}

/* ------------------------------------------------------------------------- */
/* SIM TYPES — pre-allocated pools, scratch fields instead of per-frame objs  */
/* ------------------------------------------------------------------------- */

interface GNode extends SimulationNodeDatum {
  x: number
  y: number
  name: string
  count: number
  countStr: string
  r: number
  sizeNorm: number
  labelW: number
  born: number
  rowIdx: number
  widgetIdx: number
  seedCurve: number
  waveD: number
  pulseAt: number
  // flight, captured when HOMECOMING begins
  departAt: number
  sx: number
  sy: number
  cpx: number
  cpy: number
  hx: number
  hy: number
  hw: number
  hh: number
  // ghost flight → dashboard widget (largest nodes only)
  gDepartAt: number
  gcx: number
  gcy: number
  ghx: number
  ghy: number
  ghw: number
  ghh: number
  // per-frame scratch (zero allocation inside the rAF loop)
  fu: number
  px: number
  py: number
  mw: number
  mh: number
  mr: number
  gfu: number
  gpx: number
  gpy: number
  gmw: number
  gmh: number
}

interface GEdge extends SimulationLinkDatum<GNode> {
  source: GNode
  target: GNode
  revealAt: number
}

interface LightPulse {
  e: GEdge
  phase: number
  speed: number
  dir: number
  size: number
}

/* ------------------------------------------------------------------------- */
/* COMPONENT                                                                  */
/* ------------------------------------------------------------------------- */

export function GenesisIntro({ onDone, concepts }: IntroProps & { concepts?: ConceptDatum[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const conceptsRef = useRef(concepts)
  conceptsRef.current = concepts

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const hint = hintRef.current
    if (!container || !canvas || !hint) return
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) return

    /* ---- everything below is created per mount: StrictMode-safe ---- */

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const rng = makeRng(SEED)
    const source = conceptsRef.current
    const data = (source && source.length > 0 ? source : DEFAULT_CONCEPTS).slice(0, 14)
    const n = data.length

    /* ---- build the node pool ---- */

    let sqMin = Number.POSITIVE_INFINITY
    let sqMax = 0
    for (const d of data) {
      const s = Math.sqrt(Math.max(0, d.count))
      if (s < sqMin) sqMin = s
      if (s > sqMax) sqMax = s
    }
    const sqSpan = Math.max(1e-6, sqMax - sqMin)

    const w0 = window.innerWidth
    const h0 = window.innerHeight
    ctx.font = FONT_LABEL
    const nodes: GNode[] = data.map((d, i) => {
      const sq = Math.sqrt(Math.max(0, d.count))
      const ang = i * 2.39996 + rng() * 0.9 // golden-angle spawn ring + seeded jitter
      const rad = Math.min(w0, h0) * (0.16 + 0.1 * rng()) + 40
      return {
        x: w0 / 2 + Math.cos(ang) * rad,
        y: h0 / 2 + Math.sin(ang) * rad,
        name: d.name,
        count: d.count,
        countStr: String(d.count),
        r: Math.min(L.rMax, Math.max(L.rMin, sq * L.rScale)),
        sizeNorm: (sq - sqMin) / sqSpan,
        labelW: ctx.measureText(d.name).width,
        born: T.birth0,
        rowIdx: i,
        widgetIdx: -1,
        seedCurve: rng() * 2 - 1,
        waveD: 0,
        pulseAt: Number.POSITIVE_INFINITY,
        departAt: 0,
        sx: 0,
        sy: 0,
        cpx: 0,
        cpy: 0,
        hx: 0,
        hy: 0,
        hw: 0,
        hh: 0,
        gDepartAt: 0,
        gcx: 0,
        gcy: 0,
        ghx: 0,
        ghy: 0,
        ghw: 0,
        ghh: 0,
        fu: 0,
        px: 0,
        py: 0,
        mw: 0,
        mh: 0,
        mr: 0,
        gfu: 0,
        gpx: 0,
        gpy: 0,
        gmw: 0,
        gmh: 0,
      }
    })

    // seeded shuffle → composed-looking birth order
    const order = nodes.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = order[i]!
      order[i] = order[j]!
      order[j] = tmp
    }
    for (let k = 0; k < order.length; k++) {
      nodes[order[k]!]!.born = T.birth0 + k * T.birthStagger
    }

    // the largest concepts also project a ghost into a dashboard widget
    const widgetCount = Math.max(0, Math.min(3, n - 5))
    const byCount = nodes.slice().sort((a, b) => b.count - a.count)
    for (let k = 0; k < widgetCount; k++) byCount[k]!.widgetIdx = k

    /* ---- deterministic fake relations (i → i*7+3, i → i*3+5) ---- */

    const edges: GEdge[] = []
    const seen = new Set<number>()
    const addEdge = (i: number, j0: number) => {
      if (n < 2) return
      let j = j0 % n
      if (j === i) j = (j + 1) % n
      const key = i < j ? i * 64 + j : j * 64 + i
      if (seen.has(key)) return
      seen.add(key)
      edges.push({ source: nodes[i]!, target: nodes[j]!, revealAt: 0 })
    }
    for (let i = 0; i < n; i++) {
      addEdge(i, (i * 7 + 3) % n)
      addEdge(i, (i * 3 + 5) % n)
    }
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = edges[i]!
      edges[i] = edges[j]!
      edges[j] = tmp
    }
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!
      e.revealAt = Math.max(
        T.weave0 + i * T.weaveStagger,
        e.source.born + 0.25,
        e.target.born + 0.25,
      )
    }

    const pulses: LightPulse[] = []
    for (const e of edges) {
      const count = 1 + (rng() < 0.4 ? 1 : 0)
      for (let p = 0; p < count; p++) {
        pulses.push({
          e,
          phase: rng(),
          speed: 0.55 + rng() * 0.5,
          dir: rng() < 0.5 ? -1 : 1,
          size: 14 + rng() * 10,
        })
      }
    }

    /* ---- d3-force layout, pre-warmed so the reveal is already elegant ---- */

    const centerF = forceCenter<GNode>(w0 / 2, h0 / 2)
    const xF = forceX<GNode>(w0 / 2).strength(F.axisPull)
    const yF = forceY<GNode>(h0 / 2).strength(F.axisPull * 1.3)
    const chargeF = forceManyBody<GNode>().strength(F.charge)
    const linkF = forceLink<GNode, GEdge>(edges).distance(F.linkDistance).strength(F.linkStrength)
    const sim = forceSimulation<GNode>(nodes)
      .force("charge", chargeF)
      .force("link", linkF)
      .force(
        "collide",
        forceCollide<GNode>()
          .radius((d) => Math.max(d.r + F.collidePad, d.r + L.labelGap + d.labelW * 0.62))
          .iterations(2),
      )
      .force("center", centerF)
      .force("x", xF)
      .force("y", yF)
      .stop()
    for (let i = 0; i < F.prewarmTicks; i++) sim.tick()

    // normalize the settled layout so the constellation commands the viewport:
    // scale + center the prewarmed positions to ~spreadFrac × min(w, h), then
    // re-seat link distance (×k) and charge (×k²) so the scaled state stays the
    // equilibrium — residual BIRTH ticks breathe instead of contracting.
    {
      let cx = 0
      let cy = 0
      for (const nd of nodes) {
        cx += nd.x
        cy += nd.y
      }
      cx /= Math.max(1, n)
      cy /= Math.max(1, n)
      let spread = 1
      for (const nd of nodes) {
        spread = Math.max(spread, Math.hypot(nd.x - cx, nd.y - cy) + nd.r)
      }
      let k = (F.spreadFrac * Math.min(w0, h0)) / spread
      for (const nd of nodes) {
        // never push a node (or its right-hand label) out of frame
        const dx = nd.x - cx
        const dy = nd.y - cy
        const rx = dx > 0 ? nd.r + L.labelGap + nd.labelW : nd.r
        if (Math.abs(dx) > 1) k = Math.min(k, (w0 / 2 - F.spreadMargin - rx) / Math.abs(dx))
        if (Math.abs(dy) > 1) k = Math.min(k, (h0 / 2 - F.spreadMargin - nd.r) / Math.abs(dy))
      }
      k = Math.max(F.spreadMin, Math.min(F.spreadMax, k))
      for (const nd of nodes) {
        nd.x = w0 / 2 + (nd.x - cx) * k
        nd.y = h0 / 2 + (nd.y - cy) * k
      }
      linkF.distance(F.linkDistance * k)
      chargeF.strength(F.charge * k * k)
    }
    sim.alpha(F.birthAlpha) // residual energy: the field breathes during BIRTH

    /* ---- sprites + per-resize offscreen layers ---- */

    const glow = makeGlowSprite(160, ACCENT_RGB)
    const glowCore = makeGlowSprite(120, CORE_RGB)
    let vignette: HTMLCanvasElement | null = null
    let gridLayer: HTMLCanvasElement | null = null

    /* ---- run state ---- */

    let raf = 0
    let running = true
    let t0 = -1
    let lastT = 0
    let w = 0
    let h = 0
    let dpr = 1
    let mode: 0 | 1 | 2 = 0 // 0 play · 1 skipping · 2 finished
    let skipT = 0
    let outroStarted = false
    let flightsCaptured = false
    let waveCaptured = false
    let waveSpan = 1
    let hintShown = -1

    const finish = () => {
      if (mode === 2) return
      mode = 2
      running = false
      cancelAnimationFrame(raf)
      if (!doneRef.current) {
        doneRef.current = true
        onDoneRef.current()
      }
    }

    const skip = () => {
      if (mode !== 0 || outroStarted) return
      mode = 1
      skipT = lastT
    }

    /** Skip/outro overlay fade. Returns true once the run is over. */
    const applyFade = (t: number, outStart: number): boolean => {
      if (mode === 1) {
        const f = (t - skipT) / T.skipDur
        if (f >= 1) {
          finish()
          return true
        }
        container.style.opacity = String(1 - clamp01(f))
      } else if (t >= outStart) {
        outroStarted = true
        const f = (t - outStart) / T.outroDur
        if (f >= 1) {
          finish()
          return true
        }
        container.style.opacity = String(1 - easeInOutCubic(clamp01(f)))
      }
      return false
    }

    /* ---- skeleton-app home slots (recomputed on resize) ---- */

    const computeHomes = () => {
      const pitch = Math.min(
        L.rowH + L.rowGap,
        Math.max(L.rowH + 2, (h - L.sbTop - L.pad) / Math.max(1, n)),
      )
      const fx0 = L.sbX + L.sbW + L.pad
      const wx0 = fx0 + L.contentInset
      const wx1 = w - L.pad - L.contentInset
      const cw = Math.max(120, (wx1 - wx0 - L.widgetGap) / 2)
      for (const nd of nodes) {
        nd.hx = L.sbX + L.sbW / 2
        nd.hy = L.sbTop + nd.rowIdx * pitch + L.rowH / 2
        nd.hw = L.sbW
        nd.hh = L.rowH
        if (nd.widgetIdx >= 0) {
          const col = nd.widgetIdx % 2
          const row = Math.floor(nd.widgetIdx / 2)
          nd.ghw = cw
          nd.ghh = L.widgetH
          nd.ghx = wx0 + col * (cw + L.widgetGap) + cw / 2
          nd.ghy = L.sbTop + L.contentInset + row * (L.widgetH + L.widgetGap) + L.widgetH / 2
        }
      }
    }

    const layout = () => {
      const ow = w
      const oh = h
      w = window.innerWidth
      h = window.innerHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))

      const vg = document.createElement("canvas")
      vg.width = canvas.width
      vg.height = canvas.height
      const vctx = vg.getContext("2d")
      if (vctx) {
        vctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const grad = vctx.createRadialGradient(
          w / 2,
          h * 0.46,
          0,
          w / 2,
          h / 2,
          Math.hypot(w, h) * 0.55,
        )
        grad.addColorStop(0, BG_INNER)
        grad.addColorStop(1, BG_OUTER)
        vctx.fillStyle = grad
        vctx.fillRect(0, 0, w, h)
      }
      vignette = vg

      const gl = document.createElement("canvas")
      gl.width = canvas.width
      gl.height = canvas.height
      const gctx = gl.getContext("2d")
      if (gctx) {
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        gctx.fillStyle = WHITE
        const ox = ((w % L.gridStep) + L.gridStep) / 2
        const oy = ((h % L.gridStep) + L.gridStep) / 2
        for (let gy = oy; gy <= h; gy += L.gridStep) {
          for (let gx = ox; gx <= w; gx += L.gridStep) {
            gctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5)
          }
        }
      }
      gridLayer = gl

      if (ow > 0) {
        // keep the field centered through resizes; flights keep continuity
        const dx = (w - ow) / 2
        const dy = (h - oh) / 2
        for (const nd of nodes) {
          nd.x += dx
          nd.y += dy
          nd.sx += dx
          nd.sy += dy
          nd.cpx += dx
          nd.cpy += dy
          nd.gcx += dx
          nd.gcy += dy
        }
      }
      centerF.x(w / 2).y(h / 2)
      xF.x(w / 2)
      yF.y(h / 2)
      computeHomes()

      // guarantee an opaque dark frame immediately
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = BG_OUTER
      ctx.fillRect(0, 0, w, h)
    }

    /* ---- one-time captures on the clock ---- */

    const captureWave = () => {
      waveCaptured = true
      let maxD = 0
      for (const nd of nodes) {
        nd.waveD = Math.hypot(nd.x - w / 2, nd.y - h / 2)
        if (nd.waveD > maxD) maxD = nd.waveD
      }
      waveSpan = maxD + WAVE.pad
      const waveDur = T.pulse1 - T.pulse0
      for (const nd of nodes) {
        // ring re-emits the instant the wavefront crosses the node
        nd.pulseAt = T.pulse0 + waveDur * (1 - Math.cbrt(1 - Math.min(1, nd.waveD / waveSpan)))
      }
    }

    const captureFlights = () => {
      flightsCaptured = true
      sim.stop()
      const rowSpan = Math.max(1, n - 1)
      for (const nd of nodes) {
        // every node departs within homeSpan, regardless of concept count
        nd.departAt = T.home0 + (nd.rowIdx / rowSpan) * T.homeSpan
        nd.sx = nd.x
        nd.sy = nd.y
        const dx = nd.hx - nd.sx
        const dy = nd.hy - nd.sy
        const len = Math.max(1, Math.hypot(dx, dy))
        // fan: perpendicular offset keyed to the row lane, so arcs spread out
        // instead of piling through the same mid-screen corridor
        const lane = nd.rowIdx - (n - 1) / 2
        const off = Math.max(
          -L.flightFanMax,
          Math.min(L.flightFanMax, lane * L.flightFan + nd.seedCurve * L.flightJitter),
        )
        nd.cpx = (nd.sx + nd.hx) / 2 + (-dy / len) * off
        nd.cpy = (nd.sy + nd.hy) / 2 + (dx / len) * off
        if (nd.widgetIdx >= 0) {
          nd.gDepartAt = T.home0 + T.ghostDelay + nd.widgetIdx * T.ghostStagger
          const gdx = nd.ghx - nd.sx
          const gdy = nd.ghy - nd.sy
          const glen = Math.max(1, Math.hypot(gdx, gdy))
          const gLane = nd.widgetIdx - (widgetCount - 1) / 2
          const goff = Math.max(
            -L.flightFanMax,
            Math.min(L.flightFanMax, gLane * L.ghostFan + nd.seedCurve * L.flightJitter),
          )
          nd.gcx = (nd.sx + nd.ghx) / 2 + (-gdy / glen) * goff
          nd.gcy = (nd.sy + nd.ghy) / 2 + (gdx / glen) * goff
        }
      }
    }

    /* ---- draw helpers (closures over ctx; allocation-free) ---- */

    const drawGlow = (
      img: HTMLCanvasElement,
      x: number,
      y: number,
      size: number,
      alpha: number,
    ) => {
      if (alpha <= 0.004 || size <= 0.5) return
      ctx.globalAlpha = Math.min(1, alpha)
      ctx.drawImage(img, x - size / 2, y - size / 2, size, size)
    }

    const drawRing = (
      x: number,
      y: number,
      base: number,
      u: number,
      alphaMax: number,
      span: number,
    ) => {
      if (u <= 0 || u >= 1 || alphaMax <= 0.004) return
      ctx.globalAlpha = (1 - u) * (1 - u) * alphaMax
      ctx.lineWidth = 1.25 + (1 - u) * 1.5
      ctx.strokeStyle = ACCENT
      ctx.beginPath()
      ctx.arc(x, y, base + easeOutExpo(u) * span, 0, TAU)
      ctx.stroke()
    }

    /* ---- THE FRAME ---- */

    const framePlay = (nowMs: number) => {
      if (!running) return
      if (t0 < 0) t0 = nowMs
      const t = (nowMs - t0) / 1000
      lastT = t
      if (applyFade(t, T.outro0)) return

      if (!waveCaptured && t >= T.pulse0) captureWave()
      if (!flightsCaptured && t >= T.home0) captureFlights()
      // gentle decaying ticks: the constellation breathes without jittering
      if (t >= T.birth0 && t < T.pulse0 && sim.alpha() > F.restAlpha) sim.tick()

      const hintA = clamp01((t - T.hintAt) / T.hintFade) * (1 - clamp01((t - T.home0) / 0.25))
      if (Math.abs(hintA - hintShown) > 0.02) {
        hintShown = hintA
        hint.style.opacity = String(hintA)
      }

      // shared act factors
      const dissolveU = easeInOutCubic(clamp01((t - T.home0) / T.dissolve))
      const constellation = 1 - dissolveU // edges/halos/grid melt as data departs
      const actU = clamp01((t - T.pulse0) / (T.pulse1 - T.pulse0))
      const heartbeat = bell(actU) * WAVE.lift
      const waveR = waveCaptured ? easeOutCubic(actU) * waveSpan : 0

      // flight scratch pre-pass — positions/sizes written into pooled fields
      for (const nd of nodes) {
        const fu = flightsCaptured ? clamp01((t - nd.departAt) / T.flightDur) : 0
        nd.fu = fu
        if (fu <= 0) {
          nd.px = nd.x
          nd.py = nd.y
        } else {
          const pb = easeOutBack(easeInOutCubic(fu), 1.1)
          nd.px = qBez(nd.sx, nd.cpx, nd.hx, pb)
          nd.py = qBez(nd.sy, nd.cpy, nd.hy, pb)
          // grow late (eased²) so flying shapes stay star-sized through the
          // corridor and only widen on approach — "snap into the layout"
          const grow = easeInOutCubic(fu)
          nd.mw = lerp(nd.r * 2, nd.hw, grow * grow)
          nd.mh = lerp(nd.r * 2, nd.hh, grow)
          nd.mr = lerp(nd.r, L.rowR, fu)
        }
        if (nd.widgetIdx >= 0 && flightsCaptured) {
          const gu = clamp01((t - nd.gDepartAt) / T.ghostDur)
          nd.gfu = gu
          if (gu > 0) {
            const gp = easeOutBack(easeInOutCubic(gu), 0.9)
            nd.gpx = qBez(nd.sx, nd.gcx, nd.ghx, gp)
            nd.gpy = qBez(nd.sy, nd.gcy, nd.ghy, gp)
            const gg = easeInOutCubic(gu)
            nd.gmw = lerp(nd.r * 2, nd.ghw, gg * gg)
            nd.gmh = lerp(nd.r * 2, nd.ghh, gg * gg)
          }
        } else {
          nd.gfu = 0
        }
      }

      /* -- paint -- */

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = "source-over"
      ctx.globalAlpha = 1
      ctx.textBaseline = "middle"
      ctx.textAlign = "left"
      ctx.lineCap = "round"
      if (vignette) ctx.drawImage(vignette, 0, 0, w, h)

      // ACT 1 — VOID: faint dot grid as a depth cue
      const gridA =
        A.grid * easeInOutCubic(clamp01((t - T.gridIn0) / (T.gridIn1 - T.gridIn0))) * constellation
      if (gridLayer && gridA > 0.002) {
        ctx.globalAlpha = gridA
        ctx.drawImage(gridLayer, 0, 0, w, h)
      }

      // ACT 5 — skeleton scaffold under everything that still glows
      const su = clamp01((t - T.skel0) / T.skelDur)
      if (su > 0) {
        const divX = L.sbX + L.sbW + 12
        ctx.strokeStyle = WHITE
        ctx.lineWidth = 1
        ctx.globalAlpha = A.skeleton
        ctx.beginPath()
        ctx.moveTo(divX, 0)
        ctx.lineTo(divX, h * easeInOutCubic(su))
        ctx.stroke()
        const su2 = clamp01((t - T.skel0 - 0.07) / T.skelDur)
        if (su2 > 0) {
          ctx.beginPath()
          ctx.moveTo(divX, L.topbarY)
          ctx.lineTo(divX + (w - divX) * easeInOutCubic(su2), L.topbarY)
          ctx.stroke()
        }
        const su3 = easeInOutCubic(clamp01((t - T.skel0 - 0.14) / T.skelDur))
        if (su3 > 0) {
          const fx0 = L.sbX + L.sbW + L.pad
          rr(ctx, fx0, L.sbTop, w - fx0 - L.pad, h - L.sbTop - L.pad, 12)
          ctx.globalAlpha = A.skeleton * 0.7 * su3
          ctx.stroke()
        }
        const su4 = easeInOutCubic(clamp01((t - T.skel0 - 0.12) / 0.3))
        if (su4 > 0) {
          ctx.globalAlpha = 0.85 * su4
          rr(ctx, L.sbX + 8, 38, 12, 12, 4)
          ctx.fillStyle = ACCENT
          ctx.fill()
          ctx.fillStyle = WHITE
          ctx.font = FONT_BRAND
          ctx.fillText("Kahuna", L.sbX + 28, 44.5)
        }
      }

      /* -- additive constellation pass -- */
      ctx.globalCompositeOperation = "lighter"

      // ACT 4 — the heartbeat wave crossing the field
      if (waveCaptured && actU > 0 && actU < 1 && constellation > 0.01) {
        const waveA = bell(actU) * constellation
        ctx.strokeStyle = ACCENT
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, waveR, 0, TAU)
        ctx.lineWidth = 44
        ctx.globalAlpha = 0.075 * waveA
        ctx.stroke()
        ctx.lineWidth = 1.5
        ctx.globalAlpha = 0.3 * waveA
        ctx.stroke()
      }

      // ACT 3 — WEAVE: edges dash-reveal with a comet head
      if (constellation > 0.004) {
        ctx.strokeStyle = ACCENT
        ctx.lineWidth = 1
        for (const e of edges) {
          const u = clamp01((t - e.revealAt) / T.edgeDur)
          if (u <= 0) continue
          const reveal = easeInOutCubic(u)
          const ex = lerp(e.source.x, e.target.x, reveal)
          const ey = lerp(e.source.y, e.target.y, reveal)
          ctx.globalAlpha = A.edge * constellation * Math.min(1, u * 3) * (1 + heartbeat * 1.4)
          ctx.beginPath()
          ctx.moveTo(e.source.x, e.source.y)
          ctx.lineTo(ex, ey)
          ctx.stroke()
          if (u < 1) drawGlow(glowCore, ex, ey, 24, 0.9 * (1 - u) * constellation)
        }
        // traveling light pulses
        for (const p of pulses) {
          const live = t - p.e.revealAt - T.edgeDur
          if (live <= 0) continue
          const boardIn = Math.min(1, live * 5)
          const frac = (((t * p.speed * p.dir + p.phase) % 1) + 1) % 1
          const px = lerp(p.e.source.x, p.e.target.x, frac)
          const py = lerp(p.e.source.y, p.e.target.y, frac)
          drawGlow(glow, px, py, p.size, (0.5 + heartbeat * 0.8) * boardIn * constellation)
        }
      }

      // ACT 2 + 4 — sonar rings: birth ping, then heartbeat re-emit
      for (const nd of nodes) {
        drawRing(
          nd.x,
          nd.y,
          nd.r + 2,
          (t - nd.born) / T.birthRingDur,
          0.85 * constellation,
          L.ringSpan,
        )
        drawRing(
          nd.x,
          nd.y,
          nd.r + 2,
          (t - nd.pulseAt) / T.pulseRingDur,
          0.6 * constellation,
          L.pulseRingSpan,
        )
      }

      // nodes — halo + core (resting) or glow trail (flying), plus land flashes
      for (const nd of nodes) {
        const bu = clamp01((t - nd.born) / T.birthDur)
        if (bu <= 0) continue
        const boost = waveCaptured ? bell(clamp01((waveR - nd.waveD) / WAVE.band)) : 0
        if (nd.fu <= 0) {
          // birth bloom — a bright transient flash so the first pings carry
          const pop = bell(Math.min(1, bu * 1.3))
          if (bu < 1 && pop > 0.01) {
            drawGlow(glowCore, nd.px, nd.py, 60 + nd.r * 4.5, pop * 0.6 * constellation)
          }
          const haloA =
            (A.halo + nd.sizeNorm * A.haloBySize) *
            Math.min(1, bu * 1.4) *
            (1 + boost * 1.8 + heartbeat) *
            Math.max(constellation, 0.25)
          drawGlow(glow, nd.px, nd.py, nd.r * L.haloScale * 2 * (1 + boost * 0.35), haloA)
          ctx.globalAlpha = Math.min(1, bu * 2.4 * (1 + boost * 0.3))
          ctx.fillStyle = CORE
          ctx.beginPath()
          ctx.arc(nd.px, nd.py, nd.r * easeOutBack(bu, 1.7) * (1 + boost * 0.12), 0, TAU)
          ctx.fill()
        } else if (nd.fu < 1) {
          // crisp flight: just a faint glint at the shape — no heavy glow trail
          drawGlow(glow, nd.px, nd.py, 34, 0.18 * (1 - nd.fu))
        } else {
          const lu = (t - nd.departAt - T.flightDur) / T.landFx
          if (lu > 0 && lu < 1) drawGlow(glow, nd.hx, nd.hy, 170, bell(lu) * 0.42)
        }
        if (nd.gfu > 0 && nd.gfu < 1) {
          drawGlow(glow, nd.gpx, nd.gpy, 30, 0.16 * (1 - nd.gfu))
        } else if (nd.gfu >= 1) {
          const glu = (t - nd.gDepartAt - T.ghostDur) / T.landFx
          if (glu > 0 && glu < 1) drawGlow(glow, nd.ghx, nd.ghy, 240, bell(glu) * 0.4)
        }
      }

      /* -- UI pass: labels, flights, landed rows, widgets -- */
      ctx.globalCompositeOperation = "source-over"
      ctx.font = FONT_LABEL
      ctx.fillStyle = WHITE

      for (const nd of nodes) {
        const bu = clamp01((t - nd.born) / T.birthDur)
        if (bu <= 0) continue

        if (nd.fu <= 0) {
          // resting constellation label, fading in beside the star
          const lu = clamp01((bu - 0.38) / 0.62)
          if (lu > 0) {
            ctx.globalAlpha = Math.min(1, A.label * easeOutCubic(lu) * (1 + heartbeat * 0.45))
            const slide = (1 - easeOutCubic(lu)) * 5
            ctx.fillText(nd.name, nd.x + nd.r + L.labelGap - slide, nd.y + 0.5)
          }
        } else if (nd.fu < 1) {
          // mid-flight: crisp circle → rounded rect morph (the glow stays home)
          rr(ctx, nd.px - nd.mw / 2, nd.py - nd.mh / 2, nd.mw, nd.mh, nd.mr)
          ctx.fillStyle = CORE
          ctx.globalAlpha = 0.95 * (1 - nd.fu) ** 2
          ctx.fill()
          ctx.fillStyle = ACCENT
          ctx.globalAlpha = lerp(0.3, 0.08, nd.fu)
          ctx.fill()
          ctx.strokeStyle = WHITE
          ctx.lineWidth = 1
          ctx.globalAlpha = lerp(0.12, 0.42, easeInOutCubic(nd.fu))
          ctx.stroke()
          ctx.fillStyle = WHITE
          if (nd.fu < 0.4) {
            // label shrinks + fades out in the first part of the flight
            const s = 1 - easeInOutCubic(nd.fu / 0.4)
            ctx.globalAlpha = A.label * s
            ctx.font = fontLabel(9 + 3.5 * s)
            ctx.fillText(nd.name, nd.px + nd.r + L.labelGap, nd.py + 0.5)
            ctx.font = FONT_LABEL
          } else if (nd.fu > 0.68) {
            // row label fades back in on final approach, anchored to the rect
            const li = (nd.fu - 0.68) / 0.32
            ctx.globalAlpha = 0.9 * easeOutCubic(li)
            ctx.fillText(nd.name, nd.px - nd.mw / 2 + lerp(12, 30, li), nd.py + 0.5)
          }
        } else {
          // landed: a quiet sidebar row
          const acc = clamp01((t - nd.departAt - T.flightDur) / T.landFx)
          const x0 = nd.hx - nd.hw / 2
          rr(ctx, x0, nd.hy - nd.hh / 2, nd.hw, nd.hh, L.rowR)
          ctx.fillStyle = WHITE
          ctx.globalAlpha = A.rowFill
          ctx.fill()
          ctx.strokeStyle = WHITE
          ctx.lineWidth = 1
          ctx.globalAlpha = A.rowStroke
          ctx.stroke()
          rr(ctx, x0 + 10, nd.hy - 5, 10, 10, 3)
          ctx.fillStyle = ACCENT
          ctx.globalAlpha = 0.55 * acc
          ctx.fill()
          ctx.fillStyle = WHITE
          ctx.globalAlpha = 0.9
          ctx.fillText(nd.name, x0 + 30, nd.hy + 0.5)
          ctx.globalAlpha = 0.46 * acc
          ctx.font = FONT_COUNT
          ctx.textAlign = "right"
          ctx.fillText(nd.countStr, nd.hx + nd.hw / 2 - 12, nd.hy + 0.5)
          ctx.textAlign = "left"
          ctx.font = FONT_LABEL
        }

        // ghost flight → dashboard widget for the largest concepts
        if (nd.gfu > 0) {
          if (nd.gfu < 1) {
            rr(
              ctx,
              nd.gpx - nd.gmw / 2,
              nd.gpy - nd.gmh / 2,
              nd.gmw,
              nd.gmh,
              lerp(nd.r, 12, nd.gfu),
            )
            ctx.fillStyle = ACCENT
            ctx.globalAlpha = lerp(0.26, 0.07, nd.gfu)
            ctx.fill()
            ctx.strokeStyle = WHITE
            ctx.lineWidth = 1
            ctx.globalAlpha = lerp(0.1, 0.32, easeInOutCubic(nd.gfu))
            ctx.stroke()
          } else {
            const gacc = clamp01((t - nd.gDepartAt - T.ghostDur) / T.landFx)
            const gx0 = nd.ghx - nd.ghw / 2
            const gy0 = nd.ghy - nd.ghh / 2
            rr(ctx, gx0, gy0, nd.ghw, nd.ghh, 12)
            ctx.fillStyle = ACCENT
            ctx.globalAlpha = 0.06
            ctx.fill()
            ctx.strokeStyle = WHITE
            ctx.lineWidth = 1
            ctx.globalAlpha = 0.14
            ctx.stroke()
            ctx.fillStyle = WHITE
            ctx.globalAlpha = 0.6 * gacc
            ctx.font = FONT_WIDGET_NAME
            ctx.fillText(nd.name, gx0 + 16, gy0 + 24)
            ctx.fillStyle = ACCENT
            ctx.globalAlpha = 0.92 * gacc
            ctx.font = FONT_WIDGET_COUNT
            ctx.fillText(nd.countStr, gx0 + 16, gy0 + nd.ghh - 28)
            ctx.font = FONT_LABEL
          }
          ctx.fillStyle = WHITE
        }
      }

      raf = requestAnimationFrame(framePlay)
    }

    /* ---- prefers-reduced-motion: gentle fade of the settled constellation ---- */

    const frameCalm = (nowMs: number) => {
      if (!running) return
      if (t0 < 0) t0 = nowMs
      const t = (nowMs - t0) / 1000
      lastT = t
      if (applyFade(t, T.calmFade + T.calmHold)) return

      const a = easeInOutCubic(clamp01(t / T.calmFade))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = "source-over"
      ctx.globalAlpha = 1
      ctx.textBaseline = "middle"
      ctx.textAlign = "left"
      if (vignette) ctx.drawImage(vignette, 0, 0, w, h)
      if (gridLayer) {
        ctx.globalAlpha = A.grid * a
        ctx.drawImage(gridLayer, 0, 0, w, h)
      }
      ctx.globalCompositeOperation = "lighter"
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.globalAlpha = A.edge * a
      for (const e of edges) {
        ctx.beginPath()
        ctx.moveTo(e.source.x, e.source.y)
        ctx.lineTo(e.target.x, e.target.y)
        ctx.stroke()
        ctx.globalAlpha = A.edge * a
      }
      for (const nd of nodes) {
        drawGlow(
          glow,
          nd.x,
          nd.y,
          nd.r * L.haloScale * 2,
          (A.halo + nd.sizeNorm * A.haloBySize) * a,
        )
        ctx.globalAlpha = 0.95 * a
        ctx.fillStyle = CORE
        ctx.beginPath()
        ctx.arc(nd.x, nd.y, nd.r, 0, TAU)
        ctx.fill()
      }
      ctx.globalCompositeOperation = "source-over"
      ctx.fillStyle = WHITE
      ctx.font = FONT_LABEL
      ctx.globalAlpha = A.label * a
      for (const nd of nodes) {
        ctx.fillText(nd.name, nd.x + nd.r + L.labelGap, nd.y + 0.5)
        ctx.globalAlpha = A.label * a
      }
      raf = requestAnimationFrame(frameCalm)
    }

    /* ---- wire up & roll ---- */

    const onPointerDown = () => skip()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip()
    }
    const onResize = () => layout()
    container.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKey)
    window.addEventListener("resize", onResize)

    layout()
    raf = requestAnimationFrame(reduced ? frameCalm : framePlay)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      sim.stop()
      container.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onResize)
    }
  }, [])

  return (
    <div ref={containerRef} aria-hidden="true" className="fixed inset-0 z-[100] bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div
        ref={hintRef}
        className="pointer-events-none absolute inset-x-0 bottom-6 text-center text-xs text-white/40"
        style={{ opacity: 0 }}
      >
        Click or press Esc to skip
      </div>
    </div>
  )
}
