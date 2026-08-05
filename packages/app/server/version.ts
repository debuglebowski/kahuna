import { retryDelayMs } from "./integrations/http"

/**
 * Which build am I, and is there a newer one?
 *
 * Two halves, and only the first is load-bearing:
 *
 *   - `CURRENT_VERSION` is stamped into the image at build time (Dockerfile
 *     `ARG KINGSMAKER_VERSION` -> `ENV`). Outside a container it is `"dev"`.
 *     Support conversations start with knowing this, so it is reported to every
 *     member regardless of the check below.
 *   - The periodic check asks the REGISTRY what tags exist and compares. It is
 *     advisory only: nothing here applies an update, because the correct update
 *     order (`migrate` with the new image, THEN `serve`) is the orchestrator's
 *     job and this process cannot know whether it is under compose, k8s, Nomad
 *     or a bare systemd unit. See docker-entrypoint.sh.
 *
 * WHY THE REGISTRY AND NOT THE GITHUB RELEASES API: the repo is private, and
 * GitHub answers unauthenticated calls about a private repo with 404 — the check
 * would fail for every self-hoster. GHCR *package* visibility is a separate
 * setting, so a public image published from a private repo is anonymously
 * listable. It is also the more honest question: "what can I actually pull?"
 * rather than "what did someone tag in git?".
 *
 * NO ADVISORY LOCK, deliberately. Unlike the decay tick and the Google watch
 * renewal (which do real per-org work and would duplicate it across replicas),
 * this is an idempotent read into per-process memory. N replicas each polling is
 * harmless, so don't "fix" it by adding a lock or a table.
 *
 * NO PERSISTENCE, deliberately. State is one module-level object, re-fetched on
 * restart. There is nothing here worth a migration.
 */

/** Stamped by the Dockerfile; `dev` for a source checkout. */
export const CURRENT_VERSION = process.env.KINGSMAKER_VERSION?.trim() || "dev"

/** `owner/name` of the image to poll. Override for a fork or a mirror. */
const REPOSITORY = process.env.KINGSMAKER_IMAGE_REPO?.trim() || "debuglebowski/kingsmaker"

const CHECK_INTERVAL_MS = Number(process.env.UPDATE_CHECK_INTERVAL_MS ?? 3_600_000)

/** Opt OUT with `UPDATE_CHECK_ENABLED=0`. Documented in .env.production.example:
 *  it is an outbound request to a third party from someone else's server, and an
 *  undisclosed one of those is how self-hosters lose trust in a project. */
const enabled = (): boolean => process.env.UPDATE_CHECK_ENABLED !== "0"

export interface VersionInfo {
  /** The build this process is running. */
  readonly current: string
  /** Newest release tag seen in the registry, or null if unknown/not yet checked. */
  readonly latest: string | null
  /** True only when a real comparison put `latest` ahead of `current`. */
  readonly updateAvailable: boolean
  /** ISO timestamp of the last completed check, null if none has finished. */
  readonly checkedAt: string | null
  /** True when the check is off (env) or cannot run (airgapped, `dev` build). */
  readonly checkDisabled: boolean
}

let latest: string | null = null
let checkedAt: string | null = null

/**
 * Parse `1.2.3` / `v1.2.3` into comparable parts. Anything with a prerelease or
 * build suffix (`1.2.3-rc.1`, `1.2.3+sha`) is rejected: those must never be
 * offered as "latest" to a self-hoster who did not opt into them.
 */
const parseSemver = (raw: string): readonly [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const
}

/**
 * Is `a` newer than `b`? Component-wise, NOT lexicographic — as strings
 * `"0.10.0" < "0.9.0"`, which would silently stop offering updates after the
 * tenth minor release.
 */
export const isNewer = (a: string, b: string): boolean => {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!
  }
  return false
}

/** The newest stable semver tag in a registry tag list, or null if there is none. */
export const newestStable = (tags: ReadonlyArray<string>): string | null => {
  let best: string | null = null
  for (const t of tags) {
    if (!parseSemver(t)) continue // skips `latest`, `edge`, `sha-…`, prereleases
    if (best === null || isNewer(t, best)) best = t
  }
  return best
}

/**
 * Page-following backstop. 100 tags/page, so this is 5000 tags.
 *
 * Sized for real churn, not for release count: CI tags every main push with
 * `sha-<long>`, so the tag list grows with COMMITS, not releases, and the semver
 * tags we actually want are scattered through it in insertion order. Hitting
 * this cap warns rather than truncating silently (a silent cap here reads as "no
 * update available", which is indistinguishable from being up to date). If it
 * ever fires, prune old `sha-` tags or stop publishing them per-commit.
 */
const MAX_PAGES = 50

/**
 * Every tag in the repository, following pagination.
 *
 * GHCR requires a bearer token even for anonymous pulls of a public package: hit
 * the token endpoint with a pull scope, then use it on the v2 API. A 401/403
 * here is the signature of a PRIVATE package — which is also the state in which
 * no self-hoster can pull the image at all.
 *
 * PAGINATION IS NOT OPTIONAL, and this is the trap: GHCR caps a page at 100 tags
 * whatever `n` you ask for, and returns them in INSERTION order — so the newest
 * release is on the LAST page, not the first. Reading one page and stopping
 * looks correct for a young repository and then silently freezes at whatever was
 * tagged around release 100. Verified against a real public package
 * (`astral-sh/uv`): a single `?n=100` reported 0.4.4 when the actual newest was
 * far higher.
 */
const fetchTags = async (): Promise<ReadonlyArray<string>> => {
  const tokenRes = await fetch(
    `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${REPOSITORY}:pull`)}&service=ghcr.io`,
  )
  if (!tokenRes.ok) throw new Error(`ghcr token: ${tokenRes.status}`)
  const { token } = (await tokenRes.json()) as { token?: string }
  if (!token) throw new Error("ghcr token: no token in response")

  const headers = { authorization: `Bearer ${token}`, accept: "application/json" }
  const tags: string[] = []
  let url: string | null = `https://ghcr.io/v2/${REPOSITORY}/tags/list?n=100`
  let page = 0

  while (url && page < MAX_PAGES) {
    const res: Response = await fetch(url, { headers })
    if (!res.ok) {
      // Honour Retry-After via the shared helper rather than hand-rolling the
      // arithmetic — `Number(null)` is 0, which is how five connectors ended up
      // hot-looping a rate-limited provider. See integrations/http.ts.
      const err = new Error(`ghcr tags: ${res.status}`) as Error & { retryAfterMs?: number }
      err.retryAfterMs = retryDelayMs(res, 0)
      throw err
    }
    const body = (await res.json()) as { tags?: ReadonlyArray<string> | null }
    tags.push(...(body.tags ?? []))
    url = nextPageUrl(res.headers.get("link"))
    page++
  }
  // Say so rather than reporting a stale "latest" as if the list were complete.
  if (url) console.warn(`update check: stopped at ${MAX_PAGES} pages of tags; result may be stale`)
  return tags
}

/**
 * Resolve the `rel="next"` target of an RFC 5988 `Link` header against ghcr.io.
 * GHCR sends a path-only URL (`</v2/…/tags/list?last=…&n=0>; rel="next"`), and
 * absence of the header is how the last page announces itself.
 */
export const nextPageUrl = (link: string | null): string | null => {
  if (!link) return null
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())
    if (m?.[1]) return new URL(m[1], "https://ghcr.io").toString()
  }
  return null
}

/** One check. Never throws: an unreachable registry must read as "unknown". */
export const checkForUpdate = async (): Promise<void> => {
  try {
    const found = newestStable(await fetchTags())
    if (found) latest = found
    checkedAt = new Date().toISOString()
  } catch (e) {
    // Airgapped installs are a supported deployment, so a failed check is not an
    // error condition — log once at low volume and leave `latest` as it was.
    console.warn(`update check failed: ${String(e)}`)
  }
}

/** What `/api/version` reports. */
export const versionInfo = (): VersionInfo => ({
  current: CURRENT_VERSION,
  latest,
  // A `dev` checkout has no version to compare, so it never nags.
  updateAvailable: latest !== null && isNewer(latest, CURRENT_VERSION),
  checkedAt,
  checkDisabled: !enabled(),
})

let started = false

/**
 * Start the periodic update check (idempotent). Shaped after
 * `startGoogleWatchRenewal`: one immediate run so a fresh boot has an answer,
 * then an unref'd interval so it never holds the event loop open at shutdown.
 */
export const startUpdateCheck = (): void => {
  if (started || !enabled()) return
  started = true
  void checkForUpdate()
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS).unref()
}
