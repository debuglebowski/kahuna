import { describe, expect, it } from "vitest"
import {
  defaultCapabilityIds,
  expandCapabilities,
  GMAIL_CAPABILITIES_DISABLED,
  GOOGLE_CAPABILITIES,
  GOOGLE_SCOPES,
  gmailEnabled,
  hasCapability,
  INTEGRATION_CAPABILITIES,
  resolveCapabilityIds,
  scopesFor,
} from "./capabilities"

const GMAIL_SCOPES = [
  GOOGLE_SCOPES.gmailMetadata,
  GOOGLE_SCOPES.gmailLabels,
  GOOGLE_SCOPES.gmailReadonly,
  GOOGLE_SCOPES.gmailSend,
  GOOGLE_SCOPES.gmailCompose,
]

describe("capability registries", () => {
  for (const [name, registry] of Object.entries(INTEGRATION_CAPABILITIES)) {
    describe(name, () => {
      it("never enables a sensitive capability by default", () => {
        for (const cap of registry) {
          if (cap.sensitive) expect(cap.defaultEnabled, cap.id).toBe(false)
        }
      })

      it("owns each scope in exactly one capability", () => {
        const all = registry.flatMap((c) => c.scopes)
        expect(new Set(all).size).toBe(all.length)
      })

      it("only implies capabilities that exist", () => {
        const ids = new Set(registry.map((c) => c.id))
        for (const cap of registry)
          for (const dep of cap.implies ?? []) expect(ids.has(dep)).toBe(true)
      })
    })
  }

  it("defaults Google consent to calendar alone", () => {
    expect(defaultCapabilityIds(GOOGLE_CAPABILITIES)).toEqual(["calendar"])
    expect(scopesFor(GOOGLE_CAPABILITIES, defaultCapabilityIds(GOOGLE_CAPABILITIES))).toEqual([
      GOOGLE_SCOPES.calendarEvents,
    ])
  })

  it("treats a missing selection as the defaults and a stored one as authoritative", () => {
    expect(resolveCapabilityIds(GOOGLE_CAPABILITIES, null)).toEqual(["calendar"])
    expect(resolveCapabilityIds(GOOGLE_CAPABILITIES, undefined)).toEqual(["calendar"])
    expect(resolveCapabilityIds(GOOGLE_CAPABILITIES, [])).toEqual([])
  })

  it("expands implied capabilities and drops unknown ids", () => {
    // Slack's registry has no `implies`; exercise the expansion on a registry that does.
    const registry = [
      { ...GOOGLE_CAPABILITIES[0]!, id: "base", scopes: ["a"] },
      { ...GOOGLE_CAPABILITIES[0]!, id: "top", scopes: ["b"], implies: ["base"] },
    ]
    expect(expandCapabilities(registry, ["top", "nope"])).toEqual(["base", "top"])
    expect(scopesFor(registry, ["top"])).toEqual(["a", "b"])
  })

  describe("Gmail is disabled", () => {
    it("has no Gmail capability in the registry", () => {
      expect(gmailEnabled()).toBe(false)
      expect(GOOGLE_CAPABILITIES.some((c) => c.id.startsWith("gmail."))).toBe(false)
      // Still defined, so moving them back is the one deliberate step to enable.
      expect(GMAIL_CAPABILITIES_DISABLED.map((c) => c.id)).toEqual([
        "gmail.metadata",
        "gmail.read",
        "gmail.send",
      ])
    })

    it("treats every Gmail id as unknown: never expanded, never requested", () => {
      const ids = GMAIL_CAPABILITIES_DISABLED.map((c) => c.id)
      expect(expandCapabilities(GOOGLE_CAPABILITIES, ids)).toEqual([])
      expect(scopesFor(GOOGLE_CAPABILITIES, ids)).toEqual([])
      // A stored selection from before the block cannot bring Gmail back.
      expect(resolveCapabilityIds(GOOGLE_CAPABILITIES, ["calendar", ...ids])).toEqual(["calendar"])
      expect(resolveCapabilityIds(GOOGLE_CAPABILITIES, ids)).toEqual([])
    })

    it("is false even when the token still carries the Gmail scopes", () => {
      for (const cap of GMAIL_CAPABILITIES_DISABLED) {
        expect(hasCapability(GOOGLE_CAPABILITIES, GMAIL_SCOPES.join(" "), cap.id), cap.id).toBe(
          false,
        )
      }
    })

    it("requests no Gmail scope however the registry is read", () => {
      const every = scopesFor(
        GOOGLE_CAPABILITIES,
        GOOGLE_CAPABILITIES.map((c) => c.id),
      )
      for (const scope of GMAIL_SCOPES) expect(every).not.toContain(scope)
    })
  })

  it("never requests the unused scopes", () => {
    const every = scopesFor(
      GOOGLE_CAPABILITIES,
      GOOGLE_CAPABILITIES.map((c) => c.id),
    )
    expect(every).not.toContain(GOOGLE_SCOPES.calendarFreebusy)
    expect(every).not.toContain(GOOGLE_SCOPES.gmailLabels)
    expect(every).not.toContain(GOOGLE_SCOPES.gmailCompose)
  })

  it("checks a GRANT, space- or comma-separated, not the org's intent", () => {
    expect(hasCapability(GOOGLE_CAPABILITIES, GOOGLE_SCOPES.calendarEvents, "calendar")).toBe(true)
    expect(
      hasCapability(GOOGLE_CAPABILITIES, `x,${GOOGLE_SCOPES.calendarEvents} y`, "calendar"),
    ).toBe(true)
    expect(hasCapability(GOOGLE_CAPABILITIES, GOOGLE_SCOPES.gmailSend, "calendar")).toBe(false)
    expect(hasCapability(GOOGLE_CAPABILITIES, null, "calendar")).toBe(false)
    expect(hasCapability(GOOGLE_CAPABILITIES, GOOGLE_SCOPES.calendarEvents, "unknown")).toBe(false)
  })
})
