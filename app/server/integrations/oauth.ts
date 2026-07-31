/**
 * OAuth redirect helpers shared by the two connectors that own a browser
 * round-trip (google and slack). Both had byte-identical private copies of these.
 *
 * The other four connectors (posthog, linear, apollo, clay) authenticate with a
 * key or a webhook URL pasted into a form, so they never redirect and do not use
 * this module.
 */

const authBase = () => process.env.BETTER_AUTH_URL ?? "http://localhost:3100"

/** 302 to `to`, resolved against the server origin. */
export const redirect = (to: string) => Response.redirect(new URL(to, authBase()).toString(), 302)

/**
 * Resolve a stored `returnTo` to a safe absolute URL for the post-OAuth bounce.
 * Same-origin as the server is always allowed; in dev we also allow any
 * localhost/127.0.0.1 port so the Vite dev server (whose port drifts) receives
 * the redirect instead of :3100 (which only serves the built `dist/`). Anything
 * else falls back to the settings page on the server origin — no open redirect.
 */
export const safeReturnTo = (raw: string | null | undefined): string => {
  const base = authBase()
  const fallback = new URL("/settings/integrations", base).toString()
  if (!raw) return fallback
  let target: URL
  try {
    target = new URL(raw, base)
  } catch {
    return fallback
  }
  const isLocal = target.hostname === "localhost" || target.hostname === "127.0.0.1"
  const sameOrigin = target.origin === new URL(base).origin
  if (sameOrigin || (process.env.NODE_ENV !== "production" && isLocal)) return target.toString()
  return fallback
}
