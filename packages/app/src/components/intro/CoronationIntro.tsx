import { useEffect, useRef } from "react"
import type { IntroProps } from "./types"

/**
 * CORONATION — a gold forge sting (~3.3s). The one color moment in a colorless app.
 *
 * Act 1 EMBERS   0.00–0.80  a lone gold ember, then hundreds rise from black
 * Act 2 FORGE    0.80–1.90  a vortex drags the sparks into a wireframe crown;
 *                           three hammer beats (1.1 / 1.4 / 1.7) solidify it
 * Act 3 BLAZE    1.90–2.80  the crown flares, collapses into a flash, and the
 *                           wordmark ignites gold and cools to white
 * Act 4 CURTAIN  2.80–3.32  one breath on the brand frame, then the curtain lifts
 *
 * One rAF clock drives everything (canvas, DOM letters, hint, curtain). Particles
 * live in pre-allocated typed-array pools — zero allocation inside the hot loop.
 */

// ─────────────────────────────────────────────────────────────────────────────
// FILM TIMELINE — every cue in seconds from the first frame. Tune like a cut list.
// ─────────────────────────────────────────────────────────────────────────────
const FILM = {
  // Act 1 — EMBERS
  heroAt: 0.02, // the single first ember
  swarmFrom: 0.14, // swarm ramp begins — hundreds airborne within ~300ms of the hero
  swarmFull: 0.68, // every ember airborne
  // Act 2 — FORGE
  forgeAt: 0.8, // vortex grip switches on
  captureFrom: 0.84, // first spark begins homing onto the crown path
  captureSpread: 0.42, // capture stagger sweeps along the crown outline
  // Act 3 — BLAZE → WORDMARK
  flareAt: 1.9, // crown peak flare + shockwave
  collapseFrom: 2.02, // crown implodes toward center
  collapseDur: 0.34,
  flashFrom: 2.02, // central flash envelope
  flashPeak: 2.2,
  dieFrom: 2.5, // global ember die-out → canvas black
  dieDur: 0.24,
  wordFrom: 1.98, // letters ignite center-out
  wordStagger: 0.065, // per ring of letters (S/M first, K/R last)
  wordLetterDur: 0.36,
  coolDelay: 0.22, // gold → white begins, per letter
  coolDur: 0.34,
  // Act 4 — CURTAIN
  exitAt: 2.95, // hold 2.80–2.95, then the lift
  exitDur: 0.37,
  end: 3.32,
  // overlays
  hintAt: 1.2,
  hintFade: 0.5,
  hintOutAt: 2.6,
  skipFade: 0.2,
  reducedFade: 0.6,
  reducedHold: 0.4,
}

// Hammer beats: time, strength, and how much crown solidity each strike adds.
const BEAT_AT = [1.1, 1.4, 1.7]
const BEAT_POWER = [0.7, 0.85, 1]
const BEAT_SOLIDITY = [0.22, 0.3, 0.48]

// ─────────────────────────────────────────────────────────────────────────────
// PALETTE — the gold ramp: deep coal → old gold → bright gold → white-hot.
// ─────────────────────────────────────────────────────────────────────────────
const PALETTE = {
  deep: "#2a1c06",
  ember: "#b8860b",
  gold: "#f5c542",
  hot: "#fff3d6",
}
// Letter color ramp endpoints (white-hot → gold → pure white), as RGB channels.
const HOT_RGB = [255, 243, 214]
const GOLD_RGB = [245, 197, 66]

// ─────────────────────────────────────────────────────────────────────────────
// PARTICLES & PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
const POOL = { crown: 820, ambient: 420, burst: 360, burstPerBeat: 110 }
const POOL_TOTAL = POOL.crown + POOL.ambient + POOL.burst // 1600
const EMBER_COUNT = POOL.crown + POOL.ambient

const PHYS = {
  gravity: 42, // px/s² — slowly bleeds the upward rise (forge metal, not confetti)
  wander: 30, // horizontal sway acceleration
  dragFree: 0.5,
  dragVortex: 2.4,
  swirl: 820, // tangential vortex strength
  pull: 1150, // radial vortex strength
  ambientPull: 0.4, // non-crown sparks orbit wide instead of clumping
  swirlRamp: 0.3, // seconds for the vortex to reach full grip
  extraWind: 2.2, // extra radians of spiral while homing onto the crown
  shakeAmp: 2.2, // px of full-canvas hammer shake at beat peak
  burstGravity: 460,
  burstDrag: 1.8,
  ambientFadeFrom: 1.55,
  ambientFadeDur: 0.7,
}

// Depth layers (far / mid / near): velocity, draw diameter, brightness.
const EMBER_VEL = [0.75, 1.2, 1.8]
const EMBER_SIZE = [6, 10, 16]
const EMBER_ALPHA = [0.32, 0.52, 0.78]

// ─────────────────────────────────────────────────────────────────────────────
// WORDMARK
// ─────────────────────────────────────────────────────────────────────────────
const LETTERS = Array.from("KAHUNA", (ch, i) => ({ ch, key: `${i}${ch}` }))
const MID = (LETTERS.length - 1) / 2
const TYPE = {
  spreadEm: 0.3, // extra per-letter tracking that tightens to 0
  riseEm: 0.34, // letters rise into place (easeOutBack overshoot)
  blurPx: 12,
  trackDur: 0.68,
  igniteDur: 0.14, // white-hot → gold
}
const WORD_SETTLED =
  FILM.wordFrom + 4 * FILM.wordStagger + Math.max(FILM.wordLetterDur, FILM.coolDelay + FILM.coolDur)

// ─────────────────────────────────────────────────────────────────────────────
// CROWN GEOMETRY — normalized polylines (x 0..1, y 0 top), scaled per resize.
// Classic five-point crown: flared sides, tallest center peak, ball tips,
// circlet band with three diamond gems.
// ─────────────────────────────────────────────────────────────────────────────
const CROWN_ASPECT = 0.74
const CROWN_MAX_W = 560

function ringPoly(cx: number, cy: number, r: number, segs: number): number[] {
  const pts: number[] = []
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  return pts
}

function diamondPoly(cx: number, cy: number, rx: number, ry: number): number[] {
  return [cx, cy - ry, cx + rx, cy, cx, cy + ry, cx - rx, cy, cx, cy - ry]
}

const CROWN_POLYS: number[][] = [
  // zigzag outline — five peaks, center tallest
  // biome-ignore format: coordinate pairs read better in rows
  [
    0.075, 0.74, 0.03, 0.205, 0.165, 0.565, 0.275, 0.1, 0.39, 0.525,
    0.5, 0.015, 0.61, 0.525, 0.725, 0.1, 0.835, 0.565, 0.97, 0.205, 0.925, 0.74,
  ],
  // circlet band
  [0.045, 0.74, 0.955, 0.74, 0.955, 0.945, 0.045, 0.945, 0.045, 0.74],
  // ball tips above each peak
  ringPoly(0.03, 0.155, 0.034, 12),
  ringPoly(0.275, 0.05, 0.034, 12),
  ringPoly(0.5, -0.037, 0.036, 12),
  ringPoly(0.725, 0.05, 0.034, 12),
  ringPoly(0.97, 0.155, 0.034, 12),
  // band gems
  diamondPoly(0.275, 0.8425, 0.04, 0.062),
  diamondPoly(0.5, 0.8425, 0.044, 0.068),
  diamondPoly(0.725, 0.8425, 0.04, 0.062),
]

// ─────────────────────────────────────────────────────────────────────────────
// EASINGS — nothing moves linearly.
// ─────────────────────────────────────────────────────────────────────────────
const TAU = Math.PI * 2
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a: number, b: number, k: number) => a + (b - a) * k
const easeInCubic = (k: number) => k * k * k
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3
const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
const easeOutExpo = (k: number) => (k >= 1 ? 1 : 1 - 2 ** (-10 * k))
const easeInOutExpo = (k: number) => {
  if (k <= 0) return 0
  if (k >= 1) return 1
  return k < 0.5 ? 2 ** (20 * k - 10) / 2 : (2 - 2 ** (-20 * k + 10)) / 2
}
const easeOutBack = (k: number) => {
  const c1 = 1.70158
  return 1 + (c1 + 1) * (k - 1) ** 3 + c1 * (k - 1) ** 2
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Pre-rendered radial-gradient sprite — drawn additively, scaled per particle. */
function makeGlow(dim: number, stops: [number, string][]): HTMLCanvasElement {
  const c = document.createElement("canvas")
  c.width = dim
  c.height = dim
  const g = c.getContext("2d")
  if (g) {
    const grad = g.createRadialGradient(dim / 2, dim / 2, 0, dim / 2, dim / 2, dim / 2)
    for (const [off, color] of stops) grad.addColorStop(off, color)
    g.fillStyle = grad
    g.fillRect(0, 0, dim, dim)
  }
  return c
}

/** Resample a set of polylines into exactly `count` evenly spaced points. */
function resampleInto(polys: number[][], count: number, xs: Float32Array, ys: Float32Array) {
  let total = 0
  for (const p of polys) {
    for (let i = 2; i < p.length; i += 2) {
      total += Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!)
    }
  }
  const step = total / count
  let carry = step * 0.5
  let n = 0
  for (const p of polys) {
    for (let i = 2; i < p.length; i += 2) {
      const x0 = p[i - 2]!
      const y0 = p[i - 1]!
      const dx = p[i]! - x0
      const dy = p[i + 1]! - y0
      const seg = Math.hypot(dx, dy)
      if (seg <= 0) continue
      while (carry <= seg) {
        if (n < count) {
          const f = carry / seg
          xs[n] = x0 + dx * f
          ys[n] = y0 + dy * f
          n++
        }
        carry += step
      }
      carry -= seg
    }
  }
  while (n > 0 && n < count) {
    xs[n] = xs[n - 1]!
    ys[n] = ys[n - 1]!
    n++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export function CoronationIntro({ onDone }: IntroProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wordRef = useRef<HTMLDivElement | null>(null)
  const hintRef = useRef<HTMLDivElement | null>(null)
  const letterRefs = useRef<(HTMLSpanElement | null)[]>([])
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const word = wordRef.current
    const hint = hintRef.current
    if (!root || !canvas || !word || !hint) return
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) return

    // StrictMode remount: wipe every imperative trace of a previous run.
    doneRef.current = false
    root.style.opacity = "1"
    root.style.transform = "none"
    word.style.opacity = "1"
    word.style.transform = "none"
    hint.style.opacity = "0"

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    for (const el of letterRefs.current) {
      if (!el) continue
      el.style.opacity = reduced ? "1" : "0"
      el.style.transform = "none"
      el.style.filter = "none"
      el.style.textShadow = "none"
      el.style.color = reduced ? "#ffffff" : PALETTE.gold
    }
    if (reduced) word.style.opacity = "0"

    // ── Sprites (built once; drawImage is the whole render vocabulary) ──────
    const sprites = [
      // 0 far — deep coal ember
      makeGlow(64, [
        [0, "rgba(214,160,40,1)"],
        [0.3, "rgba(184,134,11,0.55)"],
        [1, "rgba(42,28,6,0)"],
      ]),
      // 1 mid — old gold
      makeGlow(64, [
        [0, "rgba(255,224,130,1)"],
        [0.25, "rgba(245,197,66,0.7)"],
        [1, "rgba(184,134,11,0)"],
      ]),
      // 2 near — bright gold
      makeGlow(64, [
        [0, "rgba(255,243,214,1)"],
        [0.22, "rgba(245,197,66,0.8)"],
        [1, "rgba(245,197,66,0)"],
      ]),
      // 3 locked / white-hot
      makeGlow(64, [
        [0, "rgba(255,255,255,1)"],
        [0.2, "rgba(255,243,214,0.9)"],
        [0.5, "rgba(245,197,66,0.35)"],
        [1, "rgba(245,197,66,0)"],
      ]),
    ]
    const softGlow = makeGlow(256, [
      [0, "rgba(245,197,66,0.5)"],
      [0.55, "rgba(184,134,11,0.18)"],
      [1, "rgba(42,28,6,0)"],
    ])
    const ringSprite = makeGlow(256, [
      [0, "rgba(245,197,66,0)"],
      [0.62, "rgba(245,197,66,0)"],
      [0.8, "rgba(245,197,66,0.55)"],
      [0.9, "rgba(255,243,214,0.9)"],
      [1, "rgba(245,197,66,0)"],
    ])

    // ── Particle pools — structure-of-arrays, allocated once ────────────────
    const pX = new Float32Array(POOL_TOTAL)
    const pY = new Float32Array(POOL_TOTAL)
    const pVx = new Float32Array(POOL_TOTAL)
    const pVy = new Float32Array(POOL_TOTAL)
    const pSize = new Float32Array(POOL_TOTAL)
    const pSeed = new Float32Array(POOL_TOTAL)
    const pAlpha = new Float32Array(POOL_TOTAL)
    const pT0 = new Float32Array(POOL_TOTAL) // capture start / burst birth
    const pDur = new Float32Array(POOL_TOTAL) // capture duration / burst lifespan
    const pHomeR = new Float32Array(POOL_TOTAL) // polar radius at capture
    const pHomeA = new Float32Array(POOL_TOTAL) // polar angle at capture
    const pHomeDA = new Float32Array(POOL_TOTAL) // angle sweep to target (incl. wind)
    const pState = new Uint8Array(POOL_TOTAL) // 0 dead 1 ember 2 homing 3 locked 4 burst
    const pSpr = new Uint8Array(POOL_TOTAL)
    const pTarg = new Int16Array(POOL_TOTAL).fill(-1)

    // Crown targets (filled on resize) + shuffled ember→target assignment.
    const tX = new Float32Array(POOL.crown)
    const tY = new Float32Array(POOL.crown)
    const tA = new Float32Array(POOL.crown)
    const tR = new Float32Array(POOL.crown)
    const targetOf = new Int16Array(EMBER_COUNT)
    for (let i = 0; i < EMBER_COUNT; i++) targetOf[i] = i < POOL.crown ? i : -1
    for (let i = EMBER_COUNT - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0
      const tmp = targetOf[i]!
      targetOf[i] = targetOf[j]!
      targetOf[j] = tmp
    }

    // ── Geometry (rebuilt on resize) ─────────────────────────────────────────
    let W = 0
    let H = 0
    let cx = 0
    let cy = 0
    let minDim = 0
    let dpr = 1
    let crownPath: Path2D | null = null
    let vignette: CanvasGradient | null = null

    const resize = () => {
      W = window.innerWidth
      H = window.innerHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(W * dpr))
      canvas.height = Math.max(1, Math.round(H * dpr))
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      cx = W * 0.5
      cy = H * 0.46
      minDim = Math.min(W, H)
      const crownW = Math.min(W * 0.72, (H * 0.56) / CROWN_ASPECT, CROWN_MAX_W)
      const crownH = crownW * CROWN_ASPECT
      const scaled: number[][] = []
      const path = new Path2D()
      for (const p of CROWN_POLYS) {
        const out = new Array<number>(p.length)
        for (let i = 0; i < p.length; i += 2) {
          out[i] = cx + (p[i]! - 0.5) * crownW
          out[i + 1] = cy + (p[i + 1]! - 0.45) * crownH
        }
        scaled.push(out)
        path.moveTo(out[0]!, out[1]!)
        for (let i = 2; i < out.length; i += 2) path.lineTo(out[i]!, out[i + 1]!)
      }
      crownPath = path
      resampleInto(scaled, POOL.crown, tX, tY)
      for (let i = 0; i < POOL.crown; i++) {
        tA[i] = Math.atan2(tY[i]! - cy, tX[i]! - cx)
        tR[i] = Math.hypot(tX[i]! - cx, tY[i]! - cy)
      }
      vignette = ctx.createRadialGradient(
        cx,
        H * 0.48,
        minDim * 0.3,
        cx,
        H * 0.5,
        Math.hypot(W, H) * 0.6,
      )
      vignette.addColorStop(0, "rgba(0,0,0,0)")
      vignette.addColorStop(0.55, "rgba(0,0,0,0.14)")
      vignette.addColorStop(1, "rgba(0,0,0,0.66)")
    }
    resize()

    // ── Spawning ─────────────────────────────────────────────────────────────
    let spawned = 0
    const spawnTarget = (t: number) => {
      if (t < FILM.heroAt) return 0
      if (t < FILM.swarmFrom) return 1
      const k = clamp01((t - FILM.swarmFrom) / (FILM.swarmFull - FILM.swarmFrom))
      return 1 + Math.floor((EMBER_COUNT - 1) * easeInOutCubic(k))
    }

    const spawnEmber = () => {
      const i = spawned
      const hero = i === 0
      const r1 = Math.random()
      const layer = hero ? 2 : r1 < 0.45 ? 0 : r1 < 0.82 ? 1 : 2
      pState[i] = 1
      pX[i] = hero ? cx : W * (0.5 + (Math.random() + Math.random() - 1) * 0.4)
      pY[i] = H + 10 + Math.random() * 28
      pVx[i] = (Math.random() - 0.5) * 36
      pVy[i] = hero ? -240 : -(80 + Math.random() * 130) * EMBER_VEL[layer]!
      pSize[i] = EMBER_SIZE[layer]! * (0.75 + Math.random() * 0.5) * (hero ? 2.4 : 1)
      pAlpha[i] = EMBER_ALPHA[layer]!
      pSeed[i] = Math.random() * 100
      pSpr[i] = hero ? 2 : layer
      const ti = targetOf[i]!
      pTarg[i] = ti
      if (ti >= 0) {
        // Locks sweep the outline and finish right on the third hammer beat:
        // beat 1 strikes a swirl, beat 2 lands the first metal, beat 3 completes it.
        const frac = ti / POOL.crown
        pT0[i] = FILM.captureFrom + frac * FILM.captureSpread + Math.random() * 0.12
        pDur[i] = 0.52 - frac * 0.22 + Math.random() * 0.08
      }
      spawned++
    }

    let burstCursor = EMBER_COUNT
    const igniteBurst = (t: number, power: number, countMul: number) => {
      const n = Math.round(POOL.burstPerBeat * power * countMul)
      for (let k = 0; k < n; k++) {
        const i = burstCursor
        burstCursor++
        if (burstCursor >= POOL_TOTAL) burstCursor = EMBER_COUNT
        const ti = (Math.random() * POOL.crown) | 0
        const ox = tX[ti]!
        const oy = tY[ti]!
        let dx = ox - cx
        let dy = oy - cy
        const d = Math.hypot(dx, dy) || 1
        dx /= d
        dy /= d
        const ja = (Math.random() - 0.5) * 0.8
        const ca = Math.cos(ja)
        const sa = Math.sin(ja)
        const sp = (170 + Math.random() * 290) * power
        pState[i] = 4
        pTarg[i] = -1
        pX[i] = ox
        pY[i] = oy
        pVx[i] = (dx * ca - dy * sa) * sp
        pVy[i] = (dx * sa + dy * ca) * sp - 40
        pSize[i] = 5 + Math.random() * 8
        pAlpha[i] = 0.85
        pSeed[i] = Math.random() * 100
        pSpr[i] = Math.random() < 0.4 ? 3 : 2
        pT0[i] = t
        pDur[i] = 0.4 + Math.random() * 0.42
      }
    }

    // ── The hot loop — update + draw every live particle, zero allocation ────
    const stepParticles = (
      t: number,
      dt: number,
      colK: number,
      colE: number,
      beatFlash: number,
      strokeBase: number,
      dieOut: number,
    ) => {
      const swirlK = clamp01((t - FILM.forgeAt) / PHYS.swirlRamp)
      const ambFade = 1 - clamp01((t - PHYS.ambientFadeFrom) / PHYS.ambientFadeDur)
      const lockBoost = 0.55 + 0.4 * Math.min(1, strokeBase) + beatFlash * 0.3
      for (let i = 0; i < POOL_TOTAL; i++) {
        let st = pState[i]!
        if (st === 0) continue
        const sd = pSeed[i]!
        const flick = 0.66 + 0.34 * Math.sin(sd * 13 + t * (6 + (sd % 1) * 9))
        let x = pX[i]!
        let y = pY[i]!
        let a = 0
        let d = pSize[i]!
        let si = pSpr[i]!

        // State transitions
        if (st === 1) {
          const ti = pTarg[i]!
          if (ti >= 0 && t >= pT0[i]!) {
            const dx = x - cx
            const dy = y - cy
            pHomeR[i] = Math.hypot(dx, dy)
            const a0 = Math.atan2(dy, dx)
            pHomeA[i] = a0
            let da = tA[ti]! - a0
            da -= Math.round(da / TAU) * TAU
            pHomeDA[i] = da + PHYS.extraWind
            pState[i] = 2
            st = 2
          }
        }
        if (st === 2 && t - pT0[i]! >= pDur[i]!) {
          pState[i] = 3
          st = 3
        }
        if (st === 3 && colK >= 1) {
          pState[i] = 0
          continue
        }

        if (st === 1) {
          // Free ember: rise, sway, flicker — then the vortex grips.
          let vxi = pVx[i]!
          let vyi = pVy[i]!
          vxi += Math.sin(sd + t * 2.1) * PHYS.wander * dt
          vyi += PHYS.gravity * dt
          const ti = pTarg[i]!
          if (swirlK > 0) {
            const dx = x - cx
            const dy = y - cy
            const f = swirlK / (Math.hypot(dx, dy) + 24)
            const pull = PHYS.pull * (ti >= 0 ? 1 : PHYS.ambientPull)
            vxi += (-dy * PHYS.swirl - dx * pull) * f * dt
            vyi += (dx * PHYS.swirl - dy * pull) * f * dt
          }
          const dr = 1 - (swirlK > 0 ? PHYS.dragVortex : PHYS.dragFree) * dt
          vxi *= dr
          vyi *= dr
          x += vxi * dt
          y += vyi * dt
          pVx[i] = vxi
          pVy[i] = vyi
          pX[i] = x
          pY[i] = y
          if (y < -30 || x < -40 || x > W + 40) {
            pState[i] = 0
            continue
          }
          a = pAlpha[i]! * flick
          if (ti < 0) {
            a *= ambFade
            if (ambFade <= 0.001) {
              pState[i] = 0
              continue
            }
          }
        } else if (st === 2) {
          // Homing: deterministic spiral from captured polar position to target.
          const ti = pTarg[i]!
          const k = (t - pT0[i]!) / pDur[i]!
          const rr = pHomeR[i]! + (tR[ti]! - pHomeR[i]!) * easeInOutCubic(k)
          const aa = pHomeA[i]! + pHomeDA[i]! * easeOutCubic(k)
          const wob = Math.sin(sd * 7 + k * 13) * 14 * (1 - k) * (1 - k)
          x = cx + Math.cos(aa) * (rr + wob)
          y = cy + Math.sin(aa) * (rr + wob)
          pX[i] = x
          pY[i] = y
          a = pAlpha[i]! * (0.8 + 0.45 * easeOutCubic(k)) * flick
          si = si < 2 ? si + 1 : 2
        } else if (st === 3) {
          // Locked into the crown: shimmer, kick on hammer beats, collapse in act 3.
          const ti = pTarg[i]!
          if (colK > 0) {
            x = tX[ti]! + (cx - tX[ti]!) * colE
            y = tY[ti]! + (cy - tY[ti]!) * colE
            a = lockBoost * flick * (1 - colE)
            d *= 1 - 0.55 * colE
          } else {
            const ang = tA[ti]!
            const off = beatFlash * 5 + Math.sin(sd * 9 + t * 11) * 0.8
            x = tX[ti]! + Math.cos(ang) * off
            y = tY[ti]! + Math.sin(ang) * off
            a = lockBoost * flick
          }
          pX[i] = x
          pY[i] = y
          d *= 0.8
          si = 3
        } else {
          // Burst spark: ballistic, dies fast.
          const u = (t - pT0[i]!) / pDur[i]!
          if (u >= 1) {
            pState[i] = 0
            continue
          }
          let vxi = pVx[i]!
          let vyi = pVy[i]!
          vyi += PHYS.burstGravity * dt
          const dr = 1 - PHYS.burstDrag * dt
          vxi *= dr
          vyi *= dr
          x += vxi * dt
          y += vyi * dt
          pVx[i] = vxi
          pVy[i] = vyi
          pX[i] = x
          pY[i] = y
          a = pAlpha[i]! * (1 - u) ** 1.6 * flick
          d *= 1 - 0.35 * u
        }

        a *= dieOut
        if (a > 0.004) {
          ctx.globalAlpha = a > 1 ? 1 : a
          ctx.drawImage(sprites[si]!, x - d * 0.5, y - d * 0.5, d, d)
        }
      }
    }

    // ── Wordmark — DOM letters driven off the same clock ─────────────────────
    let lettersSettled = false
    const updateWordmark = (t: number) => {
      if (t < FILM.wordFrom || lettersSettled) return
      const tt = Math.min(t, WORD_SETTLED)
      if (t >= WORD_SETTLED) lettersSettled = true
      const trackS =
        TYPE.spreadEm * (1 - easeOutExpo(clamp01((tt - FILM.wordFrom) / TYPE.trackDur)))
      for (let i = 0; i < LETTERS.length; i++) {
        const el = letterRefs.current[i]
        if (!el) continue
        // Center-out ignition: S/M first, K/R last — energy radiating from the flash.
        const st0 = FILM.wordFrom + (Math.abs(i - MID) - 0.5) * FILM.wordStagger
        const k = clamp01((tt - st0) / FILM.wordLetterDur)
        if (k <= 0) continue
        const ek = easeOutCubic(k)
        const igK = clamp01((tt - st0) / TYPE.igniteDur)
        const coolK = easeInOutCubic(clamp01((tt - st0 - FILM.coolDelay) / FILM.coolDur))
        const op = Math.min(1, k * 1.9)
        const glow = (1 - coolK) * op
        const r = Math.round(mix(mix(HOT_RGB[0]!, GOLD_RGB[0]!, igK), 255, coolK))
        const g = Math.round(mix(mix(HOT_RGB[1]!, GOLD_RGB[1]!, igK), 255, coolK))
        const b = Math.round(mix(mix(HOT_RGB[2]!, GOLD_RGB[2]!, igK), 255, coolK))
        el.style.opacity = `${op}`
        const xOff = (i - MID) * trackS
        const yOff = TYPE.riseEm * (1 - easeOutBack(k))
        el.style.transform = `translate3d(${xOff}em, ${yOff}em, 0)`
        el.style.filter = ek >= 1 ? "none" : `blur(${TYPE.blurPx * (1 - ek)}px)`
        el.style.color = `rgb(${r},${g},${b})`
        if (glow > 0.02) {
          const s1 = `0 0 ${18 * glow}px rgba(245,197,66,${0.9 * glow})`
          const s2 = `0 0 ${46 * glow}px rgba(245,197,66,${0.45 * glow})`
          el.style.textShadow = `${s1}, ${s2}`
        } else {
          el.style.textShadow = "none"
        }
      }
    }

    // ── Frame render — acts 1–4 on the canvas, then the DOM layer ───────────
    const beatFired = [false, false, false]
    let flareFired = false

    const renderFrame = (t: number, dt: number) => {
      // Cues: hammer-beat bursts + flare burst fire exactly once.
      for (let b = 0; b < BEAT_AT.length; b++) {
        if (!beatFired[b] && t >= BEAT_AT[b]!) {
          beatFired[b] = true
          igniteBurst(t, BEAT_POWER[b]!, 1)
        }
      }
      if (!flareFired && t >= FILM.flareAt) {
        flareFired = true
        igniteBurst(t, 1, 1.2)
      }

      // Frame-wide envelopes.
      let strokeBase = 0
      let beatFlash = 0
      for (let b = 0; b < BEAT_AT.length; b++) {
        const u = t - BEAT_AT[b]!
        if (u >= 0) {
          strokeBase += BEAT_SOLIDITY[b]!
          if (u < 0.7) beatFlash += Math.exp(-u * 8) * BEAT_POWER[b]!
        }
      }
      const fu = t - FILM.flareAt
      const flare = fu < 0 ? 0 : fu < 0.15 ? easeOutCubic(fu / 0.15) : Math.exp(-(fu - 0.15) * 6)
      const colK = clamp01((t - FILM.collapseFrom) / FILM.collapseDur)
      const colE = easeInCubic(colK)
      const dieOut = 1 - clamp01((t - FILM.dieFrom) / FILM.dieDur)
      const fk = clamp01((t - FILM.flashFrom) / (FILM.flashPeak - FILM.flashFrom))
      const flashE =
        (t < FILM.flashFrom
          ? 0
          : t < FILM.flashPeak
            ? fk * fk
            : Math.exp(-(t - FILM.flashPeak) * 5.5)) * dieOut

      // Spawn embers along the swarm ramp.
      const want = spawnTarget(t)
      while (spawned < want && spawned < EMBER_COUNT) spawnEmber()

      // Hammer shake — canvas transform, never CSS layout.
      const shake = beatFlash * PHYS.shakeAmp + flare * 0.8
      const ox = Math.sin(t * 127) * shake
      const oy = Math.cos(t * 149) * shake * 0.8
      ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr)
      ctx.globalCompositeOperation = "source-over"
      ctx.globalAlpha = 1
      ctx.fillStyle = "#000000"
      ctx.fillRect(-8, -8, W + 16, H + 16)

      ctx.globalCompositeOperation = "lighter"

      // Forge bed — warm light breathing up from the bottom edge.
      const bed = 0.14 * clamp01((t - 0.22) / 0.6) * (1 - clamp01((t - 2.0) / 0.5))
      if (bed > 0.004) {
        ctx.globalAlpha = bed
        ctx.drawImage(softGlow, cx - W * 0.85, H - H * 0.24, W * 1.7, H * 0.55)
      }
      // Center ambience — the vortex heats the air around the crown.
      const warm =
        (0.05 * clamp01((t - FILM.forgeAt) / 0.4) + 0.1 * Math.min(1, strokeBase)) * (1 - colE)
      if (warm > 0.004) {
        ctx.globalAlpha = warm
        const s = minDim * 1.15
        ctx.drawImage(softGlow, cx - s / 2, cy - s / 2, s, s)
      }

      stepParticles(t, dt, colK, colE, beatFlash, strokeBase, dieOut)

      // Crown stroke passes — solidity gained beat by beat, collapsing in act 3.
      const crownVis = Math.min(1, strokeBase) * (1 - colE) * dieOut
      if (crownVis > 0.01 && crownPath) {
        const glow = crownVis * (1 + beatFlash * 0.7 + flare * 1.5)
        ctx.save()
        if (colK > 0) {
          const sc = 1 - 0.94 * colE
          ctx.translate(cx, cy)
          ctx.scale(sc, sc)
          ctx.translate(-cx, -cy)
        }
        ctx.strokeStyle = PALETTE.gold
        ctx.lineWidth = 7
        ctx.globalAlpha = Math.min(1, 0.15 * glow)
        ctx.stroke(crownPath)
        ctx.lineWidth = 2.6
        ctx.globalAlpha = Math.min(1, 0.42 * glow)
        ctx.stroke(crownPath)
        ctx.strokeStyle = PALETTE.hot
        ctx.lineWidth = 1.2
        ctx.globalAlpha = Math.min(1, 0.85 * glow)
        ctx.stroke(crownPath)
        ctx.restore()
      }

      // Radial light pulses — one per hammer beat, one shockwave at the flare.
      for (let b = 0; b < BEAT_AT.length; b++) {
        const u = t - BEAT_AT[b]!
        if (u >= 0 && u < 0.55) {
          const k = u / 0.55
          const rr = minDim * 0.78 * easeOutCubic(k) + 30
          ctx.globalAlpha = (1 - k) ** 1.6 * 0.5 * BEAT_POWER[b]!
          ctx.drawImage(ringSprite, cx - rr, cy - rr, rr * 2, rr * 2)
        }
      }
      if (fu >= 0 && fu < 0.6) {
        const k = fu / 0.6
        const rr = minDim * (0.2 + 0.9 * easeOutCubic(k))
        ctx.globalAlpha = (1 - k) ** 1.7 * 0.6
        ctx.drawImage(ringSprite, cx - rr, cy - rr, rr * 2, rr * 2)
      }

      // Central flash — the crown's energy becoming the wordmark.
      if (flashE > 0.004) {
        const grow = easeOutCubic(clamp01((t - FILM.flashFrom) / 0.55))
        const dBig = minDim * (0.55 + 0.55 * grow)
        ctx.globalAlpha = Math.min(1, flashE * 0.8)
        ctx.drawImage(softGlow, cx - dBig / 2, cy - dBig / 2, dBig, dBig)
        const dCore = dBig * 0.32
        ctx.globalAlpha = Math.min(1, flashE)
        ctx.drawImage(sprites[3]!, cx - dCore / 2, cy - dCore / 2, dCore, dCore)
      }

      // Vignette frames every act.
      ctx.globalCompositeOperation = "source-over"
      if (vignette) {
        ctx.globalAlpha = 1
        ctx.fillStyle = vignette
        ctx.fillRect(-8, -8, W + 16, H + 16)
      }

      // DOM layer: wordmark, skip hint, curtain.
      updateWordmark(t)
      const hintA =
        easeInOutCubic(clamp01((t - FILM.hintAt) / FILM.hintFade)) *
        (1 - clamp01((t - FILM.hintOutAt) / 0.25))
      hint.style.opacity = `${hintA}`

      if (t >= FILM.exitAt) {
        const k = easeInOutExpo(clamp01((t - FILM.exitAt) / FILM.exitDur))
        root.style.transform = `translate3d(0, ${-100 * k}%, 0)`
        word.style.transform = `translate3d(0, ${9 * k}vh, 0)` // gentle counter-parallax
        if (k >= 1) finish()
      }
      if (t >= FILM.end + 0.3) finish()
    }

    const renderReduced = (t: number) => {
      word.style.opacity = `${easeInOutCubic(clamp01(t / FILM.reducedFade))}`
      if (t >= FILM.reducedFade + FILM.reducedHold) finish()
    }

    // ── Clock, skip, lifecycle ───────────────────────────────────────────────
    let rafId = 0
    let startedAt = -1
    let lastNow = -1
    let lastT = 0
    let skipFrom = -1

    const finish = () => {
      if (doneRef.current) return
      doneRef.current = true
      cancelAnimationFrame(rafId)
      onDoneRef.current()
    }

    const tick = (now: number) => {
      if (doneRef.current) return
      rafId = requestAnimationFrame(tick)
      if (startedAt < 0) {
        startedAt = now
        lastNow = now
      }
      const t = (now - startedAt) / 1000
      const dt = Math.min((now - lastNow) / 1000, 1 / 30)
      lastNow = now
      lastT = t
      if (reduced) renderReduced(t)
      else renderFrame(t, dt)
      if (skipFrom >= 0) {
        const k = (t - skipFrom) / FILM.skipFade
        root.style.opacity = `${Math.max(0, 1 - k)}`
        if (k >= 1) finish()
      }
    }

    const skip = () => {
      if (skipFrom >= 0 || doneRef.current) return
      skipFrom = lastT
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip()
    }
    const onPointerDown = () => skip()

    window.addEventListener("keydown", onKey)
    window.addEventListener("resize", resize)
    root.addEventListener("pointerdown", onPointerDown)
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", resize)
      root.removeEventListener("pointerdown", onPointerDown)
    }
  }, [])

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="fixed inset-0 z-[100] overflow-hidden bg-black will-change-transform"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={wordRef} className="absolute inset-0 flex items-center justify-center">
        <div
          className="select-none whitespace-nowrap font-semibold"
          style={{
            fontSize: "clamp(28px, 5vw, 56px)",
            letterSpacing: "0.14em",
            paddingLeft: "0.14em",
          }}
        >
          {LETTERS.map((l, i) => (
            <span
              key={l.key}
              ref={(el) => {
                letterRefs.current[i] = el
              }}
              className="inline-block will-change-[transform,filter,opacity]"
              style={{ opacity: 0 }}
            >
              {l.ch}
            </span>
          ))}
        </div>
      </div>
      <div
        ref={hintRef}
        className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-xs text-white/40"
        style={{ opacity: 0 }}
      >
        Click or press Esc to skip
      </div>
    </div>
  )
}
