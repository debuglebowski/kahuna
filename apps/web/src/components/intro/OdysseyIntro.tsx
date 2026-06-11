import { useEffect, useRef } from "react"
import type { IntroProps } from "./types"

/**
 * ODYSSEY — space → Earth → a lone glowing computer screen.
 *
 * A ~4.6s Canvas-2D opening sting in five acts:
 *
 *   1. DRIFT      (0–1.1s)  three-layer parallax starfield, nebulae, slow lateral drift
 *   2. LIGHTSPEED (1.1–1.9s) stars stretch into additive warp streaks, chromatic split,
 *                            hard easeOutExpo brake
 *   3. EARTHRISE  (1.9–3.0s) the night side of a stylized Earth grows from a dot to 75%
 *                            of the viewport — terminator limb, atmosphere rim, city lights
 *   4. DESCENT    (3.0–3.8s) the limb flattens into a horizon, a flash, then a perspective
 *                            grid of warm city lights rushing beneath the camera
 *   5. TERMINAL   (3.8–4.6s) one desk in the dark; the camera dives into the glowing
 *                            screen and the frame dims to black
 *
 * Vector / silhouette-and-glow art direction (not photoreal). One rAF clock drives all
 * choreography; every pool is pre-allocated; the final frame is black so a chained intro
 * can cut in seamlessly.
 */

/* ════════════════════════════ FILM TIMELINE (ms) ════════════════════════════ */

const FILM = {
  end: 4620,
  fadeIn: 380, // open from black
  skipFade: 200, // click / Esc fade-out
  hintIn: 1200,
  hintInEnd: 1700,
  hintOut: 4120,
  hintOutEnd: 4420,
  /* act 2 — lightspeed */
  warpStart: 1100,
  warpRampEnd: 1320, // full streak strength here — the plateau holds through the peak
  warpPeak: 1660,
  warpEnd: 1900, // hard brake lands here
  warpSettle: 2350, // residual motion + nebulae fully gone
  /* act 3 — earthrise */
  earthDotAt: 1900, // a pale dot, dead ahead
  earthGrowStart: 2020, // …holds for a beat, then grows
  earthEnd: 3000,
  /* act 4 — descent */
  diveStart: 3000,
  diveMorphEnd: 3330, // sphere limb flattens into the horizon
  flashRise: 3070,
  flashPeak: 3185,
  flashEnd: 3320, // quartic decay — frame is night-dark again well before the ground reads
  sphereFadeStart: 3240,
  sphereFadeEnd: 3390,
  cityOffStart: 3080, // sphere city lights hand over to the ground grid
  cityOffEnd: 3220,
  shimmerIn: 3030,
  shimmerInEnd: 3140,
  shimmerOut: 3320,
  shimmerOutEnd: 3470,
  groundIn: 3170,
  groundDecel: 3430, // hold full speed long enough for two waves of rows to rip past
  groundOut: 3660,
  groundOutEnd: 3860, // dip to dark — "landing on one block"
  /* act 5 — terminal */
  deskIn: 3800,
  deskInEnd: 4080,
  glowRise: 3950,
  glowFull: 4330,
  zoomStart: 4080,
  zoomEnd: 4520,
  dimStart: 4330,
  dimEnd: 4590, // fully black before the cut
  /* reduced-motion variant */
  rmFadeIn: 600,
  rmHoldEnd: 1300,
  rmFadeOutEnd: 1900,
  rmEnd: 1950,
} as const

/* ════════════════════════════════ PALETTE ═══════════════════════════════════ */

const PAL = {
  space: "#030509",
  black: "#020203",
  chromaCyan: "#5fe8ff",
  chromaRed: "#ff5f6e",
  atmo: "#7fb8ff",
  termHot: "#ffeccd",
  termMid: "#cfe2ff",
  termSoft: "#9fc8ff",
  cloud: "#bcd0f2",
  flash: "#b7d4ff",
  groundBase: "#020306",
  groundWarm: "#ffb35c",
  groundCool: "#d9e8ff",
  shimmer: "#ffd9b0",
  deskInk: "#0a0e16",
  deskInk2: "#0c111c",
  monitorInk: "#070b13",
  rim: "#7fb8ff",
  screenFill: "#e8f0ff",
} as const

/* ═══════════════════════════════ WORLD TUNING ═══════════════════════════════ */

interface StarLayerSpec {
  count: number
  par: number // parallax factor (drift speed)
  warpK: number // warp velocity / streak multiplier
  streakW: number // streak line width
  chroma: boolean // included in the chromatic-split pass
  color: string
  size: readonly [number, number]
  alpha: readonly [number, number]
}

const STAR_LAYERS: readonly StarLayerSpec[] = [
  {
    count: 130,
    par: 0.35,
    warpK: 0.55,
    streakW: 0.7,
    chroma: false,
    color: "#a7b8d8",
    size: [0.5, 1.1],
    alpha: [0.16, 0.45],
  },
  {
    count: 90,
    par: 0.7,
    warpK: 1,
    streakW: 1.1,
    chroma: true,
    color: "#dbe7fa",
    size: [0.9, 1.6],
    alpha: [0.3, 0.7],
  },
  {
    count: 48,
    par: 1.15,
    warpK: 1.7,
    streakW: 1.6,
    chroma: true,
    color: "#ffffff",
    size: [1.3, 2.4],
    alpha: [0.55, 1],
  },
]

interface NebulaSpec {
  x: number
  y: number
  r: number // fraction of max(w, h)
  a: number // peak alpha (≤ 0.08 — barely-there color)
  rgb: string
}

const NEBULAE: readonly NebulaSpec[] = [
  { x: 0.26, y: 0.3, r: 0.62, a: 0.075, rgb: "99,102,241" }, // indigo
  { x: 0.72, y: 0.62, r: 0.78, a: 0.05, rgb: "45,212,191" }, // teal
  { x: 0.52, y: 0.86, r: 0.66, a: 0.045, rgb: "139,92,246" }, // violet
]

const SPACE = {
  vpX: 0.5, // warp vanishing point
  vpY: 0.46,
  driftX: -0.005, // act-1 lateral camera drift (normalized/s)
  warpVel: 3.2, // radial exponential velocity at full warp (1/s)
  streakK: 1.6, // streak length as a fraction of radial distance (≥1 → full convergence)
  maxStreak: 0.62, // streak cap (fraction of viewport height)
  chromaShift: 2.5, // ±px for the cyan/red split
} as const

const EARTH = {
  startX: 0.585, // appears slightly off-center…
  startY: 0.435,
  ctrlX: 0.545, // …and drifts to center along a gentle bezier
  ctrlY: 0.47,
  dotRadius: 0.006, // first-sighting radius (fraction of h)
  endRadius: 0.375, // act-3 final radius → 75% of viewport height
  diveRadius: 3, // act-4 blow-past radius
  limbAngle: Math.PI * 1.08, // lit limb: left, slightly up
  termFrom: 0.1, // terminator half-extent (rad), sweeps in…
  termTo: 0.62, // …to here
  clusterCount: 16, // city-light clusters on the night side
} as const

const GROUND = {
  horizonY: 0.42, // shared with the act-4 limb morph
  cols: 12,
  rows: 26,
  halfSpan: 5.5, // world half-width of the light field
  zNear: 0.8,
  depth: 26,
  drop: 0.44, // ground projection scale (fraction of h)
  spread: 0.5, // x projection scale (fraction of w)
  vMax: 26, // entry speed (world units/s)
  vMin: 1, // crawl after deceleration
  stretch: 0.05, // motion-blur trail ≈ this many seconds of travel
  glowPx: 34,
  darkChance: 0.2, // unlit blocks keep the grid organic
  coolChance: 0.12,
  shimmerCount: 22,
} as const

const DESK = {
  centerY: 0.52,
  screenH: 0.165, // screen height (fraction of h)
  aspect: 1.62,
  zoomMax: 9.4, // added to 1 → covers ultrawide before the dim completes
} as const

/* ═══════════════════════════════ MATH / EASING ══════════════════════════════ */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Normalized progress of `v` through [a, b], clamped. */
function ramp(v: number, a: number, b: number): number {
  return clamp01((v - a) / (b - a))
}

function easeInCubic(x: number): number {
  return x * x * x
}

function easeOutCubic(x: number): number {
  const i = 1 - x
  return 1 - i * i * i
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}

function easeInQuart(x: number): number {
  return x * x * x * x
}

function easeOutExpo(x: number): number {
  return x >= 1 ? 1 : 1 - 2 ** (-10 * x)
}

/* ════════════════════════════════ SPRITES ═══════════════════════════════════ */

function makeSprite(
  width: number,
  height: number,
  paint: (g: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  const c = document.createElement("canvas")
  c.width = width
  c.height = height
  const g = c.getContext("2d")
  if (g) paint(g)
  return c
}

function radialSprite(size: number, stops: ReadonlyArray<readonly [number, string]>) {
  return makeSprite(size, size, (g) => {
    const half = size / 2
    const grad = g.createRadialGradient(half, half, 0, half, half, half)
    for (const [offset, color] of stops) grad.addColorStop(offset, color)
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  })
}

/** Deep blue-black night-side sphere, faintly lit toward the terminator. */
function makeEarthSprite() {
  return makeSprite(1024, 1024, (g) => {
    g.beginPath()
    g.arc(512, 512, 510, 0, Math.PI * 2)
    g.clip()
    const grad = g.createRadialGradient(348, 450, 50, 512, 512, 636)
    grad.addColorStop(0, "#16284a")
    grad.addColorStop(0.42, "#0b1730")
    grad.addColorStop(0.78, "#050b1a")
    grad.addColorStop(1, "#02060f")
    g.fillStyle = grad
    g.fillRect(0, 0, 1024, 1024)
  })
}

/** Soft atmosphere halo ring; the sphere edge sits at 0.74 of the half-size. */
function makeAtmoRing() {
  return makeSprite(1024, 1024, (g) => {
    const grad = g.createRadialGradient(512, 512, 338, 512, 512, 512)
    grad.addColorStop(0, "rgba(127,184,255,0)")
    grad.addColorStop(0.22, "rgba(127,184,255,0.5)")
    grad.addColorStop(0.5, "rgba(150,200,255,0.16)")
    grad.addColorStop(1, "rgba(127,184,255,0)")
    g.fillStyle = grad
    g.fillRect(0, 0, 1024, 1024)
  })
}

function makeSkyStrip() {
  return makeSprite(4, 256, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, "#020409")
    grad.addColorStop(0.7, "#060c1a")
    grad.addColorStop(1, "#0e1730")
    g.fillStyle = grad
    g.fillRect(0, 0, 4, 256)
  })
}

/* ═════════════════════════════════ POOLS ════════════════════════════════════ */

interface Star {
  x: number
  y: number
  ix: number // initial position — reused for the act-4 sky
  iy: number
  size: number
  a: number
  tw: number
  twSpeed: number
}

interface StarLayer {
  par: number
  warpK: number
  streakW: number
  chroma: boolean
  color: string
  stars: Star[]
}

function makeStarLayers(): StarLayer[] {
  return STAR_LAYERS.map((spec) => ({
    par: spec.par,
    warpK: spec.warpK,
    streakW: spec.streakW,
    chroma: spec.chroma,
    color: spec.color,
    stars: Array.from({ length: spec.count }, (): Star => {
      const x = Math.random()
      const y = Math.random()
      return {
        x,
        y,
        ix: x,
        iy: y,
        size: lerp(spec.size[0], spec.size[1], Math.random()),
        a: lerp(spec.alpha[0], spec.alpha[1], Math.random()),
        tw: Math.random() * Math.PI * 2,
        twSpeed: 0.0012 + Math.random() * 0.0024,
      }
    }),
  }))
}

interface Nebula {
  x: number
  y: number
  r: number
  a: number
  dx: number
  dy: number
  sprite: HTMLCanvasElement
}

function makeNebulae(): Nebula[] {
  return NEBULAE.map((spec) => ({
    x: spec.x,
    y: spec.y,
    r: spec.r,
    a: spec.a,
    dx: (Math.random() - 0.5) * 0.0024, // clearly slower than even the far star layer
    dy: (Math.random() - 0.5) * 0.0014,
    sprite: radialSprite(384, [
      [0, `rgba(${spec.rgb},0.85)`],
      [0.5, `rgba(${spec.rgb},0.3)`],
      [1, `rgba(${spec.rgb},0)`],
    ]),
  }))
}

interface CityDot {
  ux: number // unit-disc coords relative to the sphere radius
  uy: number
  s: number
  a: number
  tw: number
}

/** Cluster-and-scatter city lights so the night side reads organic, not uniform. */
function makeCityDots(): CityDot[] {
  const dots: CityDot[] = []
  const lx = Math.cos(EARTH.limbAngle)
  const ly = Math.sin(EARTH.limbAngle)
  for (let c = 0; c < EARTH.clusterCount; c++) {
    const ca = Math.random() * Math.PI * 2
    const cd = Math.sqrt(Math.random()) * 0.8
    const cuX = Math.cos(ca) * cd
    const cuY = Math.sin(ca) * cd
    const n = 6 + Math.floor(Math.random() * 15)
    for (let i = 0; i < n; i++) {
      const ux = cuX + (Math.random() + Math.random() - 1) * 0.09
      const uy = cuY + (Math.random() + Math.random() - 1) * 0.09
      const rr = Math.hypot(ux, uy)
      if (rr > 0.93) continue
      const z = Math.sqrt(1 - rr * rr) // foreshortening toward the limb
      const lit = ux * lx + uy * ly // 1 → at the lit limb
      const fade = (0.25 + 0.75 * z) * (1 - ramp(lit, 0.05, 0.6))
      const a = (0.45 + 0.55 * Math.random()) * fade
      if (a < 0.05) continue
      dots.push({ ux, uy, s: 0.005 + Math.random() * 0.011, a, tw: Math.random() * Math.PI * 2 })
    }
  }
  return dots
}

interface GroundLight {
  wx: number
  z: number
  i: number // 0 → unlit block, skipped at draw
  cool: boolean
}

function makeGroundLights(): GroundLight[] {
  const lights: GroundLight[] = []
  const colSpan = (GROUND.halfSpan * 2) / GROUND.cols
  const rowSpan = GROUND.depth / GROUND.rows
  for (let row = 0; row < GROUND.rows; row++) {
    for (let col = 0; col < GROUND.cols; col++) {
      lights.push({
        wx: -GROUND.halfSpan + (col + 0.5) * colSpan + (Math.random() - 0.5) * 0.8,
        z: GROUND.zNear + (row + Math.random()) * rowSpan,
        i: Math.random() < GROUND.darkChance ? 0 : 0.35 + Math.random() * 0.65,
        cool: Math.random() < GROUND.coolChance,
      })
    }
  }
  return lights
}

interface Shimmer {
  x: number
  y: number
  v: number // normalized viewport-heights per second, upward
  len: number
  a: number
}

function makeShimmers(): Shimmer[] {
  return Array.from({ length: GROUND.shimmerCount }, (): Shimmer => {
    return {
      x: Math.random(),
      y: Math.random() * 1.3,
      v: 2.2 + Math.random() * 1.4,
      len: 0.07 + Math.random() * 0.09,
      a: 0.05 + Math.random() * 0.09,
    }
  })
}

/* ═══════════════════════════════ THE SHOW ═══════════════════════════════════ */

function createShow(
  canvas: HTMLCanvasElement,
  hint: HTMLElement,
  reducedMotion: boolean,
  finish: () => void,
): () => void {
  const ctx = canvas.getContext("2d", { alpha: false })
  if (!ctx) {
    finish()
    return () => {}
  }

  /* viewport */
  let w = 0
  let h = 0
  const fitViewport = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineCap = "round"
  }
  fitViewport()

  /* run state — everything lives in this closure so a StrictMode remount is clean */
  let raf = 0
  let stopped = false
  let t0 = -1
  let last = 0
  let clock = 0
  let skipAt = -1
  let lastHint = -1

  /* pools + sprites (pre-allocated; the rAF loop never allocates) */
  const layers = makeStarLayers()
  const nebulae = makeNebulae()
  const cityDots = makeCityDots()
  const lights = makeGroundLights()
  const shimmers = makeShimmers()
  const sprEarth = makeEarthSprite()
  const sprRing = makeAtmoRing()
  const sprSky = makeSkyStrip()
  const sprGlowWarm = radialSprite(96, [
    [0, "rgba(255,240,214,0.9)"],
    [0.25, "rgba(255,193,120,0.55)"],
    [0.6, "rgba(255,150,70,0.16)"],
    [1, "rgba(255,150,70,0)"],
  ])
  const sprGlowCool = radialSprite(160, [
    [0, "rgba(244,249,255,0.95)"],
    [0.3, "rgba(170,206,255,0.5)"],
    [0.65, "rgba(120,170,255,0.14)"],
    [1, "rgba(120,170,255,0)"],
  ])
  /* zero-slope shoulders at both ends — no Mach-band ring when stretched to the viewport */
  const sprVignette = radialSprite(
    512,
    Array.from({ length: 15 }, (_, i) => {
      const o = i / 14
      const a = 0.8 * easeInOutCubic(ramp(o, 0.42, 1))
      return [o, `rgba(0,0,0,${a.toFixed(3)})`] as const
    }),
  )

  /* shared scratch for streak endpoints (main + chromatic passes) */
  const scratch = { hx: 0, hy: 0, tx: 0, ty: 0, ok: false }

  const skipProgress = (t: number) => (skipAt < 0 ? 0 : ramp(t, skipAt, skipAt + FILM.skipFade))

  /* ── act 1+2: starfield, nebulae, warp ──────────────────────────────────── */

  const warpEnvelope = (t: number) => {
    if (t <= FILM.warpStart) return 0
    if (t <= FILM.warpRampEnd) return easeOutCubic(ramp(t, FILM.warpStart, FILM.warpRampEnd))
    if (t <= FILM.warpPeak) return 1 // full burn — hold the plateau through the peak
    const brake = lerp(1, 0.05, easeOutExpo(ramp(t, FILM.warpPeak, FILM.warpEnd)))
    return brake * (1 - easeOutCubic(ramp(t, FILM.warpEnd, FILM.warpSettle)))
  }

  const respawnStar = (s: Star) => {
    const ang = Math.random() * Math.PI * 2
    const d = 0.02 + Math.random() * 0.16
    s.x = SPACE.vpX + Math.cos(ang) * d
    s.y = SPACE.vpY + Math.sin(ang) * d
  }

  const computeStreak = (s: Star, layer: StarLayer, warpE: number) => {
    const ddx = (s.x - SPACE.vpX) * w
    const ddy = (s.y - SPACE.vpY) * h
    const distPx = Math.hypot(ddx, ddy)
    if (distPx < 0.6) {
      scratch.ok = false
      return
    }
    let k = warpE * SPACE.streakK * layer.warpK
    if (k > 0.92) k = 0.92 // tails converge toward — never through — the vanishing point
    const maxLen = h * SPACE.maxStreak
    if (distPx * k > maxLen) k = maxLen / distPx
    scratch.hx = s.x * w
    scratch.hy = s.y * h
    scratch.tx = scratch.hx - ddx * k
    scratch.ty = scratch.hy - ddy * k
    scratch.ok = true
  }

  const drawSpace = (t: number, dt: number, warpE: number) => {
    const starDim =
      (1 - 0.45 * ramp(t, FILM.earthGrowStart, FILM.earthEnd)) *
      (1 - ramp(t, FILM.flashRise, FILM.flashPeak))
    const nebA = (1 - 0.72 * warpE) * (1 - easeOutCubic(ramp(t, FILM.warpEnd, FILM.warpSettle)))
    ctx.globalCompositeOperation = "lighter"

    /* nebulae first — stars render on top */
    for (const n of nebulae) {
      const a = n.a * nebA * starDim
      if (a <= 0.002) continue
      n.x += n.dx * dt
      n.y += n.dy * dt
      const px = n.x * w
      const py = n.y * h
      const size = n.r * Math.max(w, h)
      ctx.save()
      ctx.translate(px, py)
      if (warpE > 0.01) {
        /* smear along the radial axis while at speed */
        ctx.rotate(Math.atan2(py - SPACE.vpY * h, px - SPACE.vpX * w))
        ctx.scale(1 + 3.5 * warpE, Math.max(0.4, 1 - 0.45 * warpE))
      }
      ctx.globalAlpha = a
      ctx.drawImage(n.sprite, -size / 2, -size / 2, size, size)
      ctx.restore()
      ctx.globalCompositeOperation = "lighter"
    }

    /* stars: drift → streaks */
    for (const layer of layers) {
      ctx.fillStyle = layer.color
      ctx.strokeStyle = layer.color
      ctx.lineWidth = layer.streakW * (0.7 + 1.1 * warpE)
      for (const s of layer.stars) {
        if (warpE > 0.002) {
          const m = 1 + warpE * SPACE.warpVel * layer.warpK * dt
          s.x = SPACE.vpX + (s.x - SPACE.vpX) * m
          s.y = SPACE.vpY + (s.y - SPACE.vpY) * m
          if (Math.abs(s.x - SPACE.vpX) > 0.62 || Math.abs(s.y - SPACE.vpY) > 0.62) {
            respawnStar(s)
          }
        } else {
          s.x += SPACE.driftX * layer.par * dt
          if (s.x < -0.04) s.x += 1.08
          else if (s.x > 1.04) s.x -= 1.08
        }
        const twinkle = 0.74 + 0.26 * Math.sin(s.tw + t * s.twSpeed)
        if (warpE > 0.02) {
          computeStreak(s, layer, warpE)
          if (!scratch.ok) continue
          ctx.globalAlpha = Math.min(1, s.a * (0.8 + 0.4 * warpE) * twinkle + 0.3 * warpE)
          ctx.beginPath()
          ctx.moveTo(scratch.hx, scratch.hy)
          ctx.lineTo(scratch.tx, scratch.ty)
          ctx.stroke()
        } else {
          ctx.globalAlpha = s.a * twinkle * starDim
          ctx.fillRect(s.x * w - s.size / 2, s.y * h - s.size / 2, s.size, s.size)
        }
      }
    }

    /* chromatic split at peak rush — same streaks at ±1px in cyan / red */
    if (warpE > 0.45) {
      const ca = 0.12 + 0.26 * ramp(warpE, 0.45, 1)
      ctx.lineWidth = 1.3
      ctx.strokeStyle = PAL.chromaCyan
      ctx.globalAlpha = ca
      ctx.beginPath()
      for (const layer of layers) {
        if (!layer.chroma) continue
        for (const s of layer.stars) {
          computeStreak(s, layer, warpE)
          if (!scratch.ok) continue
          ctx.moveTo(scratch.hx - SPACE.chromaShift, scratch.hy)
          ctx.lineTo(scratch.tx - SPACE.chromaShift, scratch.ty)
        }
      }
      ctx.stroke()
      ctx.strokeStyle = PAL.chromaRed
      ctx.beginPath()
      for (const layer of layers) {
        if (!layer.chroma) continue
        for (const s of layer.stars) {
          computeStreak(s, layer, warpE)
          if (!scratch.ok) continue
          ctx.moveTo(scratch.hx + SPACE.chromaShift, scratch.hy)
          ctx.lineTo(scratch.tx + SPACE.chromaShift, scratch.ty)
        }
      }
      ctx.stroke()

      /* tunnel glow at the vanishing point — the mouth of the warp */
      const gw = ramp(warpE, 0.45, 1)
      const gs = h * (0.3 + 0.55 * warpE)
      ctx.globalAlpha = 0.45 * gw
      ctx.drawImage(sprGlowCool, SPACE.vpX * w - gs, SPACE.vpY * h - gs, gs * 2, gs * 2)
      const core = h * 0.18 * (0.4 + 0.6 * warpE)
      ctx.globalAlpha = 0.7 * gw
      ctx.drawImage(sprGlowCool, SPACE.vpX * w - core, SPACE.vpY * h - core, core * 2, core * 2)
    }

    ctx.globalCompositeOperation = "source-over"
    ctx.globalAlpha = 1
  }

  /* ── act 3+4a: Earth ────────────────────────────────────────────────────── */

  const limbArc = (
    ex: number,
    ey: number,
    radius: number,
    extent: number,
    width: number,
    color: string,
    alpha: number,
  ) => {
    if (alpha <= 0.004 || radius <= 0) return
    ctx.strokeStyle = color
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.arc(ex, ey, radius, EARTH.limbAngle - extent, EARTH.limbAngle + extent)
    ctx.stroke()
  }

  const drawEarth = (t: number) => {
    const sphereA = 1 - ramp(t, FILM.sphereFadeStart, FILM.sphereFadeEnd)
    if (sphereA <= 0.002) return
    const appear = ramp(t, FILM.earthDotAt, FILM.earthDotAt + 180)
    const grow = ramp(t, FILM.earthGrowStart, FILM.earthEnd)
    let r: number
    let ex: number
    let ey: number
    let rimBoost = 1
    let diveP = 0
    if (t < FILM.diveStart) {
      const p = easeInOutCubic(grow)
      r = lerp(Math.max(4, h * EARTH.dotRadius), h * EARTH.endRadius, p)
      /* gentle quadratic bezier from off-center to center */
      const m1x = lerp(EARTH.startX, EARTH.ctrlX, p)
      const m1y = lerp(EARTH.startY, EARTH.ctrlY, p)
      const m2x = lerp(EARTH.ctrlX, 0.5, p)
      const m2y = lerp(EARTH.ctrlY, 0.5, p)
      ex = lerp(m1x, m2x, p) * w
      ey = lerp(m1y, m2y, p) * h
    } else {
      /* the dive: the sphere blows past the frame and its limb becomes the horizon */
      const p = ramp(t, FILM.diveStart, FILM.diveMorphEnd)
      diveP = p
      r = lerp(h * EARTH.endRadius, h * EARTH.diveRadius, easeInCubic(p))
      const limbTop = lerp(h * (0.5 - EARTH.endRadius), h * GROUND.horizonY, easeInOutCubic(p))
      ex = w * 0.5
      ey = limbTop + r
      rimBoost = 1 + 2.4 * p
    }
    const bodyA = sphereA * appear

    /* night-side body — occludes the starfield */
    ctx.globalAlpha = bodyA
    ctx.drawImage(sprEarth, ex - r, ey - r, r * 2, r * 2)

    ctx.globalCompositeOperation = "lighter"

    /* warm city-light clusters */
    const cityA =
      ramp(r, h * 0.06, h * 0.17) * (1 - ramp(t, FILM.cityOffStart, FILM.cityOffEnd)) * sphereA
    if (cityA > 0.01) {
      for (const d of cityDots) {
        const px = ex + d.ux * r
        const py = ey + d.uy * r
        const sz = d.s * r + 1
        ctx.globalAlpha = Math.min(1, d.a * cityA * (0.8 + 0.2 * Math.sin(t * 0.004 + d.tw)))
        ctx.drawImage(sprGlowWarm, px - sz, py - sz, sz * 2, sz * 2)
      }
    }

    /* one thin cloud arc, drifting slowly */
    if (grow > 0.25 && t < FILM.diveStart) {
      ctx.strokeStyle = PAL.cloud
      ctx.globalAlpha = 0.1 * grow * sphereA
      ctx.lineWidth = Math.max(1, r * 0.045)
      ctx.beginPath()
      ctx.arc(ex, ey, r * 0.86, 0.5 + t * 0.00002, 1.18 + t * 0.00002)
      ctx.stroke()
    }

    /* day/night terminator limb sweeping in — layered arcs fake the taper */
    const ext = lerp(EARTH.termFrom, EARTH.termTo, easeOutCubic(grow))
    const rimA = (0.3 + 0.7 * grow) * sphereA
    const softBoost = Math.min(rimBoost, 1.8)
    limbArc(ex, ey, r * 0.995, ext, Math.max(2, r * 0.1), PAL.termSoft, 0.1 * rimA * softBoost)
    limbArc(ex, ey, r * 0.99, ext * 0.8, Math.max(1.2, r * 0.04), PAL.termMid, 0.3 * rimA)
    limbArc(ex, ey, r * 0.985, ext * 0.6, Math.max(0.8, r * 0.012), PAL.termHot, 0.85 * rimA)

    /* atmosphere: crisp inner line + soft outer halo (halo yields to the night dive) */
    ctx.strokeStyle = PAL.atmo
    ctx.globalAlpha = Math.min(1, 0.55 * rimA * Math.min(rimBoost, 1.7))
    ctx.lineWidth = Math.max(0.8, r * 0.0035)
    ctx.beginPath()
    ctx.arc(ex, ey, r * 1.004, 0, Math.PI * 2)
    ctx.stroke()
    const halo = r * 1.35
    ctx.globalAlpha = Math.min(1, 0.45 * rimA) * (1 - 0.85 * diveP)
    ctx.drawImage(sprRing, ex - halo, ey - halo, halo * 2, halo * 2)

    ctx.globalCompositeOperation = "source-over"
    ctx.globalAlpha = 1
  }

  /* ── act 4b: the ground rush ────────────────────────────────────────────── */

  const drawGround = (t: number, dt: number) => {
    /* keep the world moving even while fading, so motion never stutters */
    const v = lerp(
      GROUND.vMax,
      GROUND.vMin,
      easeOutCubic(ramp(t, FILM.groundDecel, FILM.groundOutEnd)),
    )
    for (const l of lights) {
      l.z -= v * dt
      if (l.z < GROUND.zNear) l.z += GROUND.depth
    }
    const gA =
      ramp(t, FILM.groundIn, FILM.groundIn + 170) * (1 - ramp(t, FILM.groundOut, FILM.groundOutEnd))
    if (gA <= 0.002) return

    const horizonY = h * GROUND.horizonY
    const cx = w * 0.5
    /* entry shake — two incommensurate sines read as turbulence */
    const shakeE = gA * (1 - ramp(t, FILM.groundDecel, FILM.groundOut))
    ctx.save()
    ctx.translate(
      Math.sin(t * 0.131) * Math.sin(t * 0.071 + 1.7) * 5 * shakeE,
      Math.sin(t * 0.097 + 0.6) * Math.sin(t * 0.053) * 4 * shakeE,
    )

    ctx.globalAlpha = gA
    ctx.drawImage(sprSky, 0, 0, w, horizonY)
    ctx.fillStyle = PAL.groundBase
    ctx.fillRect(0, horizonY, w, h - horizonY + 4)

    /* a few quiet stars above the new horizon */
    for (const layer of layers) {
      if (layer.par > 0.5) continue
      ctx.fillStyle = layer.color
      for (const s of layer.stars) {
        const py = s.iy * h
        if (py > horizonY - 10) continue
        ctx.globalAlpha = s.a * 0.35 * gA * (0.74 + 0.26 * Math.sin(s.tw + t * s.twSpeed))
        ctx.fillRect(s.ix * w, py, s.size, s.size)
      }
    }

    ctx.globalCompositeOperation = "lighter"

    /* faintly lit horizon — distant city glow */
    ctx.globalAlpha = 0.15 * gA
    ctx.drawImage(sprGlowWarm, cx - w * 0.75, horizonY - h * 0.075, w * 1.5, h * 0.15)
    ctx.globalAlpha = 0.22 * gA
    ctx.drawImage(sprGlowWarm, cx - w * 0.33, horizonY - h * 0.034, w * 0.66, h * 0.068)

    /* the light grid — speed reads through streak length */
    const hk = h / 900
    for (const l of lights) {
      if (l.i <= 0) continue
      const z = l.z
      const py = horizonY + (GROUND.drop * h) / z
      if (py > h + 60) continue
      const px = cx + (l.wx * GROUND.spread * w) / z
      if (px < -90 || px > w + 90) continue
      const fog = (1 - (z - GROUND.zNear) / GROUND.depth) ** 1.7
      const a = l.i * fog * gA
      if (a < 0.012) continue
      const sz = Math.min(46, GROUND.glowPx / z) * hk + 1.5
      const len = Math.min(h * 0.3, ((v * GROUND.drop * h) / (z * z)) * GROUND.stretch)
      ctx.strokeStyle = l.cool ? PAL.groundCool : PAL.groundWarm
      ctx.globalAlpha = Math.min(1, a * 0.8)
      ctx.lineWidth = Math.min(5, 10 / z + 0.6)
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px, py - len)
      ctx.stroke()
      ctx.globalAlpha = Math.min(1, a)
      ctx.drawImage(sprGlowWarm, px - sz, py - sz, sz * 2, sz * 2)
    }

    ctx.restore()
  }

  /* atmosphere-entry shimmer streaks rushing past */
  const drawShimmers = (t: number, dt: number) => {
    const env =
      ramp(t, FILM.shimmerIn, FILM.shimmerInEnd) *
      (1 - ramp(t, FILM.shimmerOut, FILM.shimmerOutEnd))
    if (env <= 0.002) return
    const cx = w * 0.5
    ctx.globalCompositeOperation = "lighter"
    ctx.strokeStyle = PAL.shimmer
    ctx.lineWidth = 1.4
    for (const sh of shimmers) {
      sh.y -= sh.v * dt
      if (sh.y < -0.25) {
        sh.y += 1.5
        sh.x = Math.random()
      }
      const px = sh.x * w
      const py = sh.y * h
      const ln = sh.len * h
      const lean = ((px - cx) / cx) * ln * 0.22
      ctx.globalAlpha = sh.a * env
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px + lean, py + ln)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = "source-over"
    ctx.globalAlpha = 1
  }

  const drawFlash = (t: number) => {
    if (t <= FILM.flashRise || t >= FILM.flashEnd) return
    const a =
      easeInCubic(ramp(t, FILM.flashRise, FILM.flashPeak)) *
      easeInQuart(1 - ramp(t, FILM.flashPeak, FILM.flashEnd))
    if (a <= 0.004) return
    ctx.fillStyle = PAL.flash
    ctx.globalAlpha = Math.min(1, a * 0.85)
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = "lighter"
    const sz = Math.max(w, h) * 0.85
    ctx.globalAlpha = a * 0.35
    ctx.drawImage(sprGlowCool, w * 0.5 - sz, h * 0.46 - sz, sz * 2, sz * 2)
    ctx.globalCompositeOperation = "source-over"
    ctx.globalAlpha = 1
  }

  /* ── act 5: the desk ────────────────────────────────────────────────────── */

  const drawDesk = (a: number, glow: number, zoom: number) => {
    if (a <= 0.002) return
    const cx = w * 0.5
    const my = h * DESK.centerY // screen center — also the zoom anchor
    const sh = h * DESK.screenH
    const sw = sh * DESK.aspect
    const bez = sh * 0.05
    const neck = sh * 0.16
    const deskY = my + sh / 2 + bez + neck

    ctx.save()
    ctx.translate(cx, my)
    ctx.scale(zoom, zoom)
    ctx.translate(-cx, -my)

    /* the screen is the room's only light source */
    ctx.globalCompositeOperation = "lighter"
    ctx.globalAlpha = 0.18 * glow * a
    ctx.drawImage(sprGlowCool, cx - sw * 1.7, my - sw * 1.7, sw * 3.4, sw * 3.4)
    ctx.globalAlpha = 0.1 * glow * a
    ctx.drawImage(sprGlowCool, cx - sw * 0.95, deskY - sw * 0.16, sw * 1.9, sw * 0.46)
    ctx.globalCompositeOperation = "source-over"

    /* desk line */
    ctx.globalAlpha = a
    ctx.fillStyle = PAL.deskInk
    ctx.fillRect(cx - sw * 1.7, deskY, sw * 3.4, Math.max(2, sh * 0.05))
    ctx.globalCompositeOperation = "lighter"
    ctx.globalAlpha = 0.13 * glow * a
    ctx.drawImage(sprGlowCool, cx - sw * 1.15, deskY - 3, sw * 2.3, 6)
    ctx.globalCompositeOperation = "source-over"

    /* stand + base */
    ctx.globalAlpha = a
    ctx.fillStyle = PAL.deskInk2
    ctx.fillRect(cx - sw * 0.045, my + sh / 2 + bez - 1, sw * 0.09, neck + 2)
    ctx.beginPath()
    ctx.roundRect(
      cx - sw * 0.26,
      deskY - Math.max(2, sh * 0.03),
      sw * 0.52,
      Math.max(2, sh * 0.03),
      2,
    )
    ctx.fill()

    /* monitor body with the faintest rim light */
    ctx.fillStyle = PAL.monitorInk
    ctx.beginPath()
    ctx.roundRect(cx - sw / 2 - bez, my - sh / 2 - bez, sw + bez * 2, sh + bez * 2, sh * 0.07)
    ctx.fill()
    ctx.globalCompositeOperation = "lighter"
    ctx.strokeStyle = PAL.rim
    ctx.globalAlpha = (0.1 + 0.14 * glow) * a
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.globalCompositeOperation = "source-over"

    /* the glowing screen */
    ctx.fillStyle = PAL.screenFill
    ctx.globalAlpha = Math.min(0.96, 0.26 + 0.66 * glow) * a
    ctx.beginPath()
    ctx.roundRect(cx - sw / 2, my - sh / 2, sw, sh, sh * 0.035)
    ctx.fill()
    ctx.globalCompositeOperation = "lighter"
    ctx.globalAlpha = 0.3 * glow * a
    ctx.drawImage(sprGlowCool, cx - sw * 0.62, my - sw * 0.62, sw * 1.24, sw * 1.24)
    ctx.globalAlpha = 0.15 * glow * a
    ctx.drawImage(sprGlowCool, cx - sw * 1.05, my - sw * 1.05, sw * 2.1, sw * 2.1)

    ctx.restore()
    ctx.globalAlpha = 1
  }

  const drawTerminal = (t: number) => {
    const a = easeOutCubic(ramp(t, FILM.deskIn, FILM.deskInEnd))
    if (a <= 0.002) return
    const swell = easeInOutCubic(ramp(t, FILM.glowRise, FILM.glowFull))
    const breath = 1 + 0.025 * Math.sin(t * 0.0075) // a screen, quietly alive
    const glow = Math.min(1.05, (0.42 + 0.58 * swell) * breath)
    const zoom = 1 + DESK.zoomMax * easeInQuart(ramp(t, FILM.zoomStart, FILM.zoomEnd))
    drawDesk(a, glow, zoom)
  }

  /* ── grade: vignette, open fade, final dim, skip ────────────────────────── */

  const drawGrade = (t: number) => {
    const dim = easeInOutCubic(ramp(t, FILM.dimStart, FILM.dimEnd))
    ctx.globalAlpha = 0.16 + 0.4 * dim
    ctx.drawImage(sprVignette, 0, 0, w, h)
    const open = 1 - easeOutCubic(ramp(t, 0, FILM.fadeIn))
    const black = Math.max(open, dim)
    if (black > 0.002) {
      ctx.fillStyle = "#000000"
      ctx.globalAlpha = Math.min(1, black)
      ctx.fillRect(0, 0, w, h)
    }
    ctx.globalAlpha = 1
  }

  const drawSkipOverlay = (t: number) => {
    const sp = skipProgress(t)
    if (sp <= 0) return
    ctx.fillStyle = "#000000"
    ctx.globalAlpha = easeOutCubic(sp)
    ctx.fillRect(0, 0, w, h)
    ctx.globalAlpha = 1
  }

  const updateHint = (t: number) => {
    let o: number
    if (reducedMotion) {
      o =
        easeInOutCubic(ramp(t, FILM.hintIn, FILM.hintIn + 300)) *
        (1 - ramp(t, FILM.rmHoldEnd, FILM.rmFadeOutEnd))
    } else {
      o =
        easeInOutCubic(ramp(t, FILM.hintIn, FILM.hintInEnd)) *
        (1 - ramp(t, FILM.hintOut, FILM.hintOutEnd))
    }
    o *= 1 - skipProgress(t)
    if (Math.abs(o - lastHint) > 0.01) {
      lastHint = o
      hint.style.opacity = o.toFixed(3)
    }
  }

  /* ── frame composition ──────────────────────────────────────────────────── */

  const render = (t: number, dt: number) => {
    ctx.fillStyle = t < FILM.deskIn ? PAL.space : PAL.black
    ctx.fillRect(0, 0, w, h)
    const warpE = warpEnvelope(t)
    if (t < FILM.flashEnd) drawSpace(t, dt, warpE)
    if (t >= FILM.earthDotAt && t < FILM.sphereFadeEnd) drawEarth(t)
    if (t >= FILM.groundIn - 60 && t < FILM.groundOutEnd) drawGround(t, dt)
    if (t >= FILM.diveStart && t < FILM.shimmerOutEnd) drawShimmers(t, dt)
    drawFlash(t)
    if (t >= FILM.deskIn) drawTerminal(t)
    drawGrade(t)
    drawSkipOverlay(t)
    updateHint(t)
  }

  /* reduced motion: the calm final frame — a glowing screen in the dark */
  const renderReduced = (t: number) => {
    ctx.fillStyle = "#000000"
    ctx.fillRect(0, 0, w, h)
    const a =
      easeInOutCubic(ramp(t, 0, FILM.rmFadeIn)) *
      (1 - easeInOutCubic(ramp(t, FILM.rmHoldEnd, FILM.rmFadeOutEnd)))
    drawDesk(a, 0.8, 1)
    ctx.globalAlpha = 0.25 * a
    ctx.drawImage(sprVignette, 0, 0, w, h)
    ctx.globalAlpha = 1
    drawSkipOverlay(t)
    updateHint(t)
  }

  const frame = (now: number) => {
    if (stopped) return
    if (t0 < 0) {
      t0 = now
      last = now
    }
    const t = now - t0
    clock = t
    const dt = Math.min(now - last, 50) / 1000
    last = now
    if (reducedMotion) renderReduced(t)
    else render(t, dt)
    const skipDone = skipAt >= 0 && t >= skipAt + FILM.skipFade
    if (skipDone || t >= (reducedMotion ? FILM.rmEnd : FILM.end)) {
      stopped = true
      finish()
      return
    }
    raf = requestAnimationFrame(frame)
  }

  /* ── input + lifecycle ──────────────────────────────────────────────────── */

  const skip = () => {
    if (stopped || skipAt >= 0) return
    skipAt = clock
  }
  const onPointerDown = () => skip()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") skip()
  }

  window.addEventListener("pointerdown", onPointerDown)
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("resize", fitViewport)
  raf = requestAnimationFrame(frame)

  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    window.removeEventListener("pointerdown", onPointerDown)
    window.removeEventListener("keydown", onKeyDown)
    window.removeEventListener("resize", fitViewport)
  }
}

/* ═══════════════════════════════ COMPONENT ══════════════════════════════════ */

export function OdysseyIntro({ onDone }: IntroProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hintRef = useRef<HTMLDivElement | null>(null)
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    const canvas = canvasRef.current
    const hint = hintRef.current
    if (!canvas || !hint) return
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    return createShow(canvas, hint, reducedMotion, () => {
      if (doneRef.current) return
      doneRef.current = true
      onDoneRef.current()
    })
  }, [])

  return (
    <div aria-hidden="true" className="fixed inset-0 z-[100] bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div
        ref={hintRef}
        className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-xs tracking-wide text-white/40"
        style={{ opacity: 0 }}
      >
        Click or press Esc to skip
      </div>
    </div>
  )
}
