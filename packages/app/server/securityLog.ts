import { createHmac } from "node:crypto"
import { clientIp } from "./clientIp"

/**
 * Security event log: one JSON object per line on stdout.
 *
 * WHY STDOUT. Container platforms (Azure Container Apps, ECS, Kubernetes, plain
 * `docker logs`) collect stdout/stderr into their log store; a line-delimited JSON
 * record needs no parser config there and survives being interleaved with the
 * server's free-text console lines. Operators filter on `"type":"security"`.
 *
 * WHAT NEVER GOES IN A LINE: passwords, tokens, cookies, secrets, request bodies,
 * record or message content, email addresses. Callers pass a closed set of typed
 * fields (ids, a short reason code, booleans) rather than free text, and `detail` is
 * additionally filtered here as a second line of defence (see `SENSITIVE_KEY`).
 * People are identified by user id; an unauthenticated sign-in attempt is correlated
 * by `subjectRef` (a keyed hash of the email), never the address itself.
 *
 * The event catalogue lives in docs/security-logging.md. Keep the two in step.
 */

export type SecurityOutcome = "success" | "failure" | "denied"

export interface SecurityEvent {
  /** Dotted, stable name: `auth.signin`, `access.role.assigned`, … */
  readonly event: string
  readonly outcome: SecurityOutcome
  /** User id of whoever performed the action, when known. */
  readonly actor?: string | null
  readonly orgId?: string | null
  /** The user/role/provider/etc. acted upon, as an id. */
  readonly targetKind?: string | null
  readonly targetId?: string | null
  /** A short machine code (`INVALID_EMAIL_OR_PASSWORD`), never free text. */
  readonly reason?: string | null
  readonly ip?: string | null
  /** Keyed hash of the email for attempts with no resolved user. See `subjectRef`. */
  readonly subjectRef?: string | null
  /** `METHOD /path`, query string stripped. */
  readonly route?: string | null
  /** Small flat extras: booleans, numbers, short strings. Filtered on output. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null | undefined>>
}

/** Keys whose values are never emitted, whatever a caller passes in `detail`. */
const SENSITIVE_KEY =
  /secret|token|password|passwd|authorization|cookie|credential|key|body|content|text|message|email|payload/i

const MAX_STRING = 200

const clip = (s: string): string => (s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s)

const cleanDetail = (
  detail: SecurityEvent["detail"],
): Record<string, string | number | boolean | null> | undefined => {
  if (!detail) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || SENSITIVE_KEY.test(k)) continue
    out[k] = typeof v === "string" ? clip(v) : v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>

/** Where a finished line goes. Swapped by tests. */
type Sink = (line: string) => void
const stdoutSink: Sink = (line) => {
  // The suite exercises every logged path; its lines would bury test output. Tests
  // that assert on events install their own sink (`setSecurityLogSink`).
  if (process.env.VITEST) return
  process.stdout.write(`${line}\n`)
}
let sink: Sink = stdoutSink

/** Test seam: capture lines instead of writing them. Pass nothing to restore. */
export const setSecurityLogSink = (next?: Sink): void => {
  sink = next ?? stdoutSink
}

/**
 * Emit one security event. Never throws — an audit line must not turn a sign-in or an
 * admin action into a failure, and a log sink that is gone is not the caller's problem.
 */
export const securityEvent = (e: SecurityEvent): void => {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: "security",
      level: e.outcome === "success" ? "info" : "warn",
      service: "kahuna",
      ...defined({
        event: e.event,
        outcome: e.outcome,
        actor: e.actor,
        orgId: e.orgId,
        targetKind: e.targetKind,
        targetId: e.targetId,
        reason: e.reason && clip(e.reason),
        ip: e.ip,
        subjectRef: e.subjectRef,
        route: e.route && clip(e.route),
        detail: cleanDetail(e.detail),
      }),
    })
    sink(line)
  } catch {
    /* see above */
  }
}

// The address the rate limiter keys on, so a log line and a 429 name the same
// client. Re-exported because every audit call site already imports from here.
export { clientIp }

/**
 * A stable, non-reversible handle for an email address, so repeated failures against
 * one account can be correlated without writing the address (personal data) into the
 * log. HMAC rather than a bare hash: an unkeyed SHA-256 of an email is trivially
 * reversible by guessing addresses. Keyed with the auth secret, so references are not
 * comparable across deployments.
 */
export const subjectRef = (email: string): string =>
  createHmac("sha256", process.env.BETTER_AUTH_SECRET || "dev-secret-change-me")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16)

/** `METHOD /path` for a request, without the query string (which can carry codes). */
export const routeOf = (req: Request): string => `${req.method} ${new URL(req.url).pathname}`

/**
 * An inbound, unauthenticated integration request that failed its own check (bad
 * routing token, bad signature, bad channel token). Returns the 4xx response so call
 * sites replace `json({ error }, status)` in place. These endpoints are public by
 * necessity, so a stream of these is the signal that someone is probing them. Only
 * the connector name and the machine reason are logged — never the token presented.
 */
export const webhookRejected = (
  connector: string,
  req: Request,
  reason: string,
  status: number,
): Response => {
  securityEvent({
    event: "webhook.rejected",
    outcome: "denied",
    targetKind: "integration",
    targetId: connector,
    reason,
    route: routeOf(req),
    ip: clientIp(req.headers),
  })
  return Response.json({ error: reason }, { status })
}

/**
 * A signed-in user's integration OAuth round-trip that failed its own check (unknown
 * or expired `state`, state minted for another session, wrong workspace). Returns
 * the 4xx response so call sites swap it in for `json({ error }, status)`. A
 * mismatched `state` is the signature of a forged callback.
 */
export const oauthRejected = (
  connector: string,
  req: Request,
  who: { orgId: string; actor: string },
  reason: string,
  status: number,
): Response => {
  securityEvent({
    event: "integration.oauth.rejected",
    outcome: "denied",
    actor: who.actor,
    orgId: who.orgId,
    targetKind: "integration",
    targetId: connector,
    reason,
    route: routeOf(req),
    ip: clientIp(req.headers),
  })
  return Response.json({ error: reason }, { status })
}
