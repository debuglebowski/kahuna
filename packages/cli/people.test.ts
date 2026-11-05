import { describe, expect, it } from "vitest"
import { matchMember } from "./people.ts"

const members = [
  { userId: "u-anna", name: "Anna Berg", email: "anna@normain.com" },
  { userId: "u-anders", name: "Anders Lind", email: "anders@normain.com" },
  { userId: "u-bo", name: "Bo", email: "bo@normain.com" },
]

describe("matchMember", () => {
  it("user id, email and full name all resolve to the user id", () => {
    expect(matchMember(members, "u-anna")?.userId).toBe("u-anna")
    expect(matchMember(members, "ANNA@normain.com")?.userId).toBe("u-anna")
    expect(matchMember(members, "anders lind")?.userId).toBe("u-anders")
  })

  it("a unique prefix resolves; an ambiguous one is refused with the candidates", () => {
    expect(matchMember(members, "bo")?.userId).toBe("u-bo")
    expect(matchMember(members, "anne")).toBeNull()
    expect(() => matchMember(members, "an")).toThrow(/matches 2 members/)
  })

  it("an exact match wins over a longer prefix match", () => {
    const withBob = [...members, { userId: "u-bob", name: "Bob", email: "bob@normain.com" }]
    expect(matchMember(withBob, "Bo")?.userId).toBe("u-bo")
  })

  it("nothing matches → null (the caller decides)", () => {
    expect(matchMember(members, "zed@normain.com")).toBeNull()
  })
})
