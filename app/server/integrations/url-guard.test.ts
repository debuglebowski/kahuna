import { describe, expect, it } from "vitest"
import {
  assertPublicUrlShape,
  isBlockedAddress,
  resolvePublicUrl,
  UnsafeUrlError,
} from "./url-guard"

/**
 * SSRF guard for user-supplied webhook URLs. No database, so this suite runs
 * without the dev Postgres. The DNS cases hit real resolvers, hence the two
 * well-known hostnames rather than a mock: `localtest.me` is a public zone whose
 * A record is 127.0.0.1, which is exactly the attack the textual checks cannot
 * see.
 */
describe("url-guard shape checks", () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["loopback", "http://127.0.0.1:5544/"],
    ["localhost", "http://localhost:3100/hook"],
    ["ipv6 loopback", "http://[::1]/"],
    ["private 10/8", "http://10.0.0.5/hook"],
    ["private 172.16/12", "http://172.16.0.1/hook"],
    ["private 192.168/16", "http://192.168.1.1/hook"],
    ["this-host 0/8", "http://0.0.0.0/"],
    ["carrier-grade NAT", "http://100.64.0.1/"],
    ["unique-local v6", "http://[fd00::1]/"],
    ["embedded credentials", "http://user:pass@example.com/"],
    ["file scheme", "file:///etc/passwd"],
    ["gopher scheme", "gopher://example.com/"],
    ["mdns .local", "http://db.local/hook"],
    ["not a url", "not-a-url"],
    // Regression: `new URL()` normalizes this to `::ffff:a9fe:a9fe`, so a
    // dotted-quad-only check let the metadata service straight through.
    ["ipv4-mapped metadata", "http://[::ffff:169.254.169.254]/"],
  ]

  for (const [name, url] of blocked) {
    it(`refuses ${name}`, () => {
      expect(() => assertPublicUrlShape(url)).toThrow(UnsafeUrlError)
    })
  }

  const allowed = [
    "https://hooks.slack.com/services/T000/B000/xxx",
    "http://example.com/hook",
    "https://8.8.8.8/hook",
  ]
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertPublicUrlShape(url)).not.toThrow()
    })
  }

  it("blocks the metadata address directly", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true)
    expect(isBlockedAddress("8.8.8.8")).toBe(false)
  })

  it("honours the explicit self-host escape hatch", () => {
    const old = process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
    process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = "1"
    try {
      expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).not.toThrow()
    } finally {
      if (old === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
      else process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = old
    }
  })
})

describe("url-guard DNS resolution", () => {
  it("refuses a public hostname that resolves to loopback", async () => {
    // The case a textual check CANNOT catch, and the reason the send-time guard
    // resolves rather than trusting the string.
    await expect(resolvePublicUrl("http://localtest.me/hook")).rejects.toThrow(UnsafeUrlError)
  })

  it("allows a genuinely public hostname and pins its address", async () => {
    const { address } = await resolvePublicUrl("https://example.com/hook")
    expect(address).toBeTruthy()
    expect(isBlockedAddress(address)).toBe(false)
  })
})
