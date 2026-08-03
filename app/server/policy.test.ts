import { describe, expect, it } from "vitest"
import { decide, emptyPolicy } from "#engine"
import { isAdminRole } from "./policy"

/**
 * What `can(role, action)` used to assert, now expressed against the access model
 * that replaced it: members read and write, only owner/admin administer.
 *
 * The point is EQUIVALENCE. `decide()` with no rules must answer exactly what the old
 * function did, because that is what makes the access model a superset of today's
 * behaviour rather than a change to it.
 */

describe("role → default", () => {
  it("owner and admin administer; a member does not", () => {
    expect(isAdminRole("owner")).toBe(true)
    expect(isAdminRole("admin")).toBe(true)
    expect(isAdminRole("member")).toBe(false)
    // Not a rank comparison: an unknown role administers nothing.
    expect(isAdminRole("contractor")).toBe(false)
  })
})

describe("decide() with no rules reproduces can(role, action)", () => {
  // The fallback the RPC gate computes from the role — mirrors `requireAction`.
  const fallbackFor = (role: string, action: "view" | "edit" | "delete" | "configure") =>
    action === "configure" || action === "delete" ? isAdminRole(role) : true

  const allowed = (role: string, action: "view" | "edit" | "delete" | "configure") =>
    decide(emptyPolicy("u"), action, { type: "org" }, fallbackFor(role, action), {
      unconditionalOnly: true,
    })

  it("a member reads and edits, but cannot configure or delete", () => {
    expect(allowed("member", "view")).toBe(true)
    expect(allowed("member", "edit")).toBe(true)
    expect(allowed("member", "configure")).toBe(false)
    // Hard-delete was already admin-only at the RPC boundary before this model.
    expect(allowed("member", "delete")).toBe(false)
  })

  it("an admin and an owner can do all four", () => {
    for (const role of ["admin", "owner"]) {
      expect(allowed(role, "view")).toBe(true)
      expect(allowed(role, "edit")).toBe(true)
      expect(allowed(role, "configure")).toBe(true)
      expect(allowed(role, "delete")).toBe(true)
    }
  })
})
