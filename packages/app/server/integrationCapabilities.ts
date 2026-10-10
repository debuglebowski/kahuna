import { eq } from "drizzle-orm"
import { orgIntegrationSettings } from "#db"
import { db } from "./db"
import {
  CAPABILITY_INTEGRATIONS,
  type CapabilityIntegration,
  expandCapabilities,
  INTEGRATION_CAPABILITIES,
  isCapabilityIntegration,
  resolveCapabilityIds,
} from "./integrations/capabilities"

/**
 * Per-org capability selection for the OAuth connectors, stored in
 * `org_integration_settings.enabled_capabilities` (`{ google: [...], slack: [...] }`).
 *
 * Absence is meaningful: no row, a NULL column or a missing key all mean "the
 * registry defaults" (least-privilege), so one fallback path serves all three.
 * Read on demand at connect time rather than cached — it is consulted once per
 * OAuth redirect, and a stale cache here would mean consenting to scopes an
 * admin just turned off.
 */

export type EnabledCapabilities = Record<CapabilityIntegration, string[]>
export type CapabilityOverrides = Partial<Record<CapabilityIntegration, string[]>>

const loadStored = async (orgId: string): Promise<CapabilityOverrides> => {
  const [row] = await db
    .select({ enabledCapabilities: orgIntegrationSettings.enabledCapabilities })
    .from(orgIntegrationSettings)
    .where(eq(orgIntegrationSettings.orgId, orgId))
    .limit(1)
  const stored = row?.enabledCapabilities
  if (!stored || typeof stored !== "object") return {}
  const out: CapabilityOverrides = {}
  for (const key of CAPABILITY_INTEGRATIONS) {
    const v = stored[key]
    if (Array.isArray(v)) out[key] = v.filter((x): x is string => typeof x === "string")
  }
  return out
}

/** What the org explicitly chose; integrations it never touched are absent. */
export const readCapabilityOverrides = loadStored

/** The effective capability ids per integration (overrides over registry defaults). */
export const readEnabledCapabilities = async (orgId: string): Promise<EnabledCapabilities> => {
  const stored = await loadStored(orgId)
  const out = {} as EnabledCapabilities
  for (const key of CAPABILITY_INTEGRATIONS) {
    out[key] = resolveCapabilityIds(INTEGRATION_CAPABILITIES[key], stored[key])
  }
  return out
}

export const readEnabledCapabilitiesFor = async (
  orgId: string,
  integration: CapabilityIntegration,
): Promise<string[]> => (await readEnabledCapabilities(orgId))[integration]

/**
 * Validate a `capabilities` patch body: `{ google: ["calendar", …] }` replaces
 * that integration's selection, `{ google: null }` clears it back to the
 * defaults. Returns the next full override map, or the offending field.
 * Implied capabilities are stored expanded, so what is persisted is exactly what
 * gets requested.
 */
export const applyCapabilityPatch = (
  current: CapabilityOverrides,
  patch: unknown,
): { ok: true; next: CapabilityOverrides } | { ok: false; field: string } => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, field: "capabilities" }
  }
  const next: CapabilityOverrides = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!isCapabilityIntegration(key)) return { ok: false, field: `capabilities.${key}` }
    if (value === null) {
      delete next[key]
      continue
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      return { ok: false, field: `capabilities.${key}` }
    }
    const registry = INTEGRATION_CAPABILITIES[key]
    const known = new Set(registry.map((c) => c.id))
    const unknown = value.find((v) => !known.has(v))
    if (unknown !== undefined) return { ok: false, field: `capabilities.${key}.${unknown}` }
    next[key] = expandCapabilities(registry, value)
  }
  return { ok: true, next }
}

export const writeCapabilityOverrides = async (
  orgId: string,
  next: CapabilityOverrides,
): Promise<void> => {
  const value = Object.keys(next).length > 0 ? (next as Record<string, string[]>) : null
  await db
    .insert(orgIntegrationSettings)
    .values({ orgId, enabledCapabilities: value })
    .onConflictDoUpdate({
      target: orgIntegrationSettings.orgId,
      set: { enabledCapabilities: value, updatedAt: new Date() },
    })
}

/** What the settings UI needs to render the toggles generically. */
export const capabilityCatalog = () =>
  Object.fromEntries(
    CAPABILITY_INTEGRATIONS.map((key) => [
      key,
      INTEGRATION_CAPABILITIES[key].map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
        sensitive: c.sensitive,
        defaultEnabled: c.defaultEnabled,
        implies: c.implies ?? [],
      })),
    ]),
  )
