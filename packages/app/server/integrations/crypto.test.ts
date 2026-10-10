import { afterEach, describe, expect, it } from "vitest"
import { decryptToken, encryptToken } from "./crypto"

const KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

describe("encryption key", () => {
  const saved = process.env.INTEGRATION_ENCRYPTION_KEY
  afterEach(() => {
    if (saved === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY
    else process.env.INTEGRATION_ENCRYPTION_KEY = saved
  })

  it("throws when unset, in every environment — no derived fallback", () => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY
    process.env.BETTER_AUTH_SECRET = "a-perfectly-real-looking-secret-0123456789"
    expect(() => encryptToken("x")).toThrow(/INTEGRATION_ENCRYPTION_KEY must be set/)
  })

  it("throws when malformed", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = "too-short"
    expect(() => encryptToken("x")).toThrow(/malformed/)
  })

  it("round-trips with a valid key", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY
    expect(decryptToken(encryptToken("secret"))).toBe("secret")
  })
})
