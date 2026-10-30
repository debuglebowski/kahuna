import { betterAuth } from "better-auth"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { CLIENT_IP_HEADER, clientIp, withClientIpHeader } from "./clientIp"

/**
 * The client address behind an appending proxy (ACA ingress). The left end of
 * `X-Forwarded-For` is whatever the client sent, so nothing a client writes there
 * may move the rate-limit key or the logged ip. INT-451: a spoofed
 * `X-Forwarded-For: 203.0.113.3` was logged as the client.
 */

const xff = (value: string) => new Headers({ "x-forwarded-for": value })

describe("clientIp", () => {
  it("takes the entry the proxy appended, not the one the client sent", () => {
    expect(clientIp(xff("203.0.113.3, 198.51.100.7"))).toBe("198.51.100.7")
    expect(clientIp(xff("203.0.113.3,198.51.100.7"))).toBe("198.51.100.7")
    expect(clientIp(xff("198.51.100.7"))).toBe("198.51.100.7")
    expect(clientIp(xff("10.0.0.1, 2001:db8::1"))).toBe("2001:db8::1")
  })

  it("counts trusted hops from the right", () => {
    // Client-sent, real client (appended by a CDN), CDN edge (appended by ingress).
    const chain = xff("203.0.113.3, 198.51.100.7, 192.0.2.50")
    expect(clientIp(chain, 2)).toBe("198.51.100.7")
    // Fewer entries than proxies: none of them was written by one we trust.
    expect(clientIp(xff("198.51.100.7"), 2)).toBeNull()
  })

  it("drops a source port some proxies append", () => {
    expect(clientIp(xff("198.51.100.7:51234"))).toBe("198.51.100.7")
    expect(clientIp(xff("[2001:db8::1]:443"))).toBe("2001:db8::1")
  })

  it("rejects anything that isn't an address", () => {
    expect(clientIp(xff('evil", "x":"y'))).toBeNull()
    expect(clientIp(xff("198.51.100.7, "))).toBeNull()
    expect(clientIp(xff("999.1.1.1"))).toBeNull()
    expect(clientIp(new Headers())).toBeNull()
    expect(clientIp(undefined)).toBeNull()
  })

  it("ignores X-Real-IP, which an appending proxy passes through untouched", () => {
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.3" }))).toBeNull()
  })
})

describe("withClientIpHeader", () => {
  it("replaces a client-sent copy of the header with the resolved address", async () => {
    const req = new Request("http://localhost:3100/api/auth/sign-in/email", {
      method: "POST",
      body: "{}",
      headers: { "x-forwarded-for": "203.0.113.3, 198.51.100.7", [CLIENT_IP_HEADER]: "6.6.6.6" },
    })
    const out = withClientIpHeader(req)
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7")
    expect(out.method).toBe("POST")
    expect(await out.text()).toBe("{}")
  })

  it("removes a client-sent copy when no address resolves", () => {
    const req = new Request("http://localhost:3100/api/auth/ok", {
      headers: { [CLIENT_IP_HEADER]: "6.6.6.6" },
    })
    expect(withClientIpHeader(req).headers.has(CLIENT_IP_HEADER)).toBe(false)
  })
})

describe("rate limiting keys on the proxy-appended address", () => {
  // `rateLimit` is off outside production, so the shared `auth` never throttles in
  // tests. This instance takes the REAL `advanced` config from it and turns the
  // limiter on; no database, so it runs on BetterAuth's memory adapter.
  const limited = betterAuth({
    secret: "test-secret-that-is-at-least-32-characters",
    baseURL: "http://localhost:3100",
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: true },
    advanced: auth.options.advanced,
    logger: { disabled: true },
  })

  const badSignIn = (forwardedFor: string) =>
    limited.handler(
      withClientIpHeader(
        new Request("http://localhost:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3100",
            "x-forwarded-for": forwardedFor,
          },
          body: JSON.stringify({ email: "nobody@test.dev", password: "wrong-password" }),
        }),
      ),
    )

  it("a fresh spoofed X-Forwarded-For per attempt still hits the limit", async () => {
    const statuses: number[] = []
    for (let i = 1; i <= 4; i++)
      statuses.push((await badSignIn(`203.0.113.${i}, 198.51.100.21`)).status)
    expect(statuses.slice(0, 3)).not.toContain(429)
    expect(statuses[3]).toBe(429)
  })

  it("one client hitting the limit does not lock out another", async () => {
    for (let i = 0; i < 4; i++) await badSignIn("198.51.100.31")
    expect((await badSignIn("198.51.100.31")).status).toBe(429)
    // Same spoofed left end as the throttled client, different real address.
    expect((await badSignIn("198.51.100.31, 198.51.100.32")).status).not.toBe(429)
  })

  it("the shared instance is configured to read only the server-set header", () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([CLIENT_IP_HEADER])
  })
})
