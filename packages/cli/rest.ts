import type { Profile } from "./config.ts"
import { CliError, EXIT, exitCodeForStatus } from "./errors.ts"

/**
 * The endpoints that are not RPC: sign-in/sign-out (BetterAuth owns those),
 * health, version, and later the attachment bytes. Plain `fetch`, because
 * these are plain HTTP and wrapping them in the RPC runtime would buy nothing.
 */

/** A network failure names the host. "fetch failed" alone is unactionable. */
const request = async (
  host: string,
  path: string,
  init?: RequestInit & { cookie?: string },
): Promise<Response> => {
  const url = `${host}${path}`
  const { cookie, ...rest } = init ?? {}
  try {
    return await fetch(url, {
      ...rest,
      headers: {
        ...(rest.headers as Record<string, string> | undefined),
        ...(cookie ? { cookie } : {}),
        // ORIGIN IS REQUIRED. BetterAuth rejects a request without one —
        // `MISSING_OR_NULL_ORIGIN`, 403 — and Node's fetch does not send one
        // (Bun's does, which is why this only failed under the published
        // artifact and not in development). We are a first-party client of this
        // deployment, so the deployment's own URL is the honest value.
        //
        // In production `trustedOrigins` is BETTER_AUTH_URL plus whatever
        // TRUSTED_ORIGINS lists, so this works as long as the host you point at
        // is the host the server thinks it is.
        origin: host,
      },
      // Cookies are attached by hand; following a redirect to another origin
      // would leak the session there.
      redirect: "manual",
    })
  } catch (e) {
    throw new CliError(
      `Cannot reach ${host} (${e instanceof Error ? e.message : String(e)}).`,
      EXIT.failed,
      "Check the host with `km profile list`, or pass --host.",
    )
  }
}

const errorBody = async (res: Response): Promise<{ code?: string; message?: string }> => {
  try {
    return (await res.json()) as { code?: string; message?: string }
  } catch {
    return {}
  }
}

export interface Health {
  readonly ok: boolean
}

/** Unauthenticated by design — it is the probe you run before signing in. */
export const health = async (host: string): Promise<Health> => {
  const res = await request(host, "/api/health")
  if (!res.ok) {
    throw new CliError(`${host} is unhealthy (HTTP ${res.status}).`, exitCodeForStatus(res.status))
  }
  return (await res.json()) as Health
}

export interface VersionInfo {
  readonly current: string
  readonly latest: string | null
  readonly updateAvailable: boolean
}

export const version = async (profile: Profile): Promise<VersionInfo> => {
  const res = await request(profile.host, "/api/version", { cookie: profile.cookie })
  if (!res.ok) {
    throw new CliError(
      `Could not read the version (HTTP ${res.status}).`,
      exitCodeForStatus(res.status),
    )
  }
  return (await res.json()) as VersionInfo
}

export interface SignInResult {
  /** The full cookie header to replay on later requests. */
  readonly cookie: string
  readonly email: string
}

/**
 * Sign in with email + password and KEEP THE COOKIE.
 *
 * BetterAuth answers with `set-cookie`, which a browser would store and replay
 * automatically. Node's fetch does not, so we read every cookie off the
 * response (there can be more than one — session token plus its signature) and
 * store them as a single header for later requests.
 */
export const signIn = async (
  host: string,
  email: string,
  password: string,
): Promise<SignInResult> => {
  const res = await request(host, "/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    const body = await errorBody(res)
    // Say what the SERVER said when it told us. Assuming "wrong password" for
    // every 401/403 is how a missing Origin header spent an afternoon looking
    // like a credentials problem.
    const credentials = body.code === "INVALID_EMAIL_OR_PASSWORD" || !body.code
    throw new CliError(
      res.status === 401 || (res.status === 403 && credentials)
        ? "Sign-in failed — check the email and password."
        : (body.code ?? body.message ?? `Sign-in failed (HTTP ${res.status}).`),
      exitCodeForStatus(res.status),
      res.status === 404 ? `No sign-in endpoint at ${host}. Is that the right host?` : undefined,
    )
  }

  // `getSetCookie` returns every Set-Cookie separately; a single `get` would
  // collapse them into one comma-joined string that no server can parse back.
  const jar = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c): c is string => Boolean(c))
  if (jar.length === 0) {
    throw new CliError(
      "Sign-in succeeded but the server set no session cookie.",
      EXIT.failed,
      "This deployment may sit behind a proxy that strips Set-Cookie.",
    )
  }

  return { cookie: jar.join("; "), email }
}

export const signOut = async (profile: Profile): Promise<void> => {
  if (!profile.cookie) return
  // A failure here is not worth aborting on: the local credential is dropped
  // either way, and a server that cannot be reached cannot be told anything.
  await request(profile.host, "/api/auth/sign-out", {
    method: "POST",
    cookie: profile.cookie,
  }).catch(() => undefined)
}
