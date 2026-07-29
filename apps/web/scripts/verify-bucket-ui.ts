/* Headless-Chrome CDP driver: verifies the Files widget's "This widget" scope
 * end-to-end through the real UI. Launches an isolated headless Chrome (temp
 * profile — the MCP browser profile may be in use), signs up a throwaway account,
 * builds a dashboard with a widget-scope Files widget, drops a PDF into it, then
 * checks org-scope visibility and the delete prompt.
 *
 * Points at whatever BASE says (default the throwaway stack on :5199, so the
 * slay-managed dev stack is left alone). Mirrors scripts/verify-intro-lab.ts. */
import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASE = process.env.BASE ?? "http://localhost:5199"
// The API behind that Vite proxy — the saved body is read back over the real RPC
// client (see below), which talks to the API directly.
const API = process.env.API ?? "http://localhost:3199"
const PROFILE = `/tmp/bucket-ui-profile-${process.pid}`

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
let consoleBuf: { type: string; text: string }[] = []

const ws = new WebSocket(wsUrl)
await new Promise<void>((res, rej) => {
  ws.onopen = () => res()
  ws.onerror = (e) => rej(e)
})
ws.onclose = () => {
  for (const p of pending.values()) p.rej(new Error("browser websocket closed (chrome died?)"))
  pending.clear()
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p?.rej(new Error(`${msg.error.message} ${msg.error.data ?? ""}`))
    else p?.res(msg.result)
    return
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args as { value?: unknown; description?: string; type?: string }[])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(" ")
    consoleBuf.push({ type: msg.params.type, text: String(text).slice(0, 400) })
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails
    consoleBuf.push({
      type: "exception",
      text: `${d.text ?? ""} ${d.exception?.description ?? ""}`.slice(0, 600),
    })
  }
}
// biome-ignore lint/suspicious/noExplicitAny: raw CDP envelopes
function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  const id = ++idSeq
  ws.send(JSON.stringify({ id, method, params, sessionId }))
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
  if (r.exceptionDetails)
    throw new Error(
      `eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`,
    )
  return r.result.value
}
const text = () => evaljs("document.body.innerText") as Promise<string>
async function until(label: string, ms: number, fn: () => Promise<boolean>) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return
    await sleep(250)
  }
  const body = await text().catch(() => "<unreadable>")
  throw new Error(`timeout waiting for: ${label}\n--- page text ---\n${body.slice(0, 1200)}`)
}
/** Radix opens menus/selects on pointerdown, so a bare .click() never opens them —
 *  fire the whole pointer sequence. */
const POINTER = `(el) => {
  const opts = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, pointerType: "mouse" }
  el.dispatchEvent(new PointerEvent("pointerdown", opts))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  el.dispatchEvent(new PointerEvent("pointerup", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.click()
}`
/** Click the first element whose text matches, within an optional selector. */
const clickText = (needle: string, sel = "button, [role=option], a, [role=menuitem]") =>
  evaljs(`(() => {
    const press = ${POINTER}
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => (e.textContent ?? "").trim().includes(${JSON.stringify(needle)}))
    if (!el) return false
    press(el)
    return true
  })()`) as Promise<boolean>
/** Real CDP mouse input at an element's centre. Radix Select items only commit on
 *  a genuine pointer sequence (synthetic events skip its pointer-capture guards),
 *  so anything inside an open Select must go through here. */
async function clickReal(needle: string, sel = "[role=option], button") {
  const box = await evaljs(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => (e.textContent ?? "").trim().includes(${JSON.stringify(needle)}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`)
  if (!box) return false
  const { x, y } = JSON.parse(box) as { x: number; y: number }
  const base = { x, y, button: "left", clickCount: 1, buttons: 1 }
  await send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 }, sessionId)
  await send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId)
  await send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId)
  return true
}
/** Move the real mouse onto a matched element. Field hints live in an `InfoHint`
 *  tooltip, so their text isn't in the DOM at all until the trigger is hovered —
 *  asserting the copy means hovering first. */
async function hoverReal(sel: string) {
  // The inspector scrolls, so the trigger may be outside the viewport — bring it
  // into view before measuring, or the coordinates point at nothing.
  const box = await evaljs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    el.scrollIntoView({ block: "center" })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`)
  if (!box) return false
  const { x, y } = JSON.parse(box) as { x: number; y: number }
  // Radix opens on a pointermove that *enters* the trigger, so approach from a
  // neighbouring point first — a single move to the target can arrive as the very
  // first pointer event and never reads as an enter.
  await send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: x - 40, y, buttons: 0 },
    sessionId,
  )
  await sleep(60)
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 }, sessionId)
  await sleep(60)
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y + 1, buttons: 0 }, sessionId)
  return true
}
const drain = (label: string) => {
  const msgs = consoleBuf
  consoleBuf = []
  const bad = msgs.filter((m) => ["error", "exception"].includes(m.type))
  for (const m of bad) console.log(`    ! ${label} ${m.type}: ${m.text}`)
  return bad
}

// ── sign up ──
console.log("step: sign up")
await send("Page.navigate", { url: `${BASE}/` }, sessionId)
await until("auth page", 60000, async () => (await text()).includes("Need an account"))
await clickText("Need an account")
await until("signup form", 8000, async () => (await text()).includes("Organization name"))
const email = `bucket-ui-${Date.now()}@example.com`
await evaljs(`(() => {
  const set = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
    s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const ins = [...document.querySelectorAll("form input")]
  set(ins[0], "Bucket UI"); set(ins[1], ${JSON.stringify(email)})
  set(ins[2], "bucket-pass-123"); set(ins[3], "Bucket Org")
  document.querySelector('form button[type="submit"]').click()
  return true
})()`)
await until("app shell", 40000, async () => !(await text()).includes("Organization name"))
// Sign-up creates the org and THEN sets it active; navigating in between yields a
// shell whose every query fails with "No active org".
await until("active org on the session", 40000, async () =>
  Boolean(
    JSON.parse((await evaljs(`fetch("/api/auth/get-session").then((r) => r.text())`)) || "null")
      ?.session?.activeOrganizationId,
  ),
)
drain("signup")

// ── build a dashboard with a widget-scope Files widget ──
console.log("step: create dashboard + Files widget")
await send("Page.navigate", { url: `${BASE}/settings/dashboards` }, sessionId)
// The sidebar says "Dashboards" before the list loads — wait for the toolbar's
// own control instead, or the click below lands on nothing.
const hasNew = `[...document.querySelectorAll("button")].some((e) => (e.textContent ?? "").trim().startsWith("New"))`
await until("dashboards settings loaded", 30000, () => evaljs(hasNew) as Promise<boolean>).catch(
  async (e) => {
    console.log("  page text:", (await text()).slice(0, 600).replace(/\n/g, " | "))
    console.log(
      "  session:",
      await evaljs(
        `fetch("/api/auth/get-session").then((r) => r.text()).then((t) => t.slice(0, 300))`,
      ),
    )
    throw e
  },
)
// "New" is a dropdown; the page-dashboard item lives inside it.
const openedNew = await evaljs(`(() => {
  const press = ${POINTER}
  const b = [...document.querySelectorAll("button")].find((e) => (e.textContent ?? "").trim().startsWith("New"))
  if (!b) return false
  press(b)
  return true
})()`)
ok("New-dashboard menu opened", openedNew)
await until("new menu", 8000, async () => (await text()).includes("Page dashboard"))
const created = await clickText("Page dashboard")
ok("create-dashboard control found", created)
// The editor opens on General; Layout is where widgets live.
await until("editor open", 20000, async () => (await text()).includes("Layout"))
await clickText("Layout", "button, [role=tab]")
await until("layout tab", 10000, async () => (await text()).includes("Add widget"))

// The gallery: search for "files" (proves the keyword fix) then pick it.
await clickText("Add widget")
// A placeholder isn't innerText — look for the search input itself.
await until(
  "widget gallery",
  10000,
  () =>
    evaljs(
      `[...document.querySelectorAll("input")].some((i) => (i.placeholder ?? "").includes("Search widgets"))`,
    ) as Promise<boolean>,
)
await evaljs(`(() => {
  const input = [...document.querySelectorAll("input")].find((i) => i.placeholder?.includes("Search widgets"))
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
  s.call(input, "pdf")
  input.dispatchEvent(new Event("input", { bubbles: true }))
  return true
})()`)
await sleep(400)
ok('searching "pdf" surfaces the Files widget', (await text()).includes("Files"))
ok(
  "gallery describes Files as uploadable (discoverability fix)",
  (await text()).includes("Upload files here"),
)
await clickText("Files", "button")
await until("files widget on canvas", 15000, async () => (await text()).includes("Scope"))
drain("add-widget")

// Scope select → "This widget". Radix Select: click the trigger, then the option.
console.log("step: set Scope = This widget")
const openedScope = await evaljs(`(() => {
  const press = ${POINTER}
  const rows = [...document.querySelectorAll("div")]
  const row = rows.find((d) => (d.textContent ?? "").trim().startsWith("Scope") && d.querySelector("[role=combobox]"))
  const trigger = row?.querySelector("[role=combobox]") ?? document.querySelector("[role=combobox]")
  if (!trigger) return false
  press(trigger)
  return true
})()`)
ok("Scope select opened", openedScope)
await until("scope options", 8000, async () => (await text()).includes("This widget"))
ok(
  "“This widget (its own files)” is offered",
  (await text()).includes("This widget (its own files)"),
)
ok("picked “This widget”", await clickReal("This widget (its own files)", "[role=option]"))
await until("widget scope applied", 10000, async () =>
  (await text()).includes("Also list elsewhere"),
).catch(async (e) => {
  console.log("  page text:", (await text()).slice(0, 900).replace(/\n/g, " | "))
  throw e
})
ok("sharing toggle appears on widget scope", (await text()).includes("Also list elsewhere"))
// `Field` renders its hint inside an `InfoHint` tooltip — nothing is in the DOM
// until the info icon is hovered, so hover it before reading the copy.
const hovered = await hoverReal('[aria-label="Also list elsewhere — more info"]')
ok("sharing hint's info icon is present", hovered)
await until("sharing tooltip open", 5000, async () =>
  ((await evaljs(`document.body.innerText`)) as string).includes("Only this widget lists them"),
).catch(() => {})
const hintText = (await evaljs(`document.body.innerText`)) as string
ok(
  "sharing hint says private hides listings, not access",
  hintText.includes("it doesn’t lock them") || hintText.includes("it doesn't lock them"),
  hintText.includes("Only this widget lists them") ? "" : "tooltip never opened",
)
// Close the tooltip so it can't sit over the Save button.
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 }, sessionId)

// Save, then confirm the body persisted the bucket by reading it back over RPC.
console.log("step: save")
const saved = await clickText("Save")
ok("save clicked", saved)
await sleep(2500)
drain("save")

// Read the saved body through the REAL Effect RPC client (the browser's own
// transport is ndjson with an internal envelope shape — hand-rolling it reads the
// wrong chunk). Borrow the browser's session cookie so it's the same account.
const { cookies } = await send("Network.getCookies", { urls: [BASE] }, sessionId)
const cookie = (cookies as { name: string; value: string }[])
  .map((c) => `${c.name}=${c.value}`)
  .join("; ")
const CookieFetch = Layer.succeed(FetchHttpClient.Fetch, ((
  input: RequestInfo | URL,
  init?: RequestInit,
) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), cookie } })) as typeof fetch)
const ProtocolLive = RpcClient.layerProtocolHttp({ url: `${API}/api/rpc` }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CookieFetch),
  Layer.provide(RpcSerialization.layerNdjson),
)
const makeClient = RpcClient.make(KingsmakerRpcs)
type Client = Effect.Effect.Success<typeof makeClient>
class ApiClient extends Context.Tag("verify-ui/ApiClient")<ApiClient, Client>() {}
const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)
const dashboards = (await runtime.runPromise(
  Effect.flatMap(ApiClient, (c) => c.listDashboards({})) as Effect.Effect<
    ReadonlyArray<{ id: string; body: unknown }>,
    unknown,
    never
  >,
)) as ReadonlyArray<{ id: string; body: unknown }>
// A body is either the tree shape (`children`) or the legacy flat one (`widgets`);
// the bucket is on the files node either way, so walk both.
type Node = { type?: string; scope?: string; bucketId?: string; children?: Node[] }
const walk = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(walk)]
const filesNode = dashboards
  .flatMap((d) => {
    const b = d.body as { children?: Node[]; widgets?: Node[] } | null
    return [...(b?.children ?? []), ...(b?.widgets ?? [])].flatMap(walk)
  })
  .find((n) => n.type === "files" && n.scope === "widget")
ok(
  "saved body carries scope=widget",
  !!filesNode,
  `dashboards=${dashboards.length} node=${JSON.stringify(filesNode)?.slice(0, 120)}`,
)
ok(
  "saved body carries a bucketId uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(filesNode?.bucketId ?? ""),
  `bucketId=${filesNode?.bucketId}`,
)

// ── upload through the widget's drop zone (the real <input type=file>) ──
console.log("step: upload a PDF into the widget")
const uploaded = await evaljs(`(async () => {
  const input = document.querySelector('input[type=file]')
  if (!input) return "no file input — drop zone missing"
  const file = new File([new TextEncoder().encode("%PDF-1.4\\nhandbook\\n%%EOF")], "handbook.pdf", { type: "application/pdf" })
  const dt = new DataTransfer()
  dt.items.add(file)
  Object.defineProperty(input, "files", { value: dt.files, configurable: true })
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return "ok"
})()`)
ok("widget renders an upload drop zone", uploaded === "ok", String(uploaded))
await until("file listed in the widget", 20000, async () =>
  (await text()).includes("handbook.pdf"),
).catch(async (e) => {
  failures++
  console.log(`FAIL  file appears in the widget — ${String(e).slice(0, 300)}`)
})
ok("uploaded file is listed by its own widget", (await text()).includes("handbook.pdf"))
drain("upload")

// ── privacy: turning the toggle off must hide the ALREADY-uploaded file org-wide ──
// (the flag is stamped per row at upload, so the save has to re-stamp the bucket)
console.log("step: make the bucket private, check org scope")
const bucket = filesNode?.bucketId ?? ""
const orgHasIt = async () => {
  const ids = (await runtime.runPromise(
    Effect.flatMap(ApiClient, (c) => c.listFiles({})) as Effect.Effect<
      ReadonlyArray<{ id: string; filename: string }>,
      unknown,
      never
    >,
  )) as ReadonlyArray<{ filename: string }>
  return ids.some((f) => f.filename === "handbook.pdf")
}
ok("org scope lists the file while sharing is on", await orgHasIt())
// Re-select the widget, flip the toggle, save.
await clickText("Visible to org-wide widgets", "button")
await sleep(300)
await clickText("Save")
await until("private applied to existing rows", 20000, async () => !(await orgHasIt())).catch(
  async (e) => {
    failures++
    console.log(
      `FAIL  making the bucket private hides its existing file — ${String(e).slice(0, 200)}`,
    )
  },
)
ok("turning sharing off hides the existing file from org scope", !(await orgHasIt()))
ok("the owning widget still lists its own private file", (await text()).includes("handbook.pdf"))
drain("privacy")

// ── delete prompt: removing the widget must ASK about its files, then purge ──
console.log("step: delete the widget")
const removed = await clickText("Remove widget", "button")
ok("remove-widget control found", removed)
await until("files prompt", 15000, async () =>
  (await text()).includes("Delete the file too?"),
).catch(async () => {
  failures++
  console.log("FAIL  delete prompts about the widget's files")
  console.log("  page after remove:", (await text()).slice(0, 800).replace(/\n/g, " | "))
})
const promptText = await text()
ok("delete asks about the widget's own files", promptText.includes("Delete the file too?"))
ok(
  "prompt says a private bucket's files would be left unreachable",
  promptText.includes("nothing will show them any more"),
  promptText.includes("reachable from") ? "showed the SHARED wording instead" : "",
)
ok("prompt offers keeping them", promptText.includes("Keep files"))
ok("prompt offers deleting them", promptText.includes("Delete file"))
// Choose delete — the bucket must actually be purged.
await clickText("Delete file", "button")
await until("bucket purged", 20000, async () => {
  const files = (await runtime.runPromise(
    Effect.flatMap(ApiClient, (c) =>
      c.listFiles({ bucketId: bucket, includeArchived: true }),
    ) as Effect.Effect<ReadonlyArray<unknown>, unknown, never>,
  )) as ReadonlyArray<unknown>
  return files.length === 0
}).catch(async (e) => {
  failures++
  console.log(`FAIL  choosing delete purges the bucket — ${String(e).slice(0, 300)}`)
})
const left = (await runtime.runPromise(
  Effect.flatMap(ApiClient, (c) =>
    c.listFiles({ bucketId: bucket, includeArchived: true }),
  ) as Effect.Effect<ReadonlyArray<unknown>, unknown, never>,
)) as ReadonlyArray<unknown>
ok("choosing “Delete files” purges the bucket", left.length === 0, `left=${left.length}`)
drain("delete")

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
ws.close()
proc.kill()
rmSync(PROFILE, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
