/* Does a REAL file drag reach a Files widget's drop zone?
 *
 * The bucket suite uploads through the hidden <input type=file>, which passes even
 * when dragging is impossible. This script asks the harder question on both
 * surfaces that render WidgetCanvas: the editor's arranging canvas and the live
 * dashboard page. It hit-tests the zone's centre coordinates (a real OS drag is
 * routed by coordinates, so `pointer-events: none` anywhere up the tree makes the
 * zone unreachable no matter how correct its handlers are), then performs the
 * gesture with Input.dispatchDragEvent, which goes through Chrome's own
 * hit-testing rather than dispatching straight at the element.
 *
 * BASE/API default to the throwaway stack so a plain run leaves the managed one
 * alone. Reuses the bucket suite's setup shape. */
import { spawn } from "node:child_process"
import { rmSync, unlinkSync, writeFileSync } from "node:fs"
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"
// The editor's own factory, so this tests the default a person actually gets.
import { newWidget } from "../src/lib/dashboards"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASE = process.env.BASE ?? "http://localhost:5199"
// The API behind that Vite proxy — the concept list is read over the real RPC
// client, which talks to the API directly.
const API = process.env.API ?? "http://localhost:3199"
const PROFILE = `/tmp/drop-reach-profile-${process.pid}`
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
// Needed for Network.getCookies below (borrowing the browser's session).
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
  throw new Error(`timeout: ${label}\n${(await text().catch(() => "")).slice(0, 900)}`)
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

/** What actually sits at the drop zone's centre, and what (if anything) up the
 *  tree has switched off pointer events. */
const HIT_TEST = `(() => {
  const zone = [...document.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes("Drop files or click to upload"))
  if (!zone) return JSON.stringify({ found: false })
  const r = zone.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  let blocker = null
  for (let el = zone; el && el !== document.documentElement; el = el.parentElement) {
    if (getComputedStyle(el).pointerEvents === "none") {
      blocker = el.tagName.toLowerCase() + "." + String(el.className).slice(0, 70)
      break
    }
  }
  return JSON.stringify({
    found: true,
    reachable: !!hit && (zone === hit || zone.contains(hit)),
    hit: hit ? hit.tagName.toLowerCase() + "." + String(hit.className).slice(0, 70) : null,
    blocker,
  })
})()`
type Hit = { found: boolean; reachable?: boolean; hit?: string | null; blocker?: string | null }

/** The real gesture: routed by coordinates through Chrome's hit-testing.
 *  CDP's DragData.files takes absolute paths on disk (Chrome reads the bytes
 *  itself), not bare filenames — passing a name yields a drop with no file and
 *  the upload silently never happens. */
async function dragFileOnto(name: string, target: "zone" | "body" = "zone") {
  const path = `/tmp/${name}`
  writeFileSync(path, `%PDF-1.4\n${name}\n%%EOF`)
  // "zone" = the dashed strip. "body" = the widget's own area BELOW the strip,
  // which is where a person aims when told "drag a file into the widget" — the
  // strip is a few dozen pixels of a much larger tile.
  const box = await evaljs(`(() => {
    const z = [...document.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("Drop files or click to upload"))
    if (!z) return null
    if (${JSON.stringify(target)} === "zone") {
      const r = z.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    }
    // The scroll container holding both the strip and the file list is the widget's
    // content area; aim at its lower half, clear of the strip.
    const body = z.closest("div.flex.h-full.flex-col") ?? z.parentElement?.parentElement
    if (!body) return null
    const br = body.getBoundingClientRect()
    const zr = z.getBoundingClientRect()
    const y = (zr.bottom + br.bottom) / 2
    if (y <= zr.bottom + 2) return null
    return JSON.stringify({ x: br.left + br.width / 2, y })
  })()`)
  if (!box) return false
  const { x, y } = JSON.parse(box) as { x: number; y: number }
  const data = {
    items: [{ mimeType: "application/pdf", data: path, title: name }],
    files: [path],
    dragOperationsMask: 1,
  }
  // Drag interception has to be on for dispatchDragEvent to be accepted at all.
  await send("Input.setInterceptDrags", { enabled: true }, sessionId).catch(() => {})
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await send("Input.dispatchDragEvent", { type, x, y, data, modifiers: 0 }, sessionId).catch(
      (e) => console.log(`    ! ${type}: ${String(e).slice(0, 200)}`),
    )
    await sleep(200)
  }
  return true
}

// ── sign up (the browser has no session; org is created by the client) ──
console.log("step: sign up")
await send("Page.navigate", { url: `${BASE}/` }, sessionId)
await until("auth page", 60000, async () => (await text()).includes("Need an account"))
await clickText("Need an account")
await until("signup form", 8000, async () => (await text()).includes("Organization name"))
const email = `drop-reach-${Date.now()}@example.com`
await evaljs(`(() => {
  const set = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
    s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const ins = [...document.querySelectorAll("form input")]
  set(ins[0], "Drop Reach"); set(ins[1], ${JSON.stringify(email)})
  set(ins[2], "drop-pass-123"); set(ins[3], "Drop Reach Org")
  document.querySelector('form button[type="submit"]').click()
  return true
})()`)
await until("app shell", 60000, async () => !(await text()).includes("Organization name"))
// Sign-up creates the org and THEN sets it active; navigating in between yields a
// shell whose every query fails with "No active org".
await until("active org on the session", 40000, async () =>
  Boolean(
    JSON.parse((await evaljs(`fetch("/api/auth/get-session").then((r) => r.text())`)) || "null")
      ?.session?.activeOrganizationId,
  ),
)

// ── build a dashboard with a widget-scope Files widget ──
console.log("step: build a widget-scope Files widget")
await send("Page.navigate", { url: `${BASE}/settings/dashboards` }, sessionId)
const hasNew = `[...document.querySelectorAll("button")].some((e) => (e.textContent ?? "").trim().startsWith("New"))`
await until("dashboards settings", 30000, () => evaljs(hasNew) as Promise<boolean>)
await evaljs(`(() => {
  const press = ${POINTER}
  const b = [...document.querySelectorAll("button")].find((e) => (e.textContent ?? "").trim().startsWith("New"))
  if (!b) return false
  press(b); return true
})()`)
await until("new menu", 8000, async () => (await text()).includes("Page dashboard"))
await clickText("Page dashboard")
await until("editor open", 20000, async () => (await text()).includes("Layout"))
await clickText("Layout", "button, [role=tab]")
await until("layout tab", 10000, async () => (await text()).includes("Add widget"))
await clickText("Add widget")
await until(
  "gallery",
  10000,
  () =>
    evaljs(
      `[...document.querySelectorAll("input")].some((i) => (i.placeholder ?? "").includes("Search widgets"))`,
    ) as Promise<boolean>,
)
await clickText("Files", "button")
await until("widget added", 15000, async () => (await text()).includes("Scope"))
// Scope → "This widget"
await evaljs(`(() => {
  const press = ${POINTER}
  const row = [...document.querySelectorAll("div")]
    .find((d) => (d.textContent ?? "").trim().startsWith("Scope") && d.querySelector("[role=combobox]"))
  const trigger = row?.querySelector("[role=combobox]") ?? document.querySelector("[role=combobox]")
  if (!trigger) return false
  press(trigger); return true
})()`)
await until("scope options", 8000, async () => (await text()).includes("This widget"))
await clickReal("This widget (its own files)", "[role=option]")
await until("widget scope applied", 10000, async () =>
  (await text()).includes("Also list elsewhere"),
)
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 }, sessionId)
await clickText("Save")
await sleep(2500)
// The settings editor route is /settings/dashboards/:id — that id is the only
// handle on the dashboard just created, and /dashboards alone lands on Home.
const dashId = String(await evaljs(`location.pathname.split("/").pop()`))

// ── surface 1: the editor's arranging canvas ──
// The canvas parks pointer-events:none over widget bodies so drags rearrange tiles,
// which makes a live drop zone unreachable there. So the editor must NOT show an
// interactive zone that silently eats clicks — it shows a placeholder pointing at
// the surfaces that do work.
console.log("step: editor (arranging) — is the zone honest about uploads?")
const editorText = await text()
ok(
  "editor does NOT show an interactive drop zone (it can't work there)",
  !editorText.includes("Drop files or click to upload"),
)
ok(
  "editor explains where uploads DO work",
  editorText.includes("Uploads work on the dashboard itself"),
  editorText.includes("Drop files or click to upload") ? "showed the live zone instead" : "",
)

// ── surface 1b: the editor's Preview toggle (the in-editor escape hatch) ──
// Preview renders the same canvas with pointer input on, so the placeholder must
// give way to a working zone without leaving the editor. If this regressed, the
// message above would be pointing at a route that doesn't deliver.
console.log("step: editor Preview — does the real zone come back?")
const previewOpened = await evaljs(`(() => {
  const press = ${POINTER}
  const b = [...document.querySelectorAll("button")]
    .find((e) => (e.getAttribute("aria-label") ?? "") === "Preview")
  if (!b) return false
  press(b); return true
})()`)
ok("Preview toggle found", previewOpened === true)
if (previewOpened) {
  await until("preview zone", 12000, async () =>
    (await text()).includes("Drop files or click to upload"),
  ).catch(() => {})
  const prevHit = JSON.parse(String(await evaljs(HIT_TEST))) as Hit
  ok(
    "Preview: a real drag reaches the drop zone",
    prevHit.reachable === true,
    prevHit.blocker ? `blocked by pointer-events:none on ${prevHit.blocker}` : `hit=${prevHit.hit}`,
  )
}

// ── surface 2: the live dashboard page (what people actually use) ──
console.log("step: live dashboard — can a real drag reach the zone?")
// Leave the editor for the dashboard's own page. `/dashboards` bare lands on Home,
// which is a different (empty) dashboard — go to the id this run just created.
await send("Page.navigate", { url: `${BASE}/dashboards/${dashId}` }, sessionId)
await until("live dashboard", 30000, async () => {
  const t = await text()
  return t.includes("Drop files or click to upload") || t.includes("No files here yet")
}).catch(async () => {
  console.log(
    `  live page (/dashboards/${dashId}):`,
    (await text()).slice(0, 700).replace(/\n/g, " | "),
  )
})
const liveZone = (await text()).includes("Drop files or click to upload")
ok("live dashboard renders the drop zone", liveZone)
if (liveZone) {
  const liveHit = JSON.parse(String(await evaljs(HIT_TEST))) as Hit
  ok(
    "live dashboard: a real drag reaches the drop zone",
    liveHit.reachable === true,
    liveHit.blocker ? `blocked by pointer-events:none on ${liveHit.blocker}` : `hit=${liveHit.hit}`,
  )
  if (liveHit.reachable) {
    await dragFileOnto("live-drag.pdf")
    // Just wait it out — the single `ok` below is what counts, so a timeout here
    // must not also bump `failures` (that reported one bug as two).
    await until("live drag listed", 15000, async () =>
      (await text()).includes("live-drag.pdf"),
    ).catch(() => {})
    ok("live dashboard: a dragged file uploads", (await text()).includes("live-drag.pdf"))
    // The strip is a thin band at the top of a much bigger tile. "Drag a file into
    // the widget" aims at the tile, so dropping on the widget's own area has to
    // work too — asserting only the strip is why this looked fine while the actual
    // gesture failed.
    const onBody = await dragFileOnto("body-drag.pdf", "body")
    if (!onBody) {
      console.log("  couldn't compute a body point clear of the strip — skipped")
    } else {
      await until("body drag listed", 15000, async () =>
        (await text()).includes("body-drag.pdf"),
      ).catch(() => {})
      ok(
        "live dashboard: a file dropped on the widget AREA (not the strip) uploads",
        (await text()).includes("body-drag.pdf"),
      )
    }
  }
}

// ── surface 3: a real RECORD page's Files tile ──
// A different component path entirely (FilesPanel via the instance tile registry,
// not a dashboard widget), and the surface most likely to be tried first — so it
// gets its own check rather than an assumption inherited from the dashboard.
console.log("step: record page — can a real drag reach the Files tile's zone?")
// Which concept to open? Read it over the REAL Effect RPC client — the browser's
// transport is ndjson with an internal envelope shape, and hand-rolling that read
// has already bitten this suite twice. Borrow the browser's cookie for the session.
await send("Page.navigate", { url: `${BASE}/` }, sessionId)
await until("app shell", 30000, async () => (await text()).length > 0)
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
class ApiClient extends Context.Tag("verify-drop/ApiClient")<ApiClient, Client>() {}
const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)
// None of the seeded concepts' default record views carry a Files tile, so waiting
// for one to appear just reports "skipped" and leaves the surface untested — the
// exact gap that hid the editor bug. Build the record view instead: a record-kind
// dashboard for the first concept, holding an instance-scoped Files widget that
// binds to whichever record is open.
type ConceptRow = { id: string; slug: string; name: string }
const concepts = (await runtime
  .runPromise(
    Effect.flatMap(ApiClient, (c) => c.listConcepts({})) as unknown as Effect.Effect<
      ReadonlyArray<ConceptRow>,
      unknown,
      never
    >,
  )
  .catch((e) => {
    console.log(`  listConcepts failed: ${String(e).slice(0, 200)}`)
    return [] as ReadonlyArray<ConceptRow>
  })) as ReadonlyArray<ConceptRow>
let picked: ConceptRow | undefined
const dim = { unit: "fr" as const, value: 1, min: 6 }
for (const c of concepts) {
  // A record needs to exist for the record page to render a body at all.
  const made = await runtime
    .runPromise(
      Effect.flatMap(ApiClient, (cl) =>
        cl.createInstance({ conceptId: c.id, fields: {} }),
      ) as unknown as Effect.Effect<{ id: string }, unknown, never>,
    )
    // Say why, don't swallow — a silent null here spent a whole run looking like
    // "the record surface has no drop zone" when the create call was just wrong.
    .catch((e) => {
      console.log(`  createInstance failed for ${c.name}: ${String(e).slice(0, 200)}`)
      return null
    })
  if (!made?.id) continue
  const built = await runtime
    .runPromise(
      Effect.flatMap(ApiClient, (cl) =>
        cl.createDashboard({
          name: `Drop Reach ${c.name}`,
          scope: "org",
          kind: "record",
          conceptId: c.id,
          // Build the widget the way the EDITOR does — `newWidget("files", true)`,
          // the record-dashboard default — instead of hand-writing a known-good
          // config. Hand-writing it is why this script passed while the product
          // shipped a record view whose Files widget defaulted to whole-org scope:
          // browse-only, no drop target, no upload possible.
          // Two widgets, because both had to be broken to block the user:
          //  1. the editor's record default (`newWidget("files", true)`);
          //  2. a WIDE-scope widget — exactly what the reported Policy view had
          //     saved (`scope: "org"`, no allowUpload). Already-saved bodies aren't
          //     migrated, so this config still has to accept a drop: on a record
          //     page the open record is the destination.
          body: {
            direction: "col",
            children: [
              { ...newWidget("files", true), w: dim, h: dim },
              { ...newWidget("files"), title: "Wide scope", w: dim, h: dim },
            ],
          },
          // biome-ignore lint/suspicious/noExplicitAny: body is the wire union
        } as any),
      ) as unknown as Effect.Effect<{ id: string }, unknown, never>,
    )
    .catch((e) => {
      console.log(`  createDashboard(record) failed for ${c.name}: ${String(e).slice(0, 200)}`)
      return null
    })
  if (!built) continue
  await send("Page.navigate", { url: `${BASE}/instances/${made.id}` }, sessionId)
  const found = await until("record files zone", 15000, async () =>
    (await text()).includes("Drop files or click to upload"),
  ).then(
    () => true,
    () => false,
  )
  if (found) {
    picked = c
    break
  }
  console.log(`  no zone on /instances/${made.id} (${c.name}) — trying the next concept`)
}
if (!concepts.length) {
  failures++
  console.log("FAIL  record page: resolved a concept to test against (got 0)")
} else if (!picked) {
  // Not a skip: the script builds the record view itself, so failing to get a zone
  // on ANY concept means the record surface is broken (or the build is), and that
  // has to read as a failure rather than a shrug.
  failures++
  console.log(
    `FAIL  record page: no Files drop zone on any of the ${concepts.length} concepts' record views`,
  )
} else {
  console.log(`  testing on a "${picked.name}" record`)
  {
    const recHit = JSON.parse(String(await evaljs(HIT_TEST))) as Hit
    ok(
      "record page: a real drag reaches the Files drop zone",
      recHit.reachable === true,
      recHit.blocker ? `blocked by pointer-events:none on ${recHit.blocker}` : `hit=${recHit.hit}`,
    )
    if (recHit.reachable) {
      await dragFileOnto("record-drag.pdf")
      await until("record drag listed", 15000, async () =>
        (await text()).includes("record-drag.pdf"),
      ).catch(() => {})
      ok("record page: a dragged file uploads", (await text()).includes("record-drag.pdf"))
      // Same area question on the record surface — its Files tile is a different
      // component (FilesPanel), so it needs its own assertion.
      const onRecBody = await dragFileOnto("rec-body-drag.pdf", "body")
      if (!onRecBody) {
        console.log("  couldn't compute a record body point clear of the strip — skipped")
      } else {
        await until("record body drag listed", 15000, async () =>
          (await text()).includes("rec-body-drag.pdf"),
        ).catch(() => {})
        ok(
          "record page: a file dropped on the tile AREA (not the strip) uploads",
          (await text()).includes("rec-body-drag.pdf"),
        )
      }
      // ── the reported case: a WIDE-scope Files widget on a record page ──
      // Saved bodies aren't migrated, so this exact config (scope "org", no
      // allowUpload) is what the user has. It must accept a drop, and it must say
      // where the file goes rather than implying "uploads to the org".
      const wide = await evaljs(`(() => {
        const zones = [...document.querySelectorAll("button")]
          .filter((b) => (b.textContent ?? "").includes("Drop files or click to upload"))
        const named = zones.find((b) => (b.textContent ?? "").includes("attach to this record"))
        if (!named) return JSON.stringify({ found: false, zones: zones.length })
        const r = named.getBoundingClientRect()
        return JSON.stringify({ found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 })
      })()`)
      const wideZone = JSON.parse(String(wide)) as {
        found: boolean
        x?: number
        y?: number
        zones?: number
      }
      ok(
        "record page: a WIDE-scope (org) Files widget offers a drop zone",
        wideZone.found === true,
        wideZone.found ? "" : `zones found=${wideZone.zones}`,
      )
      if (wideZone.found && wideZone.x != null && wideZone.y != null) {
        const path = "/tmp/wide-drag.pdf"
        writeFileSync(path, "%PDF-1.4\nwide\n%%EOF")
        const data = {
          items: [{ mimeType: "application/pdf", data: path, title: "wide-drag.pdf" }],
          files: [path],
          dragOperationsMask: 1,
        }
        await send("Input.setInterceptDrags", { enabled: true }, sessionId).catch(() => {})
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await send(
            "Input.dispatchDragEvent",
            { type, x: wideZone.x, y: wideZone.y, data, modifiers: 0 },
            sessionId,
          ).catch((e) => console.log(`    ! ${type}: ${String(e).slice(0, 160)}`))
          await sleep(200)
        }
        await until("wide drag listed", 15000, async () =>
          (await text()).includes("wide-drag.pdf"),
        ).catch(() => {})
        ok(
          "record page: a file dropped on the WIDE-scope widget uploads to the record",
          (await text()).includes("wide-drag.pdf"),
        )
      }
    }
  }
}

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
for (const f of [
  "/tmp/editor-drag.pdf",
  "/tmp/live-drag.pdf",
  "/tmp/record-drag.pdf",
  "/tmp/body-drag.pdf",
  "/tmp/rec-body-drag.pdf",
  "/tmp/wide-drag.pdf",
]) {
  try {
    unlinkSync(f)
  } catch {}
}
process.exit(failures === 0 ? 0 : 1)
