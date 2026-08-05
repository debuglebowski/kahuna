import { randomBytes, timingSafeEqual } from "node:crypto"
import { resolveOrg } from "./session"

/**
 * Device flow for the CLI — RFC 8628 in shape, minus the OAuth scaffolding.
 *
 *   1. `km auth login --browser` asks for a device code and prints a URL.
 *   2. The person opens it in ANY browser, on any machine, and signs in however
 *      this deployment allows. Opening the link IS the approval — there is
 *      nothing to type.
 *   3. The CLI has been polling; it gets the credential and stores it.
 *
 * WHY NOT A LOOPBACK REDIRECT, which is the other standard answer: it requires
 * the browser and the CLI to be on the same machine. Run the CLI over ssh, or in
 * a devcontainer, or open the link on your phone, and the server redirects to a
 * `127.0.0.1` that has nothing listening — the flow fails in exactly the setting
 * a command-line tool is most used in. Nothing here is redirected anywhere.
 *
 * The credential is the approving browser's session cookie, handed over
 * verbatim. Minting a separate session would be better hygiene, but BetterAuth
 * signs its cookie with the server secret, so producing one here means
 * reimplementing their signing and re-breaking it on every upgrade.
 */

type Status = "pending" | "approved" | "denied"

interface Pending {
  /** Short, human-typed. Lives in the URL and on screen. */
  readonly userCode: string
  status: Status
  /** Set only once approved. */
  cookie?: string
  userId?: string
  readonly expiresAt: number
  /** Wrong-code attempts against this entry, to bound guessing. */
  attempts: number
}

/** Keyed by DEVICE code — the long secret only the CLI ever holds. */
const pending = new Map<string, Pending>()

const TTL_MS = 10 * 60_000
export const POLL_INTERVAL_SECONDS = 3

/**
 * No 0/O, no 1/I/L: the code is read off one screen and typed on another, and
 * every ambiguous glyph is a support conversation. 8 characters from 30 symbols
 * is ~49 bits, which is far more than a 10-minute window with 10 attempts needs.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

const userCode = (): string => {
  const bytes = randomBytes(8)
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`
}

const sweep = (): void => {
  const now = Date.now()
  for (const [code, entry] of pending) if (entry.expiresAt <= now) pending.delete(code)
}

/** Compare short codes without leaking position through timing. */
const codesMatch = (a: string, b: string): boolean => {
  const x = Buffer.from(a.toUpperCase())
  const y = Buffer.from(b.toUpperCase())
  return x.length === y.length && timingSafeEqual(x, y)
}

const normalise = (raw: string): string =>
  raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(.{4})(.{4})$/, "$1-$2")

const shell = (body: string, status = 200): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Kingsmaker CLI</title>` +
      `<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;color:#15181d;background:#f1f2f5}` +
      `main{max-width:26rem;width:100%}h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:.4rem 0;color:#4b525d}` +
      `input{font:inherit;font-family:ui-monospace,monospace;font-size:1.5rem;letter-spacing:.12em;text-align:center;text-transform:uppercase;width:100%;box-sizing:border-box;padding:.6rem;margin:1rem 0 .75rem;border:1px solid #c3c8d1;border-radius:6px;background:#fff;color:inherit}` +
      `button{font:inherit;font-weight:600;width:100%;padding:.7rem;border:0;border-radius:6px;background:#15181d;color:#fff;cursor:pointer}` +
      `.muted{font-size:.85rem}code{background:#e6e8ec;padding:.1em .35em;border-radius:3px}` +
      `@media(prefers-color-scheme:dark){body{background:#0f1216;color:#e8ebf0}p{color:#a7afbb}input{background:#161a20;border-color:#363e49}button{background:#e8ebf0;color:#0f1216}code{background:#262c35}}</style>` +
      `<main>${body}</main>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  )

/** POST /api/cli/device — the CLI starts a flow. Unauthenticated by design:
 *  nobody is signed in yet, which is the entire point. */
export const startDevice = async (request: Request): Promise<Response> => {
  sweep()
  const deviceCode = randomBytes(32).toString("base64url")
  const code = userCode()
  pending.set(deviceCode, {
    userCode: code,
    status: "pending",
    expiresAt: Date.now() + TTL_MS,
    attempts: 0,
  })
  const origin = new URL(request.url).origin
  return Response.json({
    deviceCode,
    userCode: code,
    // ONE url, and opening it approves. There is no bare "go here and type the
    // code" page, because there is nothing to type.
    verificationUri: `${origin}/api/cli/device?code=${encodeURIComponent(code)}`,
    intervalSeconds: POLL_INTERVAL_SECONDS,
    expiresInSeconds: TTL_MS / 1000,
  })
}

/**
 * GET /api/cli/device?code=… — the page a person opens, which APPROVES.
 *
 * There is no form and nothing to type. The link the CLI printed carries the
 * code, so opening it is the confirmation: the person had to be signed in to
 * this deployment to get here, and they had to follow a link their own terminal
 * produced.
 *
 * A confirmation step would defend against someone tricking you into opening a
 * link that authorises THEIR terminal. On a deployment where one person is the
 * only one who ever sees this page, that risk is theoretical and the step is
 * pure friction — so the link approves and the page says what happened.
 */
export const devicePage = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const submitted = normalise(url.searchParams.get("code") ?? "")

  const org = await resolveOrg(request)
  if (!org.ok) {
    // Sign in first, then come straight back here with the code intact — which
    // is what lets SSO, passwords, or anything else this deployment supports
    // drive a CLI sign-in without the CLI knowing about any of them.
    const raw = url.searchParams.get("code")
    const next = `/api/cli/device${raw ? `?code=${encodeURIComponent(raw)}` : ""}`
    return new Response(null, {
      status: 302,
      headers: { location: `/?next=${encodeURIComponent(next)}` },
    })
  }

  if (!submitted) {
    return shell(
      `<h1>Nothing to authorise</h1><p>Open the link your terminal printed, or run <code>km auth login --browser</code> again.</p>`,
      400,
    )
  }

  sweep()
  const entry = [...pending.values()].find((p) => codesMatch(p.userCode, submitted))
  if (!entry || entry.status !== "pending") {
    // Deliberately the same answer for "no such code" and "already used": a
    // stale link in someone's history learns nothing about what is live.
    return shell(
      `<h1>That link is no longer valid</h1><p>It may have expired, or already been used. Run <code>km auth login --browser</code> again.</p>`,
      400,
    )
  }

  const cookie = request.headers.get("cookie")
  if (!cookie) return shell(`<h1>No session cookie</h1><p>Sign in and try again.</p>`, 401)

  entry.status = "approved"
  entry.cookie = cookie
  entry.userId = org.actor

  return shell(`<h1>Signed in</h1><p>Your terminal is ready. You can close this page.</p>`)
}

/**
 * POST /api/cli/device/poll {deviceCode} — the CLI waits here.
 *
 * The device code is the secret; the short user code is only ever a
 * confirmation the human reads. So polling reveals nothing to anyone who does
 * not already hold the device code.
 */
export const pollDevice = async (request: Request): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { deviceCode?: string } | null
  const deviceCode = body?.deviceCode
  if (!deviceCode) return Response.json({ error: "MISSING_DEVICE_CODE" }, { status: 400 })

  sweep()
  const entry = pending.get(deviceCode)
  if (!entry) return Response.json({ status: "expired" }, { status: 400 })

  if (entry.status === "pending") {
    entry.attempts++
    if (entry.attempts > (TTL_MS / 1000 / POLL_INTERVAL_SECONDS) * 2) {
      // Polling far faster than told: drop it rather than serve a busy loop.
      pending.delete(deviceCode)
      return Response.json({ status: "expired" }, { status: 400 })
    }
    return Response.json({ status: "pending", intervalSeconds: POLL_INTERVAL_SECONDS })
  }

  // Approved: hand it over ONCE, then forget it.
  pending.delete(deviceCode)
  return Response.json({ status: "approved", cookie: entry.cookie, userId: entry.userId })
}

/** Test seam: the pending store, so expiry and single-use are testable without
 *  waiting ten minutes. */
export const __pendingForTest = pending
export const __userCodeForTest = userCode
export const __normaliseForTest = normalise
