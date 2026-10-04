import { useEffect, useRef } from "react"
import type { IntroProps } from "./types"

/**
 * MONOLITH — WebGL throne-room intro (~4.3s including the final release).
 *
 * A dark hall. Volumetric god-rays sweep an obsidian slab; the KAHUNA
 * wordmark is etched into its face and legible only where light crosses it.
 * The main beam locks on, the etching floods with light, and a radial
 * whiteout hands the frame to the app.
 *
 * Timeline (one rAF clock, performance.now deltas → uniforms):
 *   Act 1 — SWEEP  0.0–2.4s  two beam passes, each decelerating over the slab
 *   Act 2 — LOCK   2.4–3.2s  beam glides on and pins; intensity swells (easeInCubic)
 *   Act 3 — REVEAL 3.2–4.0s  radial light flood w/ grain + chromatic fringe
 *   Release        4.0–4.3s  overlay opacity hands off to the app → onDone
 *
 * Tech: raw WebGL (webgl2 → webgl1 fallback), one fullscreen triangle, one
 * GLSL ES 1.00 program. The wordmark is rasterised to an
 * offscreen 2D canvas and channel-packed into a single texture: R = crisp
 * glyphs, G = pre-blurred glow for in-shader bloom. If context creation or
 * compile/link fails — or on `webglcontextlost` — a CSS fallback (diagonal
 * light sweep + wordmark fade + flood) runs on the same clock and duration.
 * `prefers-reduced-motion` gets a static ~600ms wordmark fade instead.
 */

type GL = WebGLRenderingContext | WebGL2RenderingContext

const UNIFORM_NAMES = [
  "res",
  "time",
  "a1",
  "i1",
  "a2",
  "i2",
  "lock",
  "flood",
  "yaw",
  "zoom",
  "tex",
] as const
type Uniforms = Record<(typeof UNIFORM_NAMES)[number], WebGLUniformLocation | null>

/* ------------------------------------------------------------------------ *
 * Timeline + tuning knobs (seconds unless noted)
 * ------------------------------------------------------------------------ */

const TL = {
  beamsIn: 0.05, // beams breathe in from black
  beamsInDone: 0.5,
  sweepAStart: 0.18, // pass A enters far left…
  sweepAPeak: 0.8, // …decelerates onto the slab (first glint)
  sweepAEnd: 1.35, // …accelerates off right
  sweepBPeak: 1.95, // pass B lingers over the slab (second glint)
  sweepBEnd: 2.4, // …sinks away left — beat of darkness
  lockStart: 2.4, // beam glides back…
  lockSettle: 2.95, // …and pins the slab
  lockEnd: 3.2, // intensity swell complete
  floodEnd: 4.0, // radial whiteout complete
  release: 4.3, // overlay handed off → onDone
  hintIn: 1.2,
  hintInDone: 1.7,
  hintOut: 3.0,
  hintOutDone: 3.3,
  skipFade: 0.2, // fast fade after click/Esc
  reducedIn: 0.6, // reduced-motion: wordmark fade-in
  reducedHold: 1.25,
  reducedEnd: 1.55,
} as const

const MAX_DPR = 1.5
const TEX_W = 2048
const TEX_H = 512
const FONT_SPEC = '600 64px "Geist Variable"'

/* ------------------------------------------------------------------------ *
 * Easing
 * ------------------------------------------------------------------------ */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const ramp = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const easeInCubic = (k: number) => k * k * k
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3
const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
const easeInOutSine = (k: number) => -(Math.cos(Math.PI * k) - 1) / 2
const easeOutQuad = (k: number) => 1 - (1 - k) * (1 - k)
const degToRad = (d: number) => (d * Math.PI) / 180

/**
 * Horizontal aim point (scene units) of the hero beam over time. Each sweep
 * decelerates over the slab (easeOut in, easeIn out) so the etched wordmark
 * stays legible at the apex of every pass, then the LOCK glide pins center.
 */
function beamAim(t: number): number {
  if (t < TL.sweepAPeak)
    return lerp(-1.7, -0.04, easeOutCubic(ramp(t, TL.sweepAStart, TL.sweepAPeak)))
  if (t < TL.sweepAEnd) return lerp(-0.04, 1.4, easeInCubic(ramp(t, TL.sweepAPeak, TL.sweepAEnd)))
  if (t < TL.sweepBPeak) return lerp(1.4, 0.1, easeOutCubic(ramp(t, TL.sweepAEnd, TL.sweepBPeak)))
  if (t < TL.sweepBEnd)
    return lerp(0.1, -0.62, easeInOutCubic(ramp(t, TL.sweepBPeak, TL.sweepBEnd)))
  return lerp(-0.62, 0.02, easeInOutCubic(ramp(t, TL.lockStart, TL.lockSettle)))
}

/* ------------------------------------------------------------------------ *
 * Shaders (GLSL ES 1.00 — valid on both webgl1 and webgl2)
 * ------------------------------------------------------------------------ */

const VERT_SRC = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG_SRC = `
precision highp float;

uniform vec2  u_res;
uniform float u_time;
uniform float u_a1;    // hero beam angle (rad from straight-down)
uniform float u_i1;    // hero beam intensity
uniform float u_a2;    // counter beam angle
uniform float u_i2;    // counter beam intensity
uniform float u_lock;  // Act 2 progress, eased CPU-side
uniform float u_flood; // Act 3 progress, eased CPU-side
uniform float u_yaw;   // slab yaw (rad), drifts upright over the run
uniform float u_zoom;  // slow dolly-in
uniform sampler2D u_tex; // R: crisp wordmark, G: pre-blurred glow

const float PI  = 3.14159265;
const float TAU = 6.28318531;
const vec2  SLAB_HS  = vec2(0.30, 0.62);  // slab half-extents
const float SLAB_R   = 0.045;             // corner radius
const vec2  SLAB_C   = vec2(0.0, -0.03);  // slab center (scene space)
const vec2  PLAQUE_C = vec2(0.0, 0.05);   // etching center (slab space)
const float PLAQUE_W = 0.46;
const float PLAQUE_H = 0.115;             // PLAQUE_W / (texW / texH)
const vec3  WARM     = vec3(1.0, 0.985, 0.955); // whisper of warmth
const vec2  BEAM1_O  = vec2(-0.78, 1.32);  // hero beam origin (also etch-reveal axis)

// Spec-safe smoothstep that allows inverted edges.
float ss(float a, float b, float x) {
  float k = clamp((x - a) / (b - a), 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}

float hash12(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.55 * vnoise(p);
  v += 0.30 * vnoise(p * 2.13 + 17.7);
  v += 0.15 * vnoise(p * 4.41 + 41.3);
  return v;
}

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Analytic god-ray: origin o, angle a from straight-down, half-width w.
// fbm advected along the beam makes it read volumetric.
float beamField(vec2 p, vec2 o, float a, float w, float it, float seed) {
  if (it <= 0.001) return 0.0;
  vec2 dir = vec2(sin(a), -cos(a));
  vec2 rel = p - o;
  float along = dot(rel, dir);
  if (along <= 0.0) return 0.0;
  float perp = dot(rel, vec2(-dir.y, dir.x));
  float ww = w * (0.5 + along * 0.4);
  float core = exp(-perp * perp / (ww * ww));
  float fall = ss(0.0, 0.3, along) * exp(-along * 0.45);
  float dens = fbm(vec2(perp * 6.0 + seed, along * 1.9 - u_time * 0.5));
  return core * fall * (0.5 + 0.7 * dens) * it;
}

float beams(vec2 p) {
  float b = beamField(p, BEAM1_O, u_a1, 0.16, u_i1, 11.0);
  b += beamField(p, vec2(0.82, 1.28), u_a2, 0.20, u_i2, 37.0);
  b += beamField(p, vec2(0.05, 1.45), 0.05 * sin(u_time * 0.26), 0.45, 0.10, 71.0);
  return b;
}

// Hash-sparkle dust motes drifting upward; caller gates them to beam light.
float dustLayer(vec2 p, float sc, float sp, float seed) {
  vec2 q = p * sc + vec2(seed * 3.1, -u_time * sp);
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;
  float h = hash12(id + seed);
  if (h < 0.72) return 0.0;
  vec2 mp = (vec2(hash12(id + seed + 11.0), hash12(id + seed + 23.0)) - 0.5) * 0.7;
  mp.x += 0.1 * sin(u_time * (0.7 + h) + h * 40.0);
  float r = length(f - mp);
  float tw = 0.55 + 0.45 * sin(u_time * (2.0 + 3.0 * h) + h * 80.0);
  return ss(0.09 + 0.07 * h, 0.0, r) * tw;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = (frag * 2.0 - u_res) / u_res.y;
  p *= u_zoom;
  p += 0.006 * vec2(sin(u_time * 0.5), cos(u_time * 0.4)); // breath of handheld sway

  // ---- slab space: tiny roll + fake perspective yaw about the vertical axis
  vec2 sp = p - SLAB_C;
  float cr = cos(u_yaw * 0.22);
  float sr = sin(u_yaw * 0.22);
  sp = mat2(cr, -sr, sr, cr) * sp;
  float pers = 1.0 + sp.x * sin(u_yaw) * 0.55;
  vec2 q = vec2(sp.x * pers / cos(u_yaw), sp.y * (1.0 + sp.x * sin(u_yaw) * 0.18));

  float d = sdRoundRect(q, SLAB_HS, SLAB_R);
  float aa = 2.2 * u_zoom / u_res.y;
  float slab = ss(aa, -aa, d);
  float dOut = max(d, 0.0);

  // ---- light fields (air at p; mirrored field for face reflections)
  float air = beams(p);
  float airRefl = beams(vec2(-p.x, p.y));
  float lockE = u_lock;

  // ---- hall: near-black depth gradient + faint drifting atmosphere
  vec3 col = vec3(0.012, 0.013, 0.017);
  col *= 1.0 - 0.45 * ss(0.3, 1.6, length(p * vec2(0.75, 1.0)));
  col += vec3(0.014, 0.014, 0.016) * fbm(p * vec2(1.4, 2.2) + vec2(u_time * 0.04, 0.0));

  // pool of light where the beams meet the floor
  col += WARM * air * ss(-0.55, -1.05, p.y) * 0.22;

  // volumetric shafts + dust motes (slab occludes both)
  float airVis = 1.0 - slab;
  col += WARM * air * 0.34 * airVis;
  float motes = dustLayer(p, 16.0, 0.05, 1.0) + 0.7 * dustLayer(p, 9.0, 0.03, 2.0);
  col += WARM * motes * air * 0.9 * airVis;

  // contact occlusion grounding the slab silhouette
  col *= 1.0 - 0.25 * exp(-dOut * 5.0) * airVis * ss(0.4, -0.6, p.y);

  // ---- obsidian face: sheen, micro-grain, mirrored beam reflections
  vec3 face = vec3(0.039, 0.039, 0.047);
  face *= 0.85 + 0.3 * ss(-0.7, 0.7, q.y);
  face += vec3(0.012) * vnoise(q * vec2(26.0, 90.0));
  float fres = 0.35 + 0.65 * ss(-0.12, 0.0, d);
  face += WARM * airRefl * 0.15 * fres;
  face += WARM * air * 0.09;

  // ---- etched wordmark: visible only where beam light crosses the slab.
  // Per-pixel air gives the raking texture; an analytic (noise-free) measure
  // of hero-beam-axis proximity to the slab floors the visibility so the
  // whole word reads legibly at each sweep apex, not just the beam core.
  vec2 bdir = vec2(sin(u_a1), -cos(u_a1));
  float bperp = dot(SLAB_C - BEAM1_O, vec2(-bdir.y, bdir.x));
  float hit = exp(-bperp * bperp * 18.0) * min(u_i1, 1.0);
  vec2 tuv = (q - PLAQUE_C) / vec2(PLAQUE_W, PLAQUE_H) + 0.5;
  float wm = texture2D(u_tex, tuv).r;
  float wmUp = texture2D(u_tex, tuv + vec2(0.0, 0.012)).r;
  float catchL = clamp(wm - wmUp, 0.0, 1.0); // light catch on the upper lip
  float etchVis = max(clamp(air * 3.2 + hit * 0.7, 0.0, 1.0), lockE);
  face -= vec3(wm) * (0.045 + 0.10 * etchVis) * (1.0 - lockE); // dark inset
  face += WARM * catchL * 2.0 * etchVis * (1.0 - 0.4 * lockE);
  face += WARM * wm * 0.32 * etchVis;

  // pre-blurred glow channel: shimmer on sweeps, bloom blow-out on LOCK.
  // The swell must stay small — a larger scale renders a second, bigger copy
  // of the word whose letters land between the crisp ones (reads as garble).
  vec2 tuvG = (tuv - 0.5) / (1.0 + 0.1 * lockE) + 0.5;
  float glowS = texture2D(u_tex, tuvG).g;
  face += WARM * glowS * 0.45 * etchVis * (1.0 - lockE);
  face += WARM * (wm * 2.6 * lockE * lockE + pow(glowS, 1.25) * 2.2 * lockE);
  face += WARM * exp(-length(q - PLAQUE_C) * 2.4) * 0.55 * lockE;

  col = mix(col, face, slab);

  // ---- bevel: traveling specular streak + beam catch + LOCK flare
  float edge = exp(-abs(d) * 90.0);
  float ea = atan(q.y, q.x * 2.07 + 0.0001);
  float ad = abs(mod(ea + 0.7 + u_time * 1.5 + PI, TAU) - PI);
  float streak = exp(-ad * ad * 6.0);
  float edgeL = edge * (air * 0.85 + streak * (0.18 + 0.45 * air));
  edgeL += edge * lockE * lockE * (1.4 + 0.8 * streak);
  col += WARM * edgeL;

  // ---- Act 3: radial light flood (bloom, not clip)
  float fl = u_flood;
  col *= 1.0 + 1.1 * fl; // exposure swell as the light arrives
  float vig = 1.0 - 0.5 * ss(0.45, 1.55, length(p * vec2(0.82, 1.0)));
  col *= mix(vig, 1.0, fl);
  col = 1.0 - exp(-col * 1.35); // filmic soft shoulder — highlights roll, never clip

  float R = 0.0001 + fl * fl * 7.5;
  float mr = ss(R * 1.06, R * 0.22, dOut); // per-channel radii → chromatic fringe
  float mg = ss(R, R * 0.25, dOut);
  float mb = ss(R * 0.94, R * 0.28, dOut);
  vec3 fm = vec3(mr, mg, mb) * ss(0.0, 0.06, fl);
  col = mix(col, WARM, fm);
  col += WARM * fm * (1.0 - fm) * 0.6; // glowing leading front

  // fine animated grain — alive through the whiteout
  float g = hash12(frag + vec2(fract(u_time * 17.0) * 113.0, fract(u_time * 11.0) * 89.0));
  col += (g - 0.5) * 0.045 * (1.0 - 0.45 * mg);

  gl_FragColor = vec4(col, 1.0);
}
`

/* ------------------------------------------------------------------------ *
 * Wordmark texture: R = crisp glyphs, G = pre-blurred glow (single texture)
 * ------------------------------------------------------------------------ */

/** White-on-transparent KAHUNA — evenly tracked, centered as a whole, Geist 600. */
function drawGlyphCanvas(): HTMLCanvasElement | null {
  const cv = document.createElement("canvas")
  cv.width = TEX_W
  cv.height = TEX_H
  const ctx = cv.getContext("2d")
  if (!ctx) return null
  ctx.fillStyle = "#fff"
  ctx.textBaseline = "middle"
  ctx.textAlign = "left"

  const word = "KAHUNA"
  const trackingEm = 0.34
  const maxWidth = TEX_W - 280
  const gaps = word.length - 1
  const y = TEX_H * 0.5
  // Prefer native letter-spacing: one fillText run keeps the engine's own
  // advances (kerning/variable-font safe — glyphs can never collide). Fall
  // back to manual per-glyph advances where the property is unsupported.
  const etx = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  const native = typeof etx.letterSpacing === "string"

  let fontPx = 168
  for (let pass = 0; pass < 2; pass++) {
    ctx.font = `600 ${fontPx}px "Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif`
    const track = trackingEm * fontPx
    let inkW: number
    if (native) {
      etx.letterSpacing = "0px"
      const plain = ctx.measureText(word).width
      etx.letterSpacing = `${track}px`
      const spaced = ctx.measureText(word).width
      // Engines may count a trailing gap after the last glyph — keep it out of the ink width.
      const trailing = Math.min(Math.max(spaced - plain - gaps * track, 0), track)
      inkW = spaced - trailing
    } else {
      inkW = word.split("").reduce((acc, ch) => acc + ctx.measureText(ch).width, 0) + gaps * track
    }
    if (inkW <= maxWidth || pass === 1) {
      let x = (TEX_W - inkW) / 2
      if (native) {
        ctx.fillText(word, x, y)
      } else {
        for (const ch of word) {
          ctx.fillText(ch, x, y)
          x += ctx.measureText(ch).width + track
        }
      }
      break
    }
    fontPx = Math.floor(fontPx * (maxWidth / inkW))
  }
  return cv
}

/** Cheap gaussian-ish blur: downsample 3× with bilinear, then upsample back. */
function blurCanvas(src: HTMLCanvasElement): HTMLCanvasElement | null {
  let cur: HTMLCanvasElement = src
  const sizes = [0.5, 0.25, 0.125, 0.25, 1]
  for (const s of sizes) {
    const next = document.createElement("canvas")
    next.width = Math.max(1, Math.round(TEX_W * s))
    next.height = Math.max(1, Math.round(TEX_H * s))
    const ctx = next.getContext("2d")
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(cur, 0, 0, next.width, next.height)
    cur = next
  }
  return cur
}

/** Tints a white-on-transparent canvas into a single solid color. */
function tintCanvas(src: HTMLCanvasElement, color: string): HTMLCanvasElement | null {
  const cv = document.createElement("canvas")
  cv.width = src.width
  cv.height = src.height
  const ctx = cv.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(src, 0, 0)
  ctx.globalCompositeOperation = "source-in"
  ctx.fillStyle = color
  ctx.fillRect(0, 0, cv.width, cv.height)
  return cv
}

/** Channel-packed wordmark: R = crisp, G = glow, on opaque black. */
function buildWordmarkCanvas(): HTMLCanvasElement | null {
  const glyphs = drawGlyphCanvas()
  if (!glyphs) return null
  const glow = blurCanvas(glyphs)
  const crisp = tintCanvas(glyphs, "#ff0000")
  const glowG = glow ? tintCanvas(glow, "#00ff00") : null
  const out = document.createElement("canvas")
  out.width = TEX_W
  out.height = TEX_H
  const ctx = out.getContext("2d")
  if (!ctx || !crisp) return null
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, TEX_W, TEX_H)
  ctx.globalCompositeOperation = "lighter"
  ctx.drawImage(crisp, 0, 0)
  if (glowG) ctx.drawImage(glowG, 0, 0, TEX_W, TEX_H)
  return out
}

/* ------------------------------------------------------------------------ *
 * GL boilerplate
 * ------------------------------------------------------------------------ */

function compileShader(gl: GL, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("[MonolithIntro] shader compile failed:", gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function createProgram(gl: GL): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  if (!prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[MonolithIntro] program link failed:", gl.getProgramInfoLog(prog))
    gl.deleteProgram(prog)
    return null
  }
  return prog
}

/* ------------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------------ */

export function MonolithIntro({ onDone }: IntroProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sweepRef = useRef<HTMLDivElement>(null)
  const wordRef = useRef<HTMLDivElement>(null)
  const floodRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const sweepEl = sweepRef.current
    const wordEl = wordRef.current
    const floodEl = floodRef.current
    const hintEl = hintRef.current
    if (!root || !canvas || !sweepEl || !wordEl || !floodEl || !hintEl) return

    let disposed = false
    let raf = 0
    let skipAt: number | null = null
    let skipFrom = 1
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let mode: "gl" | "css" | "reduced" = reduced ? "reduced" : "gl"

    // GL state — created inside the effect so a StrictMode restart is clean.
    let gl: GL | null = null
    let prog: WebGLProgram | null = null
    let vbo: WebGLBuffer | null = null
    let tex: WebGLTexture | null = null
    let uni: Uniforms | null = null

    const t0 = performance.now()
    const now = () => (performance.now() - t0) / 1000

    const finish = () => {
      if (doneRef.current) return
      doneRef.current = true
      onDoneRef.current()
    }

    const releaseGL = () => {
      if (!gl) return
      if (tex) gl.deleteTexture(tex)
      if (vbo) gl.deleteBuffer(vbo)
      if (prog) gl.deleteProgram(prog)
      tex = null
      vbo = null
      prog = null
      uni = null
      gl = null
    }

    const startFallback = (reason: string) => {
      if (disposed || mode !== "gl") return
      console.warn(`[MonolithIntro] ${reason} — switching to CSS fallback`)
      releaseGL()
      canvas.style.display = "none"
      mode = "css"
    }

    const onContextLost = (e: Event) => {
      e.preventDefault()
      startFallback("WebGL context lost")
    }

    const sizeCanvas = () => {
      if (mode !== "gl" || !gl) return
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const w = Math.max(1, Math.round(window.innerWidth * dpr))
      const h = Math.max(1, Math.round(window.innerHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
    }

    const uploadWordmark = () => {
      if (!gl || !tex) return
      const packed = buildWordmarkCanvas()
      if (!packed) return
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, packed)
    }

    const initGL = (): boolean => {
      try {
        gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
      } catch {
        gl = null
      }
      if (!gl) return false
      prog = createProgram(gl)
      if (!prog) {
        releaseGL()
        return false
      }
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
      gl.useProgram(prog)

      vbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const posLoc = gl.getAttribLocation(prog, "a_pos")
      gl.enableVertexAttribArray(posLoc)
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

      tex = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      // NPOT-safe for webgl1: LINEAR, CLAMP_TO_EDGE, no mipmaps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      uploadWordmark()

      const locs = {} as Uniforms
      for (const name of UNIFORM_NAMES) {
        locs[name] = gl.getUniformLocation(prog, `u_${name}`)
      }
      uni = locs
      gl.uniform1i(uni.tex, 0)
      sizeCanvas()

      // Geist may not be ready on a cold start — re-rasterise once it lands.
      if (document.fonts && !document.fonts.check(FONT_SPEC)) {
        document.fonts
          .load(FONT_SPEC)
          .then(() => {
            if (!disposed && mode === "gl") uploadWordmark()
          })
          .catch(() => {})
      }
      return true
    }

    const renderGL = (t: number) => {
      if (!gl || !prog || !uni) return
      const aim = beamAim(t)
      const a1 = Math.atan2(aim + 0.78, 1.32) + 0.006 * Math.sin(t * 2.3)
      const aim2 = lerp(0.9, 0.0, easeInOutSine(ramp(t, 0, TL.lockEnd)))
      const a2 = Math.atan2(aim2 - 0.82, 1.28)
      const lock = easeInCubic(ramp(t, TL.lockStart, TL.lockEnd))
      const flood = ramp(t, TL.lockEnd, TL.floodEnd) ** 1.7
      // Arrival accent: a brief specular ping as the beam pins the slab, before the swell.
      const settlePulse = Math.exp(-(((t - (TL.lockSettle + 0.03)) / 0.09) ** 2))
      const i1 =
        0.92 * easeOutQuad(ramp(t, TL.beamsIn, TL.beamsInDone)) + 1.55 * lock + 0.4 * settlePulse
      const i2 = 0.34 * easeOutQuad(ramp(t, 0.35, 1.0)) * (1 - 0.5 * lock)
      const yaw =
        degToRad(lerp(-6.5, -1.1, easeInOutSine(ramp(t, 0, TL.lockEnd)))) +
        degToRad(0.4) * Math.sin(t * 0.8)
      const zoom = lerp(1.05, 0.985, ramp(t, 0, TL.floodEnd))

      gl.uniform2f(uni.res, canvas.width, canvas.height)
      gl.uniform1f(uni.time, t)
      gl.uniform1f(uni.a1, a1)
      gl.uniform1f(uni.i1, i1)
      gl.uniform1f(uni.a2, a2)
      gl.uniform1f(uni.i2, i2)
      gl.uniform1f(uni.lock, lock)
      gl.uniform1f(uni.flood, flood)
      gl.uniform1f(uni.yaw, yaw)
      gl.uniform1f(uni.zoom, zoom)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const frame = () => {
      if (disposed) return
      const t = now()

      // Overlay opacity + completion — every path funnels through finish().
      let alive = true
      if (skipAt !== null) {
        const k = ramp(t, skipAt, skipAt + TL.skipFade)
        root.style.opacity = String(skipFrom * (1 - easeOutQuad(k)))
        if (k >= 1) alive = false
      } else if (mode === "reduced") {
        root.style.opacity = String(1 - easeInOutCubic(ramp(t, TL.reducedHold, TL.reducedEnd)))
        if (t >= TL.reducedEnd) alive = false
      } else {
        root.style.opacity = String(1 - easeInOutCubic(ramp(t, TL.floodEnd, TL.release)))
        if (t >= TL.release) alive = false
      }
      if (!alive) {
        finish()
        return
      }

      if (mode === "reduced") {
        wordEl.style.opacity = String(easeOutQuad(ramp(t, 0.05, TL.reducedIn)))
      } else {
        const hintK =
          easeInOutSine(ramp(t, TL.hintIn, TL.hintInDone)) *
          (1 - easeInOutSine(ramp(t, TL.hintOut, TL.hintOutDone)))
        hintEl.style.opacity = String(hintK)
        if (mode === "gl") {
          renderGL(t)
        } else {
          sweepEl.style.opacity = String(0.9 * easeOutQuad(ramp(t, TL.beamsIn, TL.beamsInDone)))
          const wk = easeInOutCubic(ramp(t, 1.5, 2.8))
          wordEl.style.opacity = String(wk)
          wordEl.style.transform = `scale(${0.975 + 0.025 * wk})`
          floodEl.style.opacity = String(ramp(t, TL.lockEnd, TL.floodEnd) ** 1.6)
        }
      }
      raf = requestAnimationFrame(frame)
    }

    const beginSkip = () => {
      if (doneRef.current || skipAt !== null) return
      const cur = Number.parseFloat(root.style.opacity)
      skipFrom = Number.isFinite(cur) ? cur : 1
      skipAt = now()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") beginSkip()
    }

    if (mode === "gl" && !initGL()) startFallback("WebGL unavailable")
    canvas.addEventListener("webglcontextlost", onContextLost)
    window.addEventListener("resize", sizeCanvas)
    window.addEventListener("keydown", onKeyDown)
    root.addEventListener("pointerdown", beginSkip)
    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener("webglcontextlost", onContextLost)
      window.removeEventListener("resize", sizeCanvas)
      window.removeEventListener("keydown", onKeyDown)
      root.removeEventListener("pointerdown", beginSkip)
      releaseGL()
    }
  }, [])

  return (
    <div ref={rootRef} className="fixed inset-0 z-[100] overflow-hidden bg-black">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* CSS fallback: diagonal light sweep (only driven when WebGL is unavailable) */}
      <div
        ref={sweepRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ opacity: 0 }}
      >
        <div
          className="absolute"
          style={{
            inset: "-50%",
            background:
              "linear-gradient(112deg, transparent 36%, rgba(255,250,240,0.05) 45%, rgba(255,250,240,0.14) 50%, rgba(255,250,240,0.05) 55%, transparent 64%)",
            animation: "km-monolith-sweep 2.5s ease-in-out infinite",
          }}
        />
      </div>

      {/* Wordmark — used by the CSS fallback and the reduced-motion variant */}
      <div
        ref={wordRef}
        className="pointer-events-none absolute inset-0 grid place-items-center"
        style={{ opacity: 0 }}
      >
        <span
          className="font-semibold text-[clamp(1.4rem,4.5vw,2.6rem)] text-white/90 tracking-[0.42em]"
          style={{
            paddingLeft: "0.42em",
            textShadow: "0 0 28px rgba(255,250,238,0.4), 0 0 90px rgba(255,250,238,0.18)",
          }}
        >
          KAHUNA
        </span>
      </div>

      {/* CSS-fallback whiteout */}
      <div
        ref={floodRef}
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: 0,
          background:
            "radial-gradient(ellipse 90% 75% at 50% 48%, #fffbf4 0%, rgba(255,251,244,0.95) 55%, rgba(252,250,246,0.9) 100%)",
        }}
      />

      <div
        ref={hintRef}
        className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-white/40 text-xs"
        style={{ opacity: 0 }}
      >
        Click or press Esc to skip
      </div>

      <style>{`@keyframes km-monolith-sweep{0%{transform:translateX(-46%)}55%{transform:translateX(46%)}100%{transform:translateX(-46%)}}`}</style>
    </div>
  )
}
