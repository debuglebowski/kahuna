import { describe, expect, it } from "vitest"
import { can } from "./policy"

describe("can(role, action)", () => {
  it("members read/write; only owner/admin administer", () => {
    expect(can("member", "read")).toBe(true)
    expect(can("member", "write")).toBe(true)
    expect(can("member", "admin")).toBe(false)
    expect(can("admin", "write")).toBe(true)
    expect(can("admin", "admin")).toBe(true)
    expect(can("owner", "admin")).toBe(true)
  })
})
