/* Headless-Chrome CDP driver: verifies the Kingsmaker /intro-lab page.
 * Launches an isolated headless Chrome (temp profile), signs up a throwaway
 * account, plays each intro, captures timed screenshots + console output. */
import { spawn } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASE = "http://localhost:5100"
const OUT = "/Users/Kalle/dev/projects/kingsmaker/screenshots/intro-lab"
const PROFILE = `/tmp/intro-lab-profile-${process.pid}`

mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- sanity: vite up? ----------
try {
  const r = await fetch(BASE + "/")
  if (!r.ok) throw new Error(`status ${r.status}`)
} catch (e) {
  console.error("FATAL: vite not reachable on 5100:", e)
  process.exit(1)
}

// ---------- launch chrome ----------
const proc = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--hide-scrollbars",
    "--enable-unsafe-swiftshader",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
)

const wsUrl: string = await new Promise((resolve, reject) => {
  let buf = ""
  const t = setTimeout(() => reject(new Error("chrome ws url timeout; stderr: " + buf)), 15000)
  proc.stderr.on("data", (d: Buffer) => {
    buf += d.toString()
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m) {
      clearTimeout(t)
      resolve(m[1])
    }
  })
})
console.log("chrome up:", wsUrl)

// ---------- minimal CDP client ----------
let idSeq = 0
const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>()
type ConsoleMsg = { type: string; text: string }
let consoleBuf: ConsoleMsg[] = []

const ws = new WebSocket(wsUrl)
await new Promise<void>((res, rej) => {
  ws.onopen = () => res()
  ws.onerror = (e) => rej(e)
})

// Chrome can crash mid-run — without this every in-flight CDP call hangs forever.
ws.onclose = () => {
  for (const p of pending.values()) p.rej(new Error("browser websocket closed (chrome died?)"))
  pending.clear()
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!
    pending.delete(msg.id)
    if (msg.error) p.rej(new Error(`${msg.error.message} ${msg.error.data ?? ""}`))
    else p.res(msg.result)
    return
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args as any[])
      .map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview) : a.type))
      .join(" ")
    consoleBuf.push({ type: msg.params.type, text: String(text).slice(0, 500) })
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails
    consoleBuf.push({
      type: "exception",
      text: `${d.text ?? ""} ${d.exception?.description ?? ""}`.slice(0, 800),
    })
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry
    consoleBuf.push({ type: e.level, text: `[${e.source}] ${e.text}`.slice(0, 500) })
  }
}

function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  const id = ++idSeq
  ws.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}

// ---------- page session ----------
const { targetId } = await send("Target.createTarget", { url: "about:blank" })
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
await send("Page.enable", {}, sessionId)
await send("Runtime.enable", {}, sessionId)
await send("Log.enable", {}, sessionId)
// Headless new defaults to prefers-reduced-motion: reduce, which would make
// every intro take its short static fallback — emulate a normal client.
await send(
  "Emulation.setEmulatedMedia",
  { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] },
  sessionId,
)

async function evaljs(expression: string): Promise<any> {
  const r = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (r.exceptionDetails)
    throw new Error(
      `eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`,
    )
  return r.result.value
}

async function shot(name: string) {
  const r = await send("Page.captureScreenshot", { format: "png" }, sessionId)
  await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"))
  console.log("  shot:", name)
}

async function until(label: string, ms: number, fn: () => Promise<boolean>) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return
    await sleep(250)
  }
  throw new Error("timeout waiting for: " + label)
}

function drainConsole(label: string) {
  const msgs = consoleBuf
  consoleBuf = []
  const bad = msgs.filter((m) => ["error", "exception", "warning", "warn"].includes(m.type))
  console.log(`  console[${label}]: ${msgs.length} msgs, ${bad.length} errors/warnings`)
  for (const m of msgs) console.log(`    ${bad.includes(m) ? "!" : "·"} ${m.type}: ${m.text}`)
  return bad
}

// ---------- flow ----------
console.log("step: open /intro-lab (expect auth page)")
await send("Page.navigate", { url: `${BASE}/intro-lab` }, sessionId)
try {
  await until("auth page", 60000, () =>
    evaljs(`document.body.innerText.includes("Sign in to your org")`),
  )
} catch (e) {
  const state = await evaljs(
    `document.readyState + " | " + location.href + " | " + document.body.innerText.slice(0, 400)`,
  ).catch((err) => `evaljs failed: ${err}`)
  console.error("DEBUG page state:", state)
  await shot("ZZ-debug-authpage")
  drainConsole("boot-failed")
  throw e
}
drainConsole("boot")

console.log("step: sign up throwaway account")
await evaljs(
  `[...document.querySelectorAll("button")].find(b => b.textContent.includes("Need an account"))?.click(), true`,
)
await until("signup form", 5000, () =>
  evaljs(`document.body.innerText.includes("Organization name")`),
)
const email = `intro-lab-${Date.now()}@example.com`
await evaljs(`
  const set = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
    s.call(el, v)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const ins = [...document.querySelectorAll("form input")]
  set(ins[0], "Intro Lab")
  set(ins[1], ${JSON.stringify(email)})
  set(ins[2], "introlab-pass-123")
  set(ins[3], "IntroLab Org")
  document.querySelector('form button[type="submit"]').click()
  true
`)
await until("app shell after signup", 25000, () =>
  evaljs(`document.body.innerText.includes("Intro Lab") && !!document.querySelector("nav, aside, [class*=sidebar]")`),
).catch(async () => {
  // fall back: maybe just the lab heading without sidebar selector
  await until("lab heading", 10000, () =>
    evaljs(`document.body.innerText.includes("Try out the candidate app intros")`),
  )
})
console.log("signed up as", email)
const rm = await evaljs(`matchMedia("(prefers-reduced-motion: reduce)").matches`)
console.log("prefers-reduced-motion reduce:", rm)
await shot("00-lab-page")
drainConsole("signup")

// intro card order matches INTROS in IntroLab.tsx
const ALL_PLAYS: { key: string; total: number; at: number[] }[] = [
  { key: "coronation", total: 3320, at: [700, 1500, 2300, 3000] },
  { key: "genesis", total: 3260, at: [600, 1500, 2100, 2700] },
  { key: "monolith", total: 4300, at: [800, 2000, 3000, 3700] },
  { key: "odyssey", total: 4620, at: [600, 1500, 2600, 3500, 4200] },
]
// ONLY=key1,key2 limits which intros play; SHOTS=ms,ms overrides shot times;
// when ONLY is set the chain + esc-skip extras are skipped.
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean)
const SHOTS = (process.env.SHOTS ?? "").split(",").filter(Boolean).map(Number)
const PLAYS = ALL_PLAYS.filter((p) => ONLY.length === 0 || ONLY.includes(p.key)).map((p) =>
  SHOTS.length ? { ...p, at: SHOTS } : p,
)

const overlayGone = () =>
  evaljs(
    `document.querySelectorAll("canvas").length === 0 && !document.querySelector("div.fixed.inset-0")`,
  )

// The other dev session edits this repo live — vite may full-reload the page
// mid-run. Always re-establish lab readiness before driving buttons.
async function clickPlay(i: number, label: string) {
  await until(`lab ready before ${label}`, 30000, () =>
    evaljs(
      `[...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Play").length === 4`,
    ),
  )
  // In-page probe: timestamps overlay mount/unmount, counts rAF callbacks.
  await evaljs(`
    if (!window.__probe) {
      window.__probe = { rafs: 0, events: [], t0: performance.now() }
      const raf = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb) => { window.__probe.rafs++; return raf(cb) }
      new MutationObserver(() => {
        const has = !!document.querySelector("div.fixed.inset-0")
        const last = window.__probe.events.at(-1)
        if (!last || last.overlay !== has)
          window.__probe.events.push({ at: Math.round(performance.now() - window.__probe.t0), overlay: has, rafs: window.__probe.rafs })
      }).observe(document.body, { childList: true, subtree: true })
    }
    window.__probe.events.push({ at: Math.round(performance.now() - window.__probe.t0), mark: "click:${label}", rafs: window.__probe.rafs })
    true
  `)
  await evaljs(
    `[...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Play")[${i}].click(), true`,
  )
  await until(`${label} overlay visible`, 3000, () =>
    evaljs(`!!document.querySelector("div.fixed.inset-0")`),
  )
}

const report: Record<string, ConsoleMsg[]> = {}

for (let i = 0; i < PLAYS.length; i++) {
  const p = PLAYS[i]
  const cardIdx = ALL_PLAYS.findIndex((x) => x.key === p.key)
  // A vite full-reload mid-play (other dev session saving) kills the run and
  // poisons the frames — detect via the in-page probe and retry the play.
  let clean = false
  for (let attempt = 1; attempt <= 4 && !clean; attempt++) {
    console.log(`step: play ${p.key} (attempt ${attempt})`)
    consoleBuf = []
    await clickPlay(cardIdx, p.key)
    const t0 = Date.now()
    for (let s = 0; s < p.at.length; s++) {
      const wait = p.at[s] - (Date.now() - t0)
      if (wait > 0) await sleep(wait)
      await shot(`${String(i + 1).padStart(2, "0")}-${p.key}-${p.at[s]}ms`)
    }
    const remaining = p.total + 1500 - (Date.now() - t0)
    if (remaining > 0) await sleep(remaining)
    await until(`${p.key} overlay gone`, 8000, overlayGone)
    const probe = await evaljs(
      `window.__probe ? JSON.stringify(window.__probe.events.filter(e => !e.mark || e.mark.includes("${p.key}"))) : "GONE"`,
    )
    clean = probe !== "GONE"
    console.log(`  ${p.key}: ${clean ? `clean play; probe: ${probe}` : "page reloaded mid-play — retrying"}`)
  }
  if (!clean) console.log(`  ${p.key}: WARNING — no clean play in 4 attempts, frames untrusted`)
  report[p.key] = drainConsole(p.key)
}

// ---------- chain: odyssey -> coronation ----------
if (ONLY.length) {
  console.log("\n==== SUMMARY (subset run) ====")
  for (const [k, v] of Object.entries(report))
    console.log(`${k}: ${v.length === 0 ? "clean" : `${v.length} errors/warnings`}`)
  proc.kill()
  rmSync(PROFILE, { recursive: true, force: true })
  process.exit(0)
}
console.log("step: chain odyssey -> coronation")
consoleBuf = []
await until("lab ready before chain", 30000, () =>
  evaljs(
    `[...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Play").length === 4`,
  ),
)
await evaljs(
  `[...document.querySelectorAll("button")].filter(b => ["Nothing","Coronation","Genesis","Monolith"].includes(b.textContent.trim()))[1].click(), true`,
)
await clickPlay(3, "chain")
const t0 = Date.now()
for (const at of [4500, 4800, 5600, 6800]) {
  const wait = at - (Date.now() - t0)
  if (wait > 0) await sleep(wait)
  await shot(`05-chain-${at}ms`)
}
await sleep(2500)
await until("chain overlay gone", 10000, overlayGone)
report.chain = drainConsole("chain")

// esc-skip smoke test
console.log("step: esc-skip test on monolith")
consoleBuf = []
await clickPlay(2, "esc-skip")
await sleep(1000)
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId)
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId)
await until("skip overlay gone", 5000, overlayGone)
console.log("  esc skip: ok")
report.skip = drainConsole("esc-skip")

// ---------- summary ----------
console.log("\n==== SUMMARY ====")
let anyBad = false
for (const [k, v] of Object.entries(report)) {
  if (v.length) anyBad = true
  console.log(`${k}: ${v.length === 0 ? "clean" : `${v.length} errors/warnings (above)`}`)
}
console.log(anyBad ? "RESULT: issues found" : "RESULT: all clean")

proc.kill()
rmSync(PROFILE, { recursive: true, force: true })
process.exit(anyBad ? 2 : 0)
