import { describe, expect, it } from "vitest"
import {
  assertPublicUrlShape,
  isBlockedAddress,
  isMetadataAddress,
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

  const withHatch = (fn: () => void): void => {
    const old = process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
    process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = "1"
    try {
      fn()
    } finally {
      if (old === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
      else process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = old
    }
  }

  it("honours the explicit self-host escape hatch", () => {
    withHatch(() => {
      expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).not.toThrow()
      expect(() => assertPublicUrlShape("http://127.0.0.1:5678/hook")).not.toThrow()
      expect(() => assertPublicUrlShape("http://[fd00::1]/hook")).not.toThrow()
    })
  })

  it("still refuses the metadata service under the escape hatch", () => {
    // The hatch is for the operator's own network. This address is not that: it
    // vends IAM credentials for the whole cloud account, and an org admin who can
    // write an automation must not reach it by flipping one deploy variable.
    withHatch(() => {
      for (const url of [
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://[::ffff:169.254.169.254]/", // normalized to ::ffff:a9fe:a9fe
        "http://169.254.0.1/", // rest of link-local goes with it
        "http://[fd00:ec2::254]/", // IPv6-only EC2
      ]) {
        expect(() => assertPublicUrlShape(url)).toThrow(UnsafeUrlError)
      }
    })
  })

  it("does not enable the hatch for anything but an exact 1", () => {
    const old = process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
    for (const value of ["true", "yes", "0", ""]) {
      process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = value
      expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).toThrow(UnsafeUrlError)
    }
    if (old === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
    else process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = old
  })
})

describe("url-guard DNS resolution", () => {
  it("refuses a public hostname that resolves to loopback", async () => {
    // The case a textual check CANNOT catch, and the reason the send-time guard
    // resolves rather than trusting the string.
    await expect(resolvePublicUrl("http://localtest.me/hook")).rejects.toThrow(UnsafeUrlError)
  })

  it("still resolves under the escape hatch, allowing private but not metadata", async () => {
    // The hatch must not become "skip DNS": a hostname pointing at the metadata
    // service is the exact attack this layer exists for, and it works against a
    // deployment that allows its own private network too. Checked at the address
    // level because no stable public hostname resolves to 169.254.169.254.
    expect(isMetadataAddress("169.254.169.254")).toBe(true)
    expect(isMetadataAddress("::ffff:a9fe:a9fe")).toBe(true)
    expect(isMetadataAddress("fd00:ec2::254")).toBe(true)
    expect(isMetadataAddress("10.0.0.5")).toBe(false)
    expect(isMetadataAddress("8.8.8.8")).toBe(false)

    const old = process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
    process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = "1"
    try {
      // Resolves to loopback — refused above, permitted here. Not asserted as
      // 127.0.0.1: `verbatim: true` keeps the resolver's own order, and this host
      // answers ::1 first on a v6-capable machine.
      const { address } = await resolvePublicUrl("http://localtest.me/hook")
      expect(isBlockedAddress(address)).toBe(true)
    } finally {
      if (old === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE
      else process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE = old
    }
  })

  it("allows a genuinely public hostname and pins its address", async () => {
    const { address } = await resolvePublicUrl("https://example.com/hook")
    expect(address).toBeTruthy()
    expect(isBlockedAddress(address)).toBe(false)
  })
})
