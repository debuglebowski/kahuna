import { eq } from "drizzle-orm"
import { orgIntegrationSettings } from "#db"
import { db } from "./db"
import { isAdminRole } from "./policy"
import { resolveAdmin, resolveOrg } from "./session"

/**
 * Per-org integration settings, with the env vars demoted to DEPLOYMENT
 * DEFAULTS.
 *
 * These eight knobs used to be env-only, which meant a redeploy to change one,
 * every org changing at once, and no audit trail. They now resolve as:
 *
 *     effective = org row column (if non-NULL) ?? process.env default
 *
 * This module is the single fallback path. It imports no connector, and no
 * connector reads `process.env` for these vars any more — if you find one that
 * does, it is a bug, not a shortcut.
 *
 * STALENESS: the org row is memoized for 30s (see CACHE_MS). A write from THIS
 * process is instant, because `writeIntegrationSettings` drops the entry. With
 * more than one app replica, another replica can serve the old value for up to
 * 30s. That is fine for operational toggles; if it ever isn't, the `km_events`
 * LISTEN hub in `stream.ts` is where a cross-process invalidation would hang.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** Fully resolved — every field has a value, nothing is null. */
export interface IntegrationSettings {
  readonly googleSyncEnabled: boolean
  readonly googleWatchEnabled: boolean
  readonly slackSyncEnabled: boolean
  readonly posthogSyncEnabled: boolean
  readonly linearSyncEnabled: boolean
  readonly apolloEnrichCacheEnabled: boolean
  readonly apolloEnrichCacheTtlDays: number
  readonly analyticsCacheTtlMs: number
}

/** What the org row holds: the same keys, but NULL means "inherit the default". */
export type IntegrationOverrides = {
  readonly [K in keyof IntegrationSettings]: IntegrationSettings[K] | null
}

type OverridePatch = { -readonly [K in keyof IntegrationOverrides]?: IntegrationOverrides[K] }

// ── env parsing ───────────────────────────────────────────────────────────────

/** Default ON: only the literal "0" disables. Five of the six booleans. */
const boolOn = (v: string | undefined): boolean => v !== "0"

/**
 * Default OFF: only the literal "1" enables. `GOOGLE_WATCH_ENABLED` ONLY.
 *
 * Deliberately a second named helper rather than a `parseBool(v, {defaultOn})`
 * parameter. Watch renewal is opt-in and every other toggle is opt-out, so the
 * two differ by one character at the call site — a shared helper is exactly
 * where that gets flipped by accident.
 */
const boolOff = (v: string | undefined): boolean => v === "1"

/**
 * A numeric env var, or `fallback` when unset/blank/non-numeric/below `min`.
 *
 * The `Number.isFinite` guard is not decoration: `analytics.ts` used to do
 * `Number(process.env.ANALYTICS_CACHE_TTL_MS ?? 60_000)`, so a typo produced
 * `NaN`, every `elapsed < NaN` compared false, and the cache was silently and
 * permanently off. A bad value must fall back, not disable the feature.
 */
const num = (v: string | undefined, fallback: number, min: number): number => {
  if (v === undefined || v.trim() === "") return fallback
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** Lower bounds, shared by env parsing, write validation, and read clamping. */
const MIN_APOLLO_TTL_DAYS = 1
/** 0 is legitimate — it means "don't cache analytics at all". */
const MIN_ANALYTICS_TTL_MS = 0

/**
 * What an org with no row (or a row of all NULLs) gets.
 *
 * Read from `process.env` on EVERY call, never memoized at module load. Two
 * things depend on that: an operator's env change takes effect on the next
 * request, and the connector test suites suppress network sync by setting
 * `*_SYNC_ENABLED = "0"` in `beforeEach` — which only works because the memo
 * below caches the org ROW and not the resolved values. Freezing this would
 * turn the whole integration suite into a live-network suite.
 */
export const deploymentDefaults = (): IntegrationSettings => ({
  googleSyncEnabled: boolOn(process.env.GOOGLE_SYNC_ENABLED),
  googleWatchEnabled: boolOff(process.env.GOOGLE_WATCH_ENABLED),
  slackSyncEnabled: boolOn(process.env.SLACK_SYNC_ENABLED),
  posthogSyncEnabled: boolOn(process.env.POSTHOG_SYNC_ENABLED),
  linearSyncEnabled: boolOn(process.env.LINEAR_SYNC_ENABLED),
  apolloEnrichCacheEnabled: boolOn(process.env.APOLLO_ENRICH_CACHE_ENABLED),
  apolloEnrichCacheTtlDays: num(process.env.APOLLO_ENRICH_CACHE_TTL_DAYS, 30, MIN_APOLLO_TTL_DAYS),
  analyticsCacheTtlMs: num(process.env.ANALYTICS_CACHE_TTL_MS, 60_000, MIN_ANALYTICS_TTL_MS),
})

// ── row cache ─────────────────────────────────────────────────────────────────

const CACHE_MS = 30_000
const cache = new Map<string, { at: number; row: IntegrationOverrides | null }>()

export const clearIntegrationSettingsCacheForTest = (): void => cache.clear()

const loadOverrides = async (orgId: string): Promise<IntegrationOverrides | null> => {
  const [row] = await db
    .select({
      googleSyncEnabled: orgIntegrationSettings.googleSyncEnabled,
      googleWatchEnabled: orgIntegrationSettings.googleWatchEnabled,
      slackSyncEnabled: orgIntegrationSettings.slackSyncEnabled,
      posthogSyncEnabled: orgIntegrationSettings.posthogSyncEnabled,
      linearSyncEnabled: orgIntegrationSettings.linearSyncEnabled,
      apolloEnrichCacheEnabled: orgIntegrationSettings.apolloEnrichCacheEnabled,
      apolloEnrichCacheTtlDays: orgIntegrationSettings.apolloEnrichCacheTtlDays,
      analyticsCacheTtlMs: orgIntegrationSettings.analyticsCacheTtlMs,
    })
    .from(orgIntegrationSettings)
    .where(eq(orgIntegrationSettings.orgId, orgId))
    .limit(1)
  return row ?? null
}

/** Cached row lookup. Row ABSENCE is cached too — most orgs never have a row,
 *  and `runAnalyticsQuery` would otherwise hit Postgres on every widget refresh. */
const cachedOverrides = async (orgId: string): Promise<IntegrationOverrides | null> => {
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row
  const row = await loadOverrides(orgId)
  cache.set(orgId, { at: Date.now(), row })
  return row
}

/** Clamp a stored numeric override; out-of-range (hand-edited in psql) inherits. */
const clamped = (v: number | null, min: number): number | null =>
  v !== null && Number.isFinite(v) && v >= min ? v : null

const ALL_NULL: IntegrationOverrides = {
  googleSyncEnabled: null,
  googleWatchEnabled: null,
  slackSyncEnabled: null,
  posthogSyncEnabled: null,
  linearSyncEnabled: null,
  apolloEnrichCacheEnabled: null,
  apolloEnrichCacheTtlDays: null,
  analyticsCacheTtlMs: null,
}

/** The org's raw overrides, for the settings UI. All-NULL when there is no row. */
export const readIntegrationOverrides = async (orgId: string): Promise<IntegrationOverrides> =>
  (await cachedOverrides(orgId)) ?? ALL_NULL

/** The effective settings for an org: overrides layered over the env defaults. */
export const readIntegrationSettings = async (orgId: string): Promise<IntegrationSettings> => {
  const d = deploymentDefaults()
  const row = await cachedOverrides(orgId)
  if (!row) return d
  return {
    googleSyncEnabled: row.googleSyncEnabled ?? d.googleSyncEnabled,
    googleWatchEnabled: row.googleWatchEnabled ?? d.googleWatchEnabled,
    slackSyncEnabled: row.slackSyncEnabled ?? d.slackSyncEnabled,
    posthogSyncEnabled: row.posthogSyncEnabled ?? d.posthogSyncEnabled,
    linearSyncEnabled: row.linearSyncEnabled ?? d.linearSyncEnabled,
    apolloEnrichCacheEnabled: row.apolloEnrichCacheEnabled ?? d.apolloEnrichCacheEnabled,
    apolloEnrichCacheTtlDays:
      clamped(row.apolloEnrichCacheTtlDays, MIN_APOLLO_TTL_DAYS) ?? d.apolloEnrichCacheTtlDays,
    analyticsCacheTtlMs:
      clamped(row.analyticsCacheTtlMs, MIN_ANALYTICS_TTL_MS) ?? d.analyticsCacheTtlMs,
  }
}

/**
 * Upsert the keys present in `patch`, leaving every other column untouched — so
 * saving one integration's card can never disturb another's. An explicit `null`
 * clears that override back to inheriting the deployment default.
 */
export const writeIntegrationSettings = async (
  orgId: string,
  patch: OverridePatch,
): Promise<void> => {
  await db
    .insert(orgIntegrationSettings)
    .values({ orgId, ...patch })
    .onConflictDoUpdate({
      target: orgIntegrationSettings.orgId,
      set: { ...patch, updatedAt: new Date() },
    })
  cache.delete(orgId)
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const BOOLEAN_KEYS = [
  "googleSyncEnabled",
  "googleWatchEnabled",
  "slackSyncEnabled",
  "posthogSyncEnabled",
  "linearSyncEnabled",
  "apolloEnrichCacheEnabled",
] as const

const NUMERIC_KEYS = {
  apolloEnrichCacheTtlDays: MIN_APOLLO_TTL_DAYS,
  analyticsCacheTtlMs: MIN_ANALYTICS_TTL_MS,
} as const

/**
 * GET /api/integrations/settings
 *
 * `resolveOrg`, not `resolveAdmin`: /settings/integrations is member-visible, and
 * a member should see WHY the Sync button is gone rather than a blank card.
 * `defaults` ships alongside so the UI can label each control with what the
 * server would do without an override, from one source of truth.
 */
export const integrationSettingsStatus = async (req: Request): Promise<Response> => {
  const org = await resolveOrg(req)
  if (!org.ok) return json({ error: org.code }, org.status)
  return json({
    effective: await readIntegrationSettings(org.orgId),
    overrides: await readIntegrationOverrides(org.orgId),
    defaults: deploymentDefaults(),
    canEdit: isAdminRole(org.role),
  })
}

/**
 * POST /api/integrations/settings — partial patch.
 *
 * `resolveAdmin`: these are org-wide operational state. Not `resolveOwner` —
 * that is reserved for what decides who can get INTO the org (session.ts), and a
 * sync toggle grants nobody access.
 */
export const updateIntegrationSettings = async (req: Request): Promise<Response> => {
  const org = await resolveAdmin(req)
  if (!org.ok) return json({ error: org.code }, org.status)

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return json({ error: "MISSING_FIELDS" }, 400)

  const patch: OverridePatch = {}

  for (const key of BOOLEAN_KEYS) {
    if (!(key in body)) continue
    const v = body[key]
    if (v !== null && typeof v !== "boolean")
      return json({ error: "INVALID_FIELD", field: key }, 400)
    patch[key] = v
  }

  for (const key of Object.keys(NUMERIC_KEYS) as (keyof typeof NUMERIC_KEYS)[]) {
    if (!(key in body)) continue
    const v = body[key]
    if (v === null) {
      patch[key] = null
      continue
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < NUMERIC_KEYS[key]) {
      return json({ error: "INVALID_VALUE", field: key }, 400)
    }
    patch[key] = v
  }

  if (Object.keys(patch).length === 0) return json({ error: "MISSING_FIELDS" }, 400)

  await writeIntegrationSettings(org.orgId, patch)
  return json({
    effective: await readIntegrationSettings(org.orgId),
    overrides: await readIntegrationOverrides(org.orgId),
  })
}
