import { randomBytes, timingSafeEqual } from "node:crypto"
import { resolveOrg } from "./session"

/**
 * Browser hand-off for the CLI — RFC 8252's loopback flow, minus the IdP.
 *
 *   1. `km auth login --browser` binds 127.0.0.1:<port> and opens
 *      `/api/cli/authorize?port=<port>&state=<state>` in the browser.
 *   2. The person signs in however this deployment lets them — password, SSO,
 *      anything. That is the whole point: the CLI never touches the IdP, so it
 *      works for methods it could not otherwise support.
 *   3. We redirect to `http://127.0.0.1:<port>/callback?code=…&state=…`.
 *   4. The CLI POSTs the code to `/api/cli/exchange` and gets the credential in
 *      the RESPONSE BODY.
 *
 * WHY A CODE RATHER THAN THE CREDENTIAL IN THE REDIRECT: a URL lands in browser
 * history, and on some platforms in the shell that launched the browser. The
 * code is worthless without a POST from the process that requested it.
 *
 * WHAT THE CREDENTIAL IS: the browser's own session cookie, handed over
 * verbatim. Minting a separate session would be better hygiene — the CLI would
 * survive a browser sign-out — but BetterAuth's cookie is SIGNED
 * (`setSignedCookie` with the server secret), so producing one here means
 * reimplementing their signing scheme and re-breaking it on every upgrade. That
 * trade goes away when API keys land: this endpoint then returns a token and
 * nothing else changes.
 */

interface PendingCode {
  readonly cookie: string
  readonly userId: string
  readonly state: string
  readonly expiresAt: number
}

/** In memory on purpose: a code lives 60 seconds and must not survive a
 *  restart. A table would outlive its usefulness and become a thing to purge. */
const codes = new Map<string, PendingCode>()

const CODE_TTL_MS = 60_000

const sweep = (): void => {
  const now = Date.now()
  for (const [code, pending] of codes) if (pending.expiresAt <= now) codes.delete(code)
}

/**
 * THE SECURITY OF THIS WHOLE FLOW IS THIS FUNCTION.
 *
 * `authorize` takes a redirect target from the query string. If anything but a
 * loopback port can get through, it is an open redirect that sends a live
 * session cookie to whoever asked — so the port is parsed as an integer and the
 * host is hard-coded. There is deliberately no `redirect_uri` parameter to
 * validate: the caller supplies a PORT, never a URL.
 *
 * Ports below 1024 are refused as well; a CLI binds an ephemeral port, and
 * anything privileged means someone is trying to aim this somewhere odd.
 */
export const loopbackTarget = (rawPort: string | null): string | null => {
  if (rawPort === null || !/^\d{1,5}$/.test(rawPort)) return null
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
  return `http://127.0.0.1:${port}/callback`
}

/** Opaque, bounded, and echoed back untouched so the CLI can prove the callback
 *  belongs to the request it started. */
const validState = (state: string | null): state is string =>
  state !== null && /^[A-Za-z0-9_-]{8,128}$/.test(state)

const html = (body: string, status = 200): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Kingsmaker CLI</title>` +
      `<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;color:#15181d;background:#f1f2f5}` +
      `main{max-width:34rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;color:#4b525d}code{background:#e6e8ec;padding:.1em .35em;border-radius:3px}` +
      `@media(prefers-color-scheme:dark){body{background:#0f1216;color:#e8ebf0}p{color:#a7afbb}code{background:#262c35}}</style>` +
      `<main>${body}</main>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  )

/**
 * GET /api/cli/authorize?port=<port>&state=<state>
 *
 * Requires a signed-in browser. When there is no session we send the person to
 * the app's sign-in page with `?next=` pointing back here, so signing in
 * finishes the hand-off instead of dead-ending on the dashboard.
 */
export const authorizeCli = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const target = loopbackTarget(url.searchParams.get("port"))
  const state = url.searchParams.get("state")

  if (!target || !validState(state)) {
    return html(
      `<h1>That link is not valid</h1><p>The CLI must supply a loopback <code>port</code> and a <code>state</code>. Re-run <code>km auth login --browser</code>.</p>`,
      400,
    )
  }

  const org = await resolveOrg(request)
  if (!org.ok) {
    // Not signed in (or no membership yet). Bounce through the app's own
    // sign-in, which is what makes SSO work here without the CLI knowing
    // anything about it.
    const next = `/api/cli/authorize?port=${url.searchParams.get("port")}&state=${state}`
    return new Response(null, {
      status: 302,
      headers: { location: `/?next=${encodeURIComponent(next)}` },
    })
  }

  const cookie = request.headers.get("cookie")
  if (!cookie) {
    return html(`<h1>No session cookie</h1><p>Sign in to this deployment and try again.</p>`, 401)
  }

  sweep()
  const code = randomBytes(32).toString("base64url")
  codes.set(code, {
    cookie,
    userId: org.actor,
    state,
    expiresAt: Date.now() + CODE_TTL_MS,
  })

  return new Response(null, {
    status: 302,
    headers: { location: `${target}?code=${code}&state=${encodeURIComponent(state)}` },
  })
}

/**
 * POST /api/cli/exchange  {code, state}
 *
 * Single use, and the state must match the one the CLI generated — so a code
 * that leaks out of the redirect is useless to anyone who was not part of the
 * original request.
 */
export const exchangeCli = async (request: Request): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as {
    code?: string
    state?: string
  } | null
  const code = body?.code
  const state = body?.state
  if (!code || !state) return Response.json({ error: "MISSING_CODE" }, { status: 400 })

  sweep()
  const pending = codes.get(code)
  // Consume it whether or not the state matches: a code is one attempt, so a
  // wrong guess cannot be retried against the same code.
  codes.delete(code)
  if (!pending) return Response.json({ error: "UNKNOWN_OR_EXPIRED_CODE" }, { status: 400 })

  const a = Buffer.from(pending.state)
  const b = Buffer.from(state)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "STATE_MISMATCH" }, { status: 400 })
  }

  return Response.json({ cookie: pending.cookie, userId: pending.userId })
}

/** Test seam: the pending-code store, so a test can assert single use and
 *  expiry without sleeping for a minute. */
export const __codesForTest = codes
