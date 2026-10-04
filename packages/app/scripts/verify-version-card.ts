/* Headless-Chrome CDP driver: verifies the Version card in Settings ->
 * Organization end-to-end through the real UI. Launches an isolated headless
 * Chrome (temp profile — the MCP browser profile may be in use by another agent),
 * signs up a throwaway account, creates an org, then reads the card.
 *
 * Points at whatever BASE says. The default (:3199) is the throwaway container
 * stack, NOT the slay-managed dev stack on :5100/:3100 — the point of this driver
 * is to exercise a VERSION-STAMPED image, which a source checkout can't produce
 * (it reports `dev` and deliberately never claims an update is available).
 *
 * Bring the stack up with a stamped image and a repo that has real release tags:
 *
 *   docker build --build-arg KAHUNA_VERSION=0.1.0 -t kahuna:vtest .
 *   docker run -d --name vtest-app -p 3199:3100 \
 *     -e DATABASE_URL=... -e BETTER_AUTH_SECRET=... \
 *     -e BETTER_AUTH_URL=http://localhost:3199 \
 *     -e KAHUNA_IMAGE_REPO=astral-sh/uv \
 *     kahuna:vtest
 *
 * Mirrors scripts/verify-bucket-ui.ts. */
import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { provisionVerifyIdentity } from "./verify-session"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASE = process.env.BASE ?? "http://localhost:3199"
const PROFILE = `/tmp/version-card-profile-${process.pid}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failures++
}

try {
  const r = await fetch(`${BASE}/api/health`)
  if (!r.ok) throw new Error(`status ${r.status}`)
} catch (e) {
  console.error(`FATAL: no server on ${BASE}:`, e)
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

// ── Sign in, in-page so the session cookie lands in the browser ───────────────
// The account + seeded org are provisioned out of band: self-serve sign-up and
// member org-creation are both closed server-side (see server/auth.ts).
const identity = await provisionVerifyIdentity("version-card")
await send("Page.navigate", { url: `${BASE}/` }, sessionId)
await until("app booted", 30000, async () => (await text()).length > 0)

const setup = await evaljs(`(async () => {
  const r = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: ${JSON.stringify(identity.email)},
      password: ${JSON.stringify(identity.password)},
    }),
  })
  if (r.status !== 200) return JSON.stringify({ step: "signIn", status: r.status, body: await r.text() })
  const act = await fetch("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: ${JSON.stringify(identity.orgId)} }),
  })
  if (act.status !== 200) return JSON.stringify({ step: "setActive", status: act.status, body: await act.text() })
  return JSON.stringify({ step: "ok" })
})()`)
const setupResult = JSON.parse(setup) as { step: string; status?: number; body?: string }
ok("signed in + org active", setupResult.step === "ok", JSON.stringify(setupResult).slice(0, 200))

// What the server reports — the card must agree with it. The registry check runs
// once at boot and is in-flight while we sign up, so poll for it to LAND rather
// than reading `latest` immediately: a null here is a startup race, not a bug.
let apiRaw = ""
await until("server finished its registry check", 30000, async () => {
  apiRaw = await evaljs(`fetch("/api/version").then(r => r.text())`)
  return (JSON.parse(apiRaw) as { checkedAt: string | null }).checkedAt !== null
}).catch(() => {
  /* fall through and assert on whatever we got — the message below explains */
})
const api = JSON.parse(apiRaw) as {
  current: string
  latest: string | null
  updateAvailable: boolean
  checkedAt: string | null
}
console.log(`      server says: ${apiRaw}`)
ok("image is version-stamped", api.current !== "dev", `current=${api.current}`)
ok("registry check completed", api.checkedAt !== null, `checkedAt=${api.checkedAt}`)
ok("registry check resolved a release", api.latest !== null, `latest=${api.latest}`)

// ── The card itself ──────────────────────────────────────────────────────────
await send("Page.navigate", { url: `${BASE}/settings/organization` }, sessionId)
await until("settings loaded", 30000, async () => (await text()).includes("Organization"))

// SCOPED TO <main>, not document.body. The sidebar notice renders "New version"
// plus BOTH version strings, so a body-wide check is satisfied by the sidebar
// while the card is still loading — the gate below passed early and every card
// assertion then ran against a spinner. Read the page region only.
const mainText = () => evaljs(`document.querySelector("main")?.innerText ?? ""`) as Promise<string>

// Wait for the QUERY, not just the heading. The card renders its title
// immediately and fills in on resolve, so gating on "Version" alone raced the
// fetch and every content assertion failed against a spinner.
await until("version card resolved", 20000, async () => {
  const t = await mainText()
  if (t.includes("Version unavailable")) throw new Error("card reported Version unavailable")
  return t.includes(api.current)
})

const body = await mainText()
if (process.env.DEBUG_CARD) {
  console.log("--- main text ---\n", body.slice(0, 1500))
  console.log(
    "--- in-page /api/version ---\n",
    await evaljs(`fetch("/api/version").then(r => r.status + " " + r.statusText)`),
  )
}
ok("card renders a Version section", body.includes("Version"))
ok("shows the running build", body.includes(api.current), `expected ${api.current}`)

if (api.updateAvailable) {
  ok("shows the Update available badge", body.includes("Update available"))
  ok(
    "names the newer release",
    api.latest !== null && body.includes(api.latest),
    `expected ${api.latest}`,
  )
  // Also scoped to <main> — the sidebar modal carries a "Release notes" link too.
  const href = await evaljs(
    `(() => { const a = [...document.querySelectorAll("main a")].find(a => (a.textContent ?? "").includes("Release notes")); return a ? a.href : null })()`,
  )
  ok("links release notes", typeof href === "string" && href.includes("/releases"), String(href))
  // The whole point of staying platform-neutral: the app must not tell a
  // Kubernetes operator to run docker compose.
  ok(
    "prints no platform-specific upgrade command",
    !/docker compose|kubectl|helm /i.test(body),
    "found a deploy command in the card",
  )
} else {
  ok("no update badge when up to date", !body.includes("Update available"))
}

// ── The sidebar notice + its modal ───────────────────────────────────────────
// Lives in the sidebar footer above the identity block, on every page — so check
// it somewhere other than settings.
await send("Page.navigate", { url: `${BASE}/` }, sessionId)
await until("app shell loaded", 30000, async () => (await text()).includes("Kahuna"))

const noticeSel = 'aside button[aria-label^="New version"]'
if (api.updateAvailable) {
  await until("sidebar notice appears", 20000, async () =>
    Boolean(await evaljs(`Boolean(document.querySelector(${JSON.stringify(noticeSel)}))`)),
  ).catch(() => {
    failures++
    console.log("FAIL  sidebar notice appears — never rendered")
  })

  const notice = await evaljs(`(() => {
    const el = document.querySelector(${JSON.stringify(noticeSel)})
    if (!el) return null
    const aside = el.closest("aside")
    const identity = aside?.querySelector('[data-slot="dropdown-menu-trigger"]')
    // Sidebar order matters: the notice must sit ABOVE the user block.
    const above = identity
      ? el.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING
      : 0
    return JSON.stringify({ text: (el.textContent ?? "").trim(), aboveIdentity: Boolean(above) })
  })()`)
  const n = notice ? (JSON.parse(notice) as { text: string; aboveIdentity: boolean }) : null
  ok("notice says “New version”", Boolean(n?.text.includes("New version")), n?.text ?? "absent")
  ok(
    "notice shows current → latest",
    Boolean(n?.text.includes(api.current) && api.latest !== null && n.text.includes(api.latest)),
    n?.text ?? "absent",
  )
  ok("notice sits above the user block", Boolean(n?.aboveIdentity))

  // Clicking it must open the instructions modal.
  await evaljs(`document.querySelector(${JSON.stringify(noticeSel)})?.click()`)
  await until("modal opens", 10000, async () =>
    Boolean(await evaljs(`Boolean(document.querySelector('[role="dialog"]'))`)),
  ).catch(() => {
    failures++
    console.log("FAIL  modal opens — no dialog appeared")
  })

  const modal = String(
    (await evaljs(`document.querySelector('[role="dialog"]')?.innerText ?? ""`)) ?? "",
  )
  ok("modal titled “Update available”", modal.includes("Update available"))
  ok("modal names both versions", modal.includes(api.current) && modal.includes(api.latest ?? "\0"))
  // The instructions are the whole point: migrate must precede serve.
  ok("modal explains migrate-before-serve", /migrat/i.test(modal))
  ok("modal gives the compose commands", modal.includes("run --rm app migrate"))
  ok("modal names other orchestrators", /Kubernetes|Nomad|systemd/.test(modal))
  // The two facts that bite after a bad upgrade.
  ok("modal warns rollback is not symmetric", /forward|restore/i.test(modal))
  ok("modal warns uploads aren't in a DB dump", /database dump|blob/i.test(modal))
  ok("modal states nothing was applied", /Nothing has been downloaded|not been/i.test(modal))
  const mHref = await evaljs(
    `(() => { const a = [...document.querySelectorAll('[role="dialog"] a')].find(a => (a.textContent ?? "").includes("Release notes")); return a ? a.href : null })()`,
  )
  ok("modal links release notes", typeof mHref === "string" && mHref.includes("/releases"))
} else {
  const present = await evaljs(`Boolean(document.querySelector(${JSON.stringify(noticeSel)}))`)
  ok("no sidebar notice when up to date", present === false)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
ws.close()
// `kill()` only *asks*, and Chrome takes a moment to reap its helpers. Exiting
// before it does leaves a stray browser that recreates the profile dir after the
// rmSync below. Wait for the exit, SIGKILL if it stalls, then delete.
await new Promise<void>((resolve) => {
  const done = setTimeout(() => {
    proc.kill("SIGKILL")
    resolve()
  }, 5000)
  proc.once("exit", () => {
    clearTimeout(done)
    resolve()
  })
  proc.kill()
})
rmSync(PROFILE, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
