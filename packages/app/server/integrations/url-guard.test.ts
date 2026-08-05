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

  const withAllowed = (hosts: string, fn: () => void): void => {
    const old = process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS
    process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS = hosts
    try {
      fn()
    } finally {
      if (old === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS
      else process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS = old
    }
  }

  it("permits a host the operator allowlisted", () => {
    // Only forms the SHAPE check is decisive about: literal IPs and `.local`.
    // A bare `http://n8n:5678` passes this check listed or not — nothing textual
    // says where `n8n` points, so it is DNS that decides. See the resolve suite.
    expect(() => assertPublicUrlShape("http://n8n:5678/hook")).not.toThrow()

    withAllowed("10.0.0.5,[fd00::1],nas.local", () => {
      expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).not.toThrow()
      expect(() => assertPublicUrlShape("http://[fd00::1]/hook")).not.toThrow()
      expect(() => assertPublicUrlShape("http://nas.local/hook")).not.toThrow()
    })
  })

  it("permits ONLY the listed host, not the rest of its network", () => {
    // The whole point of the allowlist over the old blanket flag: needing one
    // internal target must not open every other service on the same network.
    withAllowed("10.0.0.5", () => {
      expect(() => assertPublicUrlShape("http://10.0.0.6/hook")).toThrow(UnsafeUrlError)
      expect(() => assertPublicUrlShape("http://192.168.1.1/hook")).toThrow(UnsafeUrlError)
      expect(() => assertPublicUrlShape("http://[fd00::1]/hook")).toThrow(UnsafeUrlError)
    })
  })

  it("refuses metadata and loopback even when they are allowlisted", () => {
    // Listing these is either a mistake or an attempt to launder a pivot through
    // a deploy variable. Metadata vends IAM credentials for the whole cloud
    // account; loopback is the container's own internal-only surface.
    withAllowed("169.254.169.254,127.0.0.1,localhost,[::1],0.0.0.0,[fd00:ec2::254]", () => {
      for (const url of [
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://[::ffff:169.254.169.254]/", // normalized to ::ffff:a9fe:a9fe
        "http://169.254.0.1/", // rest of link-local goes with it
        "http://[fd00:ec2::254]/", // IPv6-only EC2
        "http://127.0.0.1:5678/hook",
        "http://localhost:3100/hook",
        "http://[::1]/",
        "http://0.0.0.0/",
      ]) {
        expect(() => assertPublicUrlShape(url)).toThrow(UnsafeUrlError)
      }
    })
  })

  it("tolerates a scheme, port or path on an allowlist entry", () => {
    // A mis-typed entry fails closed and silently, so the forgiving parse is
    // what keeps the operator from debugging a guard that looks simply broken.
    // Asserted on `.local` and a literal IP because those are the forms the
    // shape check actually gates — a bare hostname would pass either way.
    for (const entry of [
      "http://nas.local:8080/hook",
      "nas.local:8080",
      " NAS.LOCAL ",
      "nas.local/",
    ]) {
      withAllowed(entry, () => {
        expect(() => assertPublicUrlShape("http://nas.local/hook")).not.toThrow()
      })
    }
    for (const entry of ["http://10.0.0.5:8080/", "10.0.0.5:8080", " 10.0.0.5 "]) {
      withAllowed(entry, () => {
        expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).not.toThrow()
      })
    }
    // The trailing `:1` of a bare IPv6 entry is not a port.
    withAllowed("fd00::1", () => {
      expect(() => assertPublicUrlShape("http://[fd00::1]/hook")).not.toThrow()
    })
  })

  it("treats an empty or unset allowlist as allowing nothing", () => {
    for (const value of ["", " ", ",", ",,"]) {
      withAllowed(value, () => {
        expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).toThrow(UnsafeUrlError)
      })
    }
    expect(() => assertPublicUrlShape("http://10.0.0.5/hook")).toThrow(UnsafeUrlError)
  })
})

describe("url-guard DNS resolution", () => {
  it("refuses a public hostname that resolves to loopback", async () => {
    // The case a textual check CANNOT catch, and the reason the send-time guard
    // resolves rather than trusting the string.
    await expect(resolvePublicUrl("http://localtest.me/hook")).rejects.toThrow(UnsafeUrlError)
  })

  it("still resolves an allowlisted hostname, and refuses where it lands", async () => {
    // Allowlisting a NAME must not become "skip DNS": the listed host is exactly
    // the one worth repointing, and loopback stays refused however it is reached.
    // Address-level assertions too, because no stable public hostname resolves to
    // 169.254.169.254 for the metadata half of this.
    expect(isMetadataAddress("169.254.169.254")).toBe(true)
    expect(isMetadataAddress("::ffff:a9fe:a9fe")).toBe(true)
    expect(isMetadataAddress("fd00:ec2::254")).toBe(true)
    expect(isMetadataAddress("10.0.0.5")).toBe(false)
    expect(isMetadataAddress("8.8.8.8")).toBe(false)

    const old = process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS
    process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS = "localtest.me"
    try {
      // A public name whose A record is 127.0.0.1. Listed by the operator and
      // still refused — the old blanket flag permitted exactly this.
      await expect(resolvePublicUrl("http://localtest.me/hook")).rejects.toThrow(UnsafeUrlError)
    } finally {
      if (old === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS
      else process.env.AUTOMATION_WEBHOOK_ALLOW_HOSTS = old
    }
  })

  it("allows a genuinely public hostname and pins its address", async () => {
    const { address } = await resolvePublicUrl("https://example.com/hook")
    expect(address).toBeTruthy()
    expect(isBlockedAddress(address)).toBe(false)
  })
})
