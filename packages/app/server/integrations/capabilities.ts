/**
 * Capability registries for the OAuth connectors (google, slack).
 *
 * A capability is what the app may DO as the connected person ("send mail"), and
 * it owns the provider scopes that grant it. The consent screen is built from the
 * capabilities an org has enabled — never from a hard-coded scope list — so the
 * default consent is the least-privilege one and a broader scope is always an
 * explicit, audited org decision.
 *
 * Rules a registry must keep (asserted in capabilities.test.ts):
 *  - a `sensitive` capability is never `defaultEnabled` — reading mail bodies or
 *    acting as the user is opt-in;
 *  - every scope belongs to exactly one capability's `scopes`; `implies` pulls in
 *    another capability instead of repeating its scope.
 *
 * Pure data + helpers: no DB, no connector import, so `integrationSettings` and
 * the connectors can both depend on it.
 */

export interface Capability {
  readonly id: string
  readonly label: string
  /** What turning it on lets the app do — shown next to the toggle. */
  readonly description: string
  readonly scopes: readonly string[]
  /** Reads other people's data or acts as the user. Must default to off. */
  readonly sensitive: boolean
  readonly defaultEnabled: boolean
  /** Capabilities that must be on whenever this one is (e.g. read ⇒ metadata). */
  readonly implies?: readonly string[]
}

export type CapabilityRegistry = readonly Capability[]

export const GOOGLE_SCOPES = {
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  calendarFreebusy: "https://www.googleapis.com/auth/calendar.freebusy",
  gmailMetadata: "https://www.googleapis.com/auth/gmail.metadata",
  gmailLabels: "https://www.googleapis.com/auth/gmail.labels",
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
} as const

/**
 * GMAIL IS DISABLED. None of these is in `GOOGLE_CAPABILITIES`, which is the only
 * thing that decides what scopes are requested, what an org can select, and what
 * counts as granted. With no registry entry an id is unknown everywhere: connect
 * never asks for a Gmail scope, the settings API refuses it, and `hasCapability`
 * is false even for a connection whose token still carries the scope.
 *
 * The definitions stay so the Gmail code paths in `google.ts` keep a home, but
 * moving them back into the registry is NOT enough to turn Gmail on. As built, the
 * Gmail mirror copies every thread of a mailbox (including bodies, snippets and the
 * raw API response) into tables and an org-wide record concept, with no owner-only
 * visibility, no exclusions and no redaction. Do not re-enable it before those
 * exist and are tested. See docs/google-integration.md.
 */
export const GMAIL_CAPABILITIES_DISABLED: CapabilityRegistry = [
  {
    id: "gmail.metadata",
    label: "Gmail metadata",
    description:
      "Sync email headers (sender, recipients, subject, date, labels). Message bodies are not readable.",
    scopes: [GOOGLE_SCOPES.gmailMetadata],
    sensitive: true,
    defaultEnabled: false,
  },
  {
    id: "gmail.read",
    label: "Gmail read",
    description: "Read full email bodies and search mail. Includes Gmail metadata.",
    scopes: [GOOGLE_SCOPES.gmailReadonly],
    sensitive: true,
    defaultEnabled: false,
    implies: ["gmail.metadata"],
  },
  {
    id: "gmail.send",
    label: "Gmail send",
    description: "Send email as the connected user.",
    scopes: [GOOGLE_SCOPES.gmailSend],
    sensitive: true,
    defaultEnabled: false,
  },
]

export const GOOGLE_CAPABILITIES: CapabilityRegistry = [
  {
    id: "calendar",
    label: "Calendar",
    description: "Sync calendar events and create or update events.",
    scopes: [GOOGLE_SCOPES.calendarEvents],
    sensitive: false,
    defaultEnabled: true,
  },
]

/**
 * Whether Gmail is switched on: true only if a `gmail.*` capability is in the
 * registry. Derived rather than stored, so there is no flag that can disagree with
 * the registry. `google.ts` gates every Gmail entry point on this, including the one
 * transport function every Google request passes through.
 */
export const gmailEnabled = (): boolean =>
  GOOGLE_CAPABILITIES.some((c) => c.id.startsWith("gmail."))

/** Slack USER-token (xoxp) scopes. Bot scopes are fixed by the app manifest. */
export const SLACK_USER_CAPABILITIES: CapabilityRegistry = [
  {
    id: "chat.write",
    label: "Post as user",
    description: "Post messages to Slack as the connected user.",
    scopes: ["chat:write"],
    sensitive: false,
    defaultEnabled: true,
  },
]

export const INTEGRATION_CAPABILITIES = {
  google: GOOGLE_CAPABILITIES,
  slack: SLACK_USER_CAPABILITIES,
} as const

export type CapabilityIntegration = keyof typeof INTEGRATION_CAPABILITIES

export const CAPABILITY_INTEGRATIONS = Object.keys(
  INTEGRATION_CAPABILITIES,
) as CapabilityIntegration[]

export const isCapabilityIntegration = (v: string): v is CapabilityIntegration =>
  Object.hasOwn(INTEGRATION_CAPABILITIES, v)

/** Add everything `ids` imply; drop unknown ids. Result is in registry order. */
export const expandCapabilities = (
  registry: CapabilityRegistry,
  ids: Iterable<string>,
): string[] => {
  const byId = new Map(registry.map((c) => [c.id, c]))
  const out = new Set<string>()
  const visit = (id: string) => {
    const cap = byId.get(id)
    if (!cap || out.has(id)) return
    out.add(id)
    for (const implied of cap.implies ?? []) visit(implied)
  }
  for (const id of ids) visit(id)
  return registry.filter((c) => out.has(c.id)).map((c) => c.id)
}

export const defaultCapabilityIds = (registry: CapabilityRegistry): string[] =>
  expandCapabilities(
    registry,
    registry.filter((c) => c.defaultEnabled).map((c) => c.id),
  )

/** The org's stored selection, or the registry defaults when it never chose. */
export const resolveCapabilityIds = (
  registry: CapabilityRegistry,
  stored: readonly string[] | null | undefined,
): string[] => (stored ? expandCapabilities(registry, stored) : defaultCapabilityIds(registry))

/** The provider scopes to request for `ids` — the union, de-duplicated. */
export const scopesFor = (registry: CapabilityRegistry, ids: Iterable<string>): string[] => {
  const enabled = new Set(expandCapabilities(registry, ids))
  return [...new Set(registry.filter((c) => enabled.has(c.id)).flatMap((c) => c.scopes))]
}

/** Provider scope strings are space- (Google) or comma- (Slack) separated. */
export const splitGrantedScopes = (text: string | null | undefined): string[] =>
  (text ?? "").split(/[\s,]+/).filter(Boolean)

/** Whether a connection was actually GRANTED every scope of capability `id`. */
export const hasCapability = (
  registry: CapabilityRegistry,
  grantedScopes: string | null | undefined,
  id: string,
): boolean => {
  const cap = registry.find((c) => c.id === id)
  if (!cap) return false
  const granted = new Set(splitGrantedScopes(grantedScopes))
  return cap.scopes.every((s) => granted.has(s))
}
