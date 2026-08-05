/**
 * Retry timing shared by every integration connector's HTTP wrapper.
 *
 * Only the *timing* is shared, deliberately. The request wrappers themselves
 * (`googleRequest`, `linearGraphQL`, `slackApiRequest`, `posthogRequest`,
 * `apolloRequest`, `clayPost`) stay per-connector: clay returns a raw `Response`
 * and never throws, google re-resolves its access token on every attempt (with
 * DB writes and an audit row), slack retries on a 200 whose *body* says
 * `ratelimited`, and linear unwraps a GraphQL envelope. A single
 * `fetchWithRetry` covering all of them would need three options used by exactly
 * one caller each, and would push the `!res.ok` handling back out into five
 * copies. The `retry-after` arithmetic below is the part that is genuinely the
 * same everywhere.
 *
 * THE BUG THIS FIXES: `Number(res.headers.get("retry-after"))` is `Number(null)`
 * = `0` when the header is absent, and `Number.isFinite(0)` is `true`. So the
 * obvious reading —
 *
 *     const secs = Number(res.headers.get("retry-after"))
 *     const delay = Number.isFinite(secs) ? secs * 1000 : base * 2 ** attempt
 *
 * — silently resolved a MISSING header to a 0ms delay, making the exponential
 * fallback dead code (reachable only via a non-numeric header, e.g. the
 * HTTP-date form, which yields `NaN`). google/linear/slack/posthog all had it, so
 * a rate-limited provider got hot-looped instead of backed off. apollo and clay
 * had a `&& retryAfter > 0` guard that avoided it by treating an explicit "0" as
 * absent too.
 *
 * Distinguishing `null` from `"0"` — rather than adopting that `> 0` guard — is
 * what lets the connector tests keep sending `retry-after: "0"` to stay fast
 * while the absent-header path still backs off. `posthog.test.ts` covers both.
 */
export const retryDelayMs = (res: Response, attempt: number, baseMs = 300): number => {
  const raw = res.headers.get("retry-after")
  // Absent -> NaN (fall through to backoff). Present-but-"0" -> 0 (honour it).
  const seconds = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(seconds) ? seconds * 1000 : baseMs * 2 ** attempt
}

/** Sleep the `Retry-After`-derived delay before the next attempt. */
export const sleepBeforeRetry = async (
  res: Response,
  attempt: number,
  baseMs = 300,
): Promise<void> => {
  const delay = retryDelayMs(res, attempt, baseMs)
  await new Promise((resolve) => setTimeout(resolve, delay))
}
