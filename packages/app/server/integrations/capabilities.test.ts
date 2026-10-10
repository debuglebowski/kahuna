import { describe, expect, it } from "vitest"
import {
  defaultCapabilityIds,
  expandCapabilities,
  GOOGLE_CAPABILITIES,
  GOOGLE_SCOPES,
  hasCapability,
  INTEGRATION_CAPABILITIES,
  resolveCapabilityIds,
  scopesFor,
} from "./capabilities"

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
    expect(expandCapabilities(GOOGLE_CAPABILITIES, ["gmail.read", "nope"])).toEqual([
      "gmail.metadata",
      "gmail.read",
    ])
    expect(scopesFor(GOOGLE_CAPABILITIES, ["gmail.read"])).toEqual([
      GOOGLE_SCOPES.gmailMetadata,
      GOOGLE_SCOPES.gmailReadonly,
    ])
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
    expect(hasCapability(GOOGLE_CAPABILITIES, GOOGLE_SCOPES.gmailSend, "gmail.send")).toBe(true)
    expect(hasCapability(GOOGLE_CAPABILITIES, GOOGLE_SCOPES.calendarEvents, "gmail.send")).toBe(
      false,
    )
    expect(hasCapability(GOOGLE_CAPABILITIES, null, "calendar")).toBe(false)
    expect(hasCapability(GOOGLE_CAPABILITIES, GOOGLE_SCOPES.gmailSend, "unknown")).toBe(false)
  })
})
