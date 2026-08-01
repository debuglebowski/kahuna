import { describe, expect, it } from "vitest"
import { isSettingsPath, sectionBaseFor } from "./sectionBase"

describe("sectionBaseFor — dual-mounted sections", () => {
  it("resolves to the top-level path outside settings", () => {
    expect(sectionBaseFor("/members", "members")).toBe("/members")
    expect(sectionBaseFor("/automations", "automations")).toBe("/automations")
  })

  it("resolves to the settings path inside settings", () => {
    // THE point: a self-link built from this keeps the user in settings instead
    // of ejecting them to the top-level page.
    expect(sectionBaseFor("/settings/members", "members")).toBe("/settings/members")
    expect(sectionBaseFor("/settings/automations", "automations")).toBe("/settings/automations")
  })

  it("holds on a detail route, not just the list", () => {
    expect(sectionBaseFor("/members/user-1", "members")).toBe("/members")
    expect(sectionBaseFor("/settings/members/user-1", "members")).toBe("/settings/members")
    expect(sectionBaseFor("/settings/automations/a-1", "automations")).toBe("/settings/automations")
  })

  it("stays top-level on an unrelated page (a dashboard widget reusing the list)", () => {
    // MembersWidget renders MemberDirectory on a dashboard — its rows must link
    // to /members, which the url-derived base gives without threading a prop.
    expect(sectionBaseFor("/", "members")).toBe("/members")
    expect(sectionBaseFor("/dashboards/d-1", "members")).toBe("/members")
  })
})

describe("isSettingsPath", () => {
  it("matches the settings root and its children", () => {
    expect(isSettingsPath("/settings")).toBe(true)
    expect(isSettingsPath("/settings/members")).toBe(true)
    expect(isSettingsPath("/settings/automations/a-1")).toBe(true)
  })

  it("does NOT match a lookalike sibling", () => {
    // A bare startsWith("/settings") would claim these and build broken links.
    expect(isSettingsPath("/settings-export")).toBe(false)
    expect(isSettingsPath("/settingsomething")).toBe(false)
  })

  it("does not match unrelated paths", () => {
    expect(isSettingsPath("/")).toBe(false)
    expect(isSettingsPath("/members")).toBe(false)
    expect(isSettingsPath("/automations/a-1")).toBe(false)
  })
})
