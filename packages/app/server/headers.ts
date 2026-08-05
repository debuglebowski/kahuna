/**
 * Security response headers, applied to every response the server emits.
 *
 * There were none at all before this file existed, which is what let an uploaded
 * HTML attachment run as script on the app's own origin (see `INLINE_SAFE_TYPES`
 * in router.ts for the other half of that fix).
 *
 * Two profiles, because the SPA and user-uploaded bytes need opposite things:
 * the app must load its own scripts, and an attachment must be able to do
 * nothing at all.
 */

/**
 * CSP for the SPA. `'unsafe-inline'` on script-src is load-bearing and cannot be
 * dropped without a build change: index.html carries an inline theme script that
 * must run before first paint to avoid a light flash. Style-src likewise —
 * Tailwind v4 and the Radix primitives both set inline styles at runtime.
 *
 * `connect-src` keeps 'self' only: the client talks to its own origin (RPC, SSE,
 * REST); every third-party call is made server-side by the connectors.
 */
const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Avatars and record data legitimately reference external images (`image` on a
  // user, `url`-kind fields), so images are the one permissive directive.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // No <object>/<embed>, and nothing may frame us (the header equivalent of
  // X-Frame-Options: DENY, which is also sent below for older browsers).
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")

/**
 * CSP for attachment bytes: deny everything. `sandbox` with no allow-list drops
 * the response into an opaque origin with scripts disabled, so even a file that
 * slips past the MIME allowlist cannot reach cookies, storage, or the API.
 */
const ATTACHMENT_CSP = ["default-src 'none'", "sandbox", "frame-ancestors 'none'"].join("; ")

/** Sent on every response, upload or app. */
const COMMON = {
  // Stops a text/plain (or mislabelled) upload being sniffed into text/html.
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  // Nothing in the app uses these; denying them shrinks what an injected script
  // could reach if CSP were ever relaxed.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
} as const

/**
 * HSTS, only in production. Emitting it in dev would pin `localhost` to https in
 * the developer's browser for a year and make the dev server unreachable.
 */
const hsts = (): Record<string, string> =>
  process.env.NODE_ENV === "production"
    ? { "strict-transport-security": "max-age=31536000; includeSubDomains" }
    : {}

/** Headers for app/API responses (SPA shell, RPC, SSE, JSON). */
export const appSecurityHeaders = (): Record<string, string> => ({
  ...COMMON,
  ...hsts(),
  "content-security-policy": SPA_CSP,
})

/** Headers for attachment bytes — deny-all CSP, no scripting, no framing. */
export const attachmentSecurityHeaders = (): Record<string, string> => ({
  ...COMMON,
  ...hsts(),
  "content-security-policy": ATTACHMENT_CSP,
})

/**
 * Copy the app profile onto an existing Response, in place of rebuilding it.
 * Used to wrap handlers (auth, RPC, SSE, static files) that construct their own
 * Response and whose bodies must not be touched — a ReadableStream body cannot
 * be re-read, so `new Response(res.body, …)` is the only safe reshaping and this
 * avoids even that for the common case.
 */
export const withAppSecurityHeaders = (res: Response): Response => {
  for (const [k, v] of Object.entries(appSecurityHeaders())) res.headers.set(k, v)
  return res
}

/**
 * Apply the app profile UNLESS the handler already chose its own CSP.
 *
 * This is how the many plain-JSON responses in `router.ts` get covered without
 * each call site opting in, while the attachment route's stricter deny-all
 * profile survives: a response that already carries a CSP is returned untouched.
 */
export const withApiSecurityHeaders = (res: Response): Response =>
  res.headers.has("content-security-policy") ? res : withAppSecurityHeaders(res)
