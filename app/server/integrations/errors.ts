/**
 * What a connector failure is allowed to tell the client.
 *
 * Every connector's request wrapper throws
 * `new Error(\`${Provider} API ${status}: ${await res.text()}\`)` — the verbatim
 * upstream body. Those were being handed straight to the browser as
 * `detail: String(error)` and persisted to `connection.lastError`, which every
 * `…/status` endpoint returns to any member. So a failing connector leaked
 * provider payloads: internal hostnames, project/team ids, quota and billing
 * details, sometimes fragments of the request.
 *
 * The RPC layer already got this right (`rpc.ts` collapses anything unmapped to
 * an opaque "Internal error"). This is the same discipline for the plain-HTTP
 * integration routes: keep the STATUS, which is the actionable part, and drop the
 * body.
 *
 * The full text is not lost — `logConnectorError` puts it in the server log,
 * where an operator can read it and a member cannot.
 */

/** An upstream status parsed back out of a connector Error message, if present. */
const statusOf = (error: unknown): number | null => {
  const tagged = (error as { status?: unknown } | null)?.status
  if (typeof tagged === "number") return tagged
  // The wrappers put it in the message too (`Slack API 429: …`).
  const m = /\b(\d{3})\b/.exec(String((error as Error)?.message ?? ""))
  const n = m ? Number(m[1]) : Number.NaN
  return n >= 100 && n <= 599 ? n : null
}

/** Which provider this came from, for a message a user can act on. */
const providerOf = (error: unknown): string | null => {
  const m = /^([A-Za-z]+) API \d{3}/.exec(String((error as Error)?.message ?? ""))
  return m ? m[1]! : null
}

/**
 * A short, non-leaking description of a connector failure, safe for a response
 * body and for `lastError`.
 *
 * Deliberately shaped by STATUS CLASS rather than by provider text, so a new
 * provider needs no new cases and no upstream prose can slip through:
 *   401/403 → credentials
 *   404     → the remote object is gone
 *   429     → rate limited
 *   5xx     → provider outage
 */
export const publicConnectorError = (error: unknown): string => {
  const status = statusOf(error)
  const provider = providerOf(error) ?? "The provider"
  if (status === 401 || status === 403) {
    return `${provider} rejected the credentials. Re-connect the integration.`
  }
  if (status === 404) return `${provider} could not find that item.`
  if (status === 429) return `${provider} is rate limiting us. Try again shortly.`
  if (status !== null && status >= 500) return `${provider} is unavailable right now.`
  if (status !== null && status >= 400) return `${provider} rejected the request.`
  // No status at all: DNS failure, timeout, TLS, a thrown non-Error. Naming the
  // shape is safe; echoing the message is not.
  return `Could not reach ${provider === "The provider" ? "the provider" : provider}.`
}

/**
 * Log the FULL error server-side, where operators can see it. Prefixed so it is
 * greppable per connector, and stringified rather than passed as an object so a
 * provider body can't confuse a structured-log consumer.
 */
export const logConnectorError = (connector: string, action: string, error: unknown): void => {
  console.error(`[integrations/${connector}] ${action} failed:`, String(error))
}

/**
 * Both halves at once: log the detail, return the safe summary. This is the call
 * site pattern for every `catch` in a connector route.
 */
export const connectorFailure = (connector: string, action: string, error: unknown): string => {
  logConnectorError(connector, action, error)
  return publicConnectorError(error)
}
