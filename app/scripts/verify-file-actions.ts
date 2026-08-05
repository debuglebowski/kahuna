/* Do the Files widget's rows actually offer archive + delete, and does the
 * archived round-trip work from there?
 *
 * The widget passed no `canMutate`, so every row silently defaulted to
 * download-only — invisible in any test that just checked "the file is listed".
 * This drives the real buttons on the real surface and screenshots the result.
 *
 * BASE/API default to the throwaway stack. SHOT=<path> saves a screenshot. */
import { spawn } from "node:child_process"
import { rmSync, unlinkSync, writeFileSync } from "node:fs"
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"
import { newWidget } from "../src/lib/dashboards"
import { provisionVerifyIdentity } from "./verify-session"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASE = process.env.BASE ?? "http://localhost:5199"
const API = process.env.API ?? "http://localhost:3199"
const SHOT = process.env.SHOT
const PROFILE = `/tmp/file-actions-profile-${process.pid}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failures++
}

try {
  const r = await fetch(`${BASE}/`)
  if (!r.ok) throw new Error(`status ${r.status}`)
} catch (e) {
  console.error(`FATAL: no dev server on ${BASE}:`, e)
  process.exit(1)
}

const proc = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1600,1000",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
)
const wsUrl: string = await new Promise((resolve, reject) => {
  let buf = ""
  const t = setTimeout(() => reject(new Error(`chrome ws url timeout; stderr: ${buf}`)), 15000)
  proc.stderr.on("data", (d: Buffer) => {
    buf += d.toString()
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m?.[1]) {
      clearTimeout(t)
      resolve(m[1])
    }
  })
})

let idSeq = 0
// biome-ignore lint/suspicious/noExplicitAny: raw CDP envelopes
const pending = new Map<number, { res: (v: any) => void; rej: (e: unknown) => void }>()
const ws = new WebSocket(wsUrl)
await new Promise<void>((res, rej) => {
  ws.onopen = () => res()
  ws.onerror = (e) => rej(e)
})
ws.onclose = () => {
  for (const p of pending.values()) p.rej(new Error("browser websocket closed"))
  pending.clear()
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p?.rej(new Error(`${msg.error.message} ${msg.error.data ?? ""}`))
    else p?.res(msg.result)
  }
}
// biome-ignore lint/suspicious/noExplicitAny: raw CDP envelopes
function send(method: string, params: any = {}, sid?: string): Promise<any> {
  const id = ++idSeq
  ws.send(JSON.stringify({ id, method, params, sessionId: sid }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" })
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
await send("Page.enable", {}, sessionId)
await send("Runtime.enable", {}, sessionId)
await send("Network.enable", {}, sessionId)

// biome-ignore lint/suspicious/noExplicitAny: eval returns arbitrary JSON
async function evaljs(expression: string): Promise<any> {
  const r = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text}`)
  return r.result.value
}
const text = () => evaljs("document.body.innerText") as Promise<string>
async function until(label: string, ms: number, fn: () => Promise<boolean>) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`timeout: ${label}\n${(await text().catch(() => "")).slice(0, 800)}`)
}
const POINTER = `(el) => {
  const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, pointerType: "mouse" }
  el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new MouseEvent("mousedown", o))
  el.dispatchEvent(new PointerEvent("pointerup", o)); el.dispatchEvent(new MouseEvent("mouseup", o))
  el.click()
}`
const clickText = (needle: string, sel = "button, [role=option], a, [role=menuitem]") =>
  evaljs(`(() => {
    const press = ${POINTER}
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => (e.textContent ?? "").trim().includes(${JSON.stringify(needle)}))
    if (!el) return false
    press(el); return true
  })()`) as Promise<boolean>
/** Click by aria-label — how the row actions identify themselves. */
const clickLabel = (label: string) =>
  evaljs(`(() => {
    const press = ${POINTER}
    const el = document.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!el) return false
    press(el); return true
  })()`) as Promise<boolean>
/** Click a row action on the row for a NAMED file. The labels ("Archive file")
 *  repeat per row, so a bare querySelector hits whichever row is first — with more
 *  than one file that silently acts on the wrong one. */
const clickRowAction = (filename: string, label: string) =>
  evaljs(`(() => {
    const press = ${POINTER}
    const row = [...document.querySelectorAll("div")].find(
      (d) => d.querySelector('[aria-label=${JSON.stringify(label)}]') &&
             (d.textContent ?? "").includes(${JSON.stringify(filename)}) &&
             // innermost such row: no descendant also qualifies
             ![...d.querySelectorAll("div")].some(
               (c) => c.querySelector('[aria-label=${JSON.stringify(label)}]') &&
                      (c.textContent ?? "").includes(${JSON.stringify(filename)}),
             ),
    )
    const el = row?.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!el) return false
    press(el); return true
  })()`) as Promise<boolean>
const hasLabel = (label: string) =>
  evaljs(`!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`) as Promise<boolean>

// ── sign in (account + org provisioned out of band: sign-up is closed) ──
console.log("step: sign in")
const identity = await provisionVerifyIdentity("file-actions")
await send("Page.navigate", { url: `${BASE}/` }, sessionId)
await until("auth page", 60000, async () => (await text()).includes("Sign in to your org"))
await evaljs(`(() => {
  const set = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
    s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const ins = [...document.querySelectorAll("form input")]
  set(ins[0], ${JSON.stringify(identity.email)}); set(ins[1], ${JSON.stringify(identity.password)})
  document.querySelector('form button[type="submit"]').click()
  return true
})()`)
await until("app shell", 60000, async () => !(await text()).includes("Sign in to your org"))
await until("active org", 40000, async () =>
  Boolean(
    JSON.parse((await evaljs(`fetch("/api/auth/get-session").then((r) => r.text())`)) || "null")
      ?.session?.activeOrganizationId,
  ),
)

// ── a record dashboard with a Files widget, and a record to open ──
const { cookies } = await send("Network.getCookies", { urls: [BASE] }, sessionId)
const cookie = (cookies as { name: string; value: string }[])
  .map((c) => `${c.name}=${c.value}`)
  .join("; ")
const CookieFetch = Layer.succeed(FetchHttpClient.Fetch, ((
  input: RequestInfo | URL,
  init?: RequestInit,
) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), cookie } })) as typeof fetch)
const makeClient = RpcClient.make(KingsmakerRpcs)
type Client = Effect.Effect.Success<typeof makeClient>
class ApiClient extends Context.Tag("verify-file-actions/ApiClient")<ApiClient, Client>() {}
const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({ url: `${API}/api/rpc` }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(CookieFetch),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ),
  ),
)
const call = <T>(f: (c: Client) => Effect.Effect<unknown, unknown, never>): Promise<T> =>
  runtime.runPromise(Effect.flatMap(ApiClient, f) as Effect.Effect<T, unknown, never>)

console.log("step: build a record view with a Files widget")
const concepts = await call<ReadonlyArray<{ id: string; name: string }>>((c) => c.listConcepts({}))
const concept = concepts[0]
if (!concept) {
  console.log("FATAL: org seeded no concepts")
  process.exit(1)
}
const record = await call<{ id: string }>((c) =>
  c.createRecord({ conceptId: concept.id, fields: {} }),
)
const dim = { unit: "fr" as const, value: 1, min: 6 }
await call<{ id: string }>((c) =>
  c.createDashboard({
    name: `File Actions ${concept.name}`,
    scope: "org",
    kind: "record",
    conceptId: concept.id,
    body: { direction: "col", children: [{ ...newWidget("files", true), w: dim, h: dim }] },
    // biome-ignore lint/suspicious/noExplicitAny: body is the wire union
  } as any),
)

// ── upload a file, then exercise the row actions ──
console.log("step: upload a file into the widget")
await send("Page.navigate", { url: `${BASE}/records/${record.id}` }, sessionId)
await until("drop zone", 30000, async () =>
  (await text()).includes("Drop files or click to upload"),
)
const png = "/tmp/file-actions-shot.png"
writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))
// A VALID single-page PDF, not a "%PDF-1.4" stub. A stub can't be rendered, so the
// preview would show a broken-document icon and every "an embed element exists"
// assertion would still pass — which is exactly how a broken PDF preview shipped.
const PDF_B64 = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 40 Td (Hello PDF) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`,
).toString("base64")
await evaljs(`(async () => {
  const input = document.querySelector('input[type=file]')
  if (!input) return "no input"
  const bytes = Uint8Array.from(atob(${JSON.stringify(PDF_B64)}), (c) => c.charCodeAt(0))
  const file = new File([bytes], "report.pdf", { type: "application/pdf" })
  const dt = new DataTransfer(); dt.items.add(file)
  Object.defineProperty(input, "files", { value: dt.files, configurable: true })
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return "ok"
})()`)
await until("file listed", 20000, async () => (await text()).includes("report.pdf"))
ok("uploaded file is listed", (await text()).includes("report.pdf"))

console.log("step: row actions")
ok("row offers Download", await hasLabel("Download file"))
ok("row offers Archive", await hasLabel("Archive file"))
ok("row offers Delete", await hasLabel("Delete file"))
// Actions must be legible without hovering — hover-only is invisible on touch.
const opacity = await evaljs(`(() => {
  const a = document.querySelector('[aria-label="Archive file"]')
  if (!a) return null
  let el = a
  while (el && el !== document.body) {
    const o = getComputedStyle(el).opacity
    if (o !== "1") return o
    el = el.parentElement
  }
  return "1"
})()`)
ok("actions are visible without hover", opacity !== "0", `effective opacity=${opacity}`)

// ── inline preview ──
// A real 1×1 PNG, so the image branch renders actual bytes rather than a broken
// <img> that would still "pass" a naive presence check.
console.log("step: inline preview")
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
await evaljs(`(async () => {
  const input = document.querySelector('input[type=file]')
  if (!input) return "no input"
  const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), (c) => c.charCodeAt(0))
  const file = new File([bytes], "shot.png", { type: "image/png" })
  const dt = new DataTransfer(); dt.items.add(file)
  Object.defineProperty(input, "files", { value: dt.files, configurable: true })
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return "ok"
})()`)
await until("png listed", 20000, async () => (await text()).includes("shot.png"))
// Clicking the filename must open the modal, not navigate away.
const urlBefore = await evaljs("location.href")
await clickLabel("Preview shot.png")
await until("preview open", 10000, async () =>
  Boolean(await evaljs(`!!document.querySelector('[role=dialog]')`)),
).catch(() => {})
ok(
  "clicking a file opens an in-page preview",
  Boolean(await evaljs(`!!document.querySelector('[role=dialog]')`)),
)
ok("it doesn't navigate away", (await evaljs("location.href")) === urlBefore)
// A pane sized only by its content collapses to a sliver for a small image, which
// every "is the dialog open / did the img decode" check still calls a pass. Measure
// against the viewport: the frame is meant to be 90vw × 90vh, so anything much
// smaller means the sizing regressed — a fixed pixel floor would not notice.
const box = await evaljs(`(() => {
  const dialog = document.querySelector('[role=dialog]')
  const pane = document.querySelector('[role=dialog] img')?.parentElement
  if (!dialog || !pane) return null
  const d = dialog.getBoundingClientRect()
  const p = pane.getBoundingClientRect()
  return JSON.stringify({
    dialogW: Math.round((d.width / window.innerWidth) * 100),
    dialogH: Math.round((d.height / window.innerHeight) * 100),
    paneH: Math.round(p.height),
    vh: window.innerHeight,
  })
})()`)
const dims = box
  ? (JSON.parse(String(box)) as { dialogW: number; dialogH: number; paneH: number; vh: number })
  : null
ok(
  "the modal fills ~90% of the viewport",
  !!dims && dims.dialogW >= 85 && dims.dialogW <= 92 && dims.dialogH >= 85 && dims.dialogH <= 92,
  dims ? `${dims.dialogW}vw × ${dims.dialogH}vh` : "no dialog/pane",
)
ok(
  "the preview pane fills the frame (not collapsed)",
  !!dims && dims.paneH >= dims.vh * 0.6,
  dims ? `pane=${dims.paneH}px of ${dims.vh}px viewport` : "",
)
ok(
  "the image renders in the dialog (decoded, non-zero)",
  Boolean(
    await evaljs(`(() => {
      const img = document.querySelector('[role=dialog] img')
      return !!img && img.complete && img.naturalWidth > 0
    })()`),
  ),
)
ok(
  "preview offers Download and Open in new tab",
  (await text()).includes("Download") && (await text()).includes("Open in new tab"),
)
// They live in the TITLE ROW, left of the close button — a page-text check would
// pass wherever they sat, so compare geometry: above the preview pane, and left of
// the close button rather than overlapping it.
const placement = await evaljs(`(() => {
  const dialog = document.querySelector('[role=dialog]')
  if (!dialog) return null
  const dl = [...dialog.querySelectorAll('a')].find((a) => (a.textContent ?? "").includes("Download"))
  const close = dialog.querySelector('[data-slot=dialog-close]')
  const pane = dialog.querySelector('img, object, iframe')?.parentElement
  if (!dl || !close || !pane) return null
  const d = dl.getBoundingClientRect(), c = close.getBoundingClientRect(), p = pane.getBoundingClientRect()
  return JSON.stringify({
    abovePane: Math.round(d.bottom) <= Math.round(p.top) + 2,
    leftOfClose: Math.round(d.right) <= Math.round(c.left) + 2,
    sameRowAsClose: Math.abs((d.top + d.bottom) / 2 - (c.top + c.bottom) / 2) < 24,
  })
})()`)
const place = placement
  ? (JSON.parse(String(placement)) as {
      abovePane: boolean
      leftOfClose: boolean
      sameRowAsClose: boolean
    })
  : null
ok(
  "the actions sit in the header, left of the close button",
  !!place && place.abovePane && place.leftOfClose && place.sameRowAsClose,
  place ? JSON.stringify(place) : "couldn't measure",
)
if (SHOT) {
  const s = await send("Page.captureScreenshot", { format: "png" }, sessionId)
  writeFileSync(SHOT.replace(/\.png$/, "-preview.png"), Buffer.from(s.data, "base64"))
  console.log(`  screenshot → ${SHOT.replace(/\.png$/, "-preview.png")}`)
}
// Escape must close it — the modal is Radix-backed, so this also proves it's a
// real dialog and not a bare overlay.
await send(
  "Input.dispatchKeyEvent",
  { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  sessionId,
)
await send(
  "Input.dispatchKeyEvent",
  { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  sessionId,
)
await sleep(500)
ok("Escape closes the preview", !(await evaljs(`!!document.querySelector('[role=dialog]')`)))
// A PDF previews through <object> (a sandboxed iframe disables the PDF plugin and
// renders a broken-document icon instead — the frame still "exists", which is why
// element-presence assertions missed it).
await clickLabel("Preview report.pdf")
await until("pdf preview", 10000, async () =>
  Boolean(await evaljs(`!!document.querySelector('[role=dialog] object')`)),
).catch(() => {})
const pdfEl = await evaljs(`(() => {
  const dialog = document.querySelector('[role=dialog]')
  if (!dialog) return null
  const obj = dialog.querySelector('object')
  const sandboxedFrame = dialog.querySelector('iframe[sandbox=""]')
  const r = obj?.getBoundingClientRect()
  return JSON.stringify({
    hasObject: !!obj,
    // A regression back to the sandboxed-iframe approach has to fail loudly.
    sandboxedIframe: !!sandboxedFrame,
    w: r ? Math.round(r.width) : 0,
    h: r ? Math.round(r.height) : 0,
  })
})()`)
const pdf = pdfEl
  ? (JSON.parse(String(pdfEl)) as {
      hasObject: boolean
      sandboxedIframe: boolean
      w: number
      h: number
    })
  : null
ok("a PDF previews via <object>, not a sandboxed iframe", !!pdf?.hasObject && !pdf.sandboxedIframe)
ok("the PDF pane fills the frame", !!pdf && pdf.h >= 400, pdf ? `${pdf.w}×${pdf.h}` : "")
// Pixels, not elements. The plugin paints in its own compositing layer (invisible
// to canvas), so screenshot the pane and count distinct greys: Chrome's viewer draws
// a WHITE page on a DARK chrome, while a failed embed is one flat colour. This is
// the assertion that catches the sandbox bug — `<object>` merely existing did not.
// The plugin also needs a beat to paint; clipping immediately captures flat
// background and reads as a failure.
await sleep(2000)
const paneShot = await evaljs(`(() => {
  const o = document.querySelector('[role=dialog] object')
  if (!o) return null
  const r = o.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
})()`)
let rendered = false
if (paneShot) {
  const b = JSON.parse(String(paneShot)) as { x: number; y: number; w: number; h: number }
  const cap = await send(
    "Page.captureScreenshot",
    { format: "png", clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } },
    sessionId,
  )
  const png = Buffer.from(cap.data, "base64")
  if (SHOT) writeFileSync(SHOT.replace(/\.png$/, "-pdf.png"), png)
  // Decode enough to sample: re-render the PNG into a canvas in-page and measure the
  // spread of luminance. A rendered page pushes max near white.
  const stats = await evaljs(`(async () => {
    const img = new Image()
    img.src = "data:image/png;base64,${png.toString("base64")}"
    await img.decode()
    const c = document.createElement("canvas")
    c.width = img.width; c.height = img.height
    const g = c.getContext("2d")
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let min = 255, max = 0
    for (let i = 0; i < d.length; i += 4 * 97) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (l < min) min = l
      if (l > max) max = l
    }
    return JSON.stringify({ min: Math.round(min), max: Math.round(max) })
  })()`)
  const lum = JSON.parse(String(stats)) as { min: number; max: number }
  // A real render: dark viewer chrome (low min) + white page (high max).
  rendered = lum.max >= 200 && lum.max - lum.min >= 100
  ok(
    "the PDF actually renders (white page on dark viewer chrome)",
    rendered,
    `luminance min=${lum.min} max=${lum.max}`,
  )
}
await send(
  "Input.dispatchKeyEvent",
  { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  sessionId,
)
await send(
  "Input.dispatchKeyEvent",
  { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  sessionId,
)
await sleep(500)

if (SHOT) {
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId)
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"))
  console.log(`  screenshot → ${SHOT}`)
}

// Two files are listed by now, so every action below is aimed at report.pdf's own
// row — the labels repeat, and hitting the wrong row would still look like a pass.
console.log("step: archive → show archived → restore")
ok("archive targets the right row", await clickRowAction("report.pdf", "Archive file"))
await until("archived, row gone", 20000, async () => !(await text()).includes("report.pdf")).catch(
  () => {},
)
ok("archiving removes it from the default list", !(await text()).includes("report.pdf"))
ok("a “Show archived” affordance appears", (await text()).includes("Show 1 archived"))
await clickText("Show 1 archived", "button")
await until("archived row visible", 10000, async () => (await text()).includes("report.pdf")).catch(
  () => {},
)
ok("showing archived reveals it again", (await text()).includes("report.pdf"))
ok("archived row offers Restore", await hasLabel("Restore file"))
await clickRowAction("report.pdf", "Restore file")
await sleep(1200)
ok("restore clears the archived state", !(await text()).includes("Show 1 archived"))

console.log("step: delete asks first, then removes")
await clickRowAction("report.pdf", "Delete file")
await until("confirm", 10000, async () => (await text()).includes("can't be undone")).catch(
  () => {},
)
ok("delete prompts before destroying", (await text()).includes("can't be undone"))
await clickText("Delete", "button")
await until("row gone", 20000, async () => !(await text()).includes("report.pdf")).catch(() => {})
ok("confirmed delete removes the file", !(await text()).includes("report.pdf"))
// The other file must survive — a delete that took both would also satisfy the
// assertion above.
ok("the other file is untouched", (await text()).includes("shot.png"))

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
ws.close()
await new Promise<void>((resolve) => {
  const t = setTimeout(() => {
    proc.kill("SIGKILL")
    resolve()
  }, 5000)
  proc.once("exit", () => {
    clearTimeout(t)
    resolve()
  })
  proc.kill()
})
rmSync(PROFILE, { recursive: true, force: true })
try {
  unlinkSync(png)
} catch {}
process.exit(failures === 0 ? 0 : 1)
