import { describe, expect, it } from "vitest"
import { __codesForTest, authorizeCli, exchangeCli, loopbackTarget } from "./cli-auth"

/**
 * The browser hand-off gives a live session cookie to whoever the redirect
 * points at, so `loopbackTarget` is the entire security of the flow. Everything
 * that is not a loopback port must be refused — and the refusals are what this
 * file is mostly about.
 */
describe("the redirect target", () => {
  it("accepts an ephemeral loopback port", () => {
    expect(loopbackTarget("49152")).toBe("http://127.0.0.1:49152/callback")
    expect(loopbackTarget("1024")).toBe("http://127.0.0.1:1024/callback")
    expect(loopbackTarget("65535")).toBe("http://127.0.0.1:65535/callback")
  })

  it("REFUSES anything that is not purely a port number", () => {
    // Each of these is an attempt to aim the credential somewhere else.
    for (const attack of [
      "80@evil.com",
      "1234;evil.com",
      "1234/../../evil",
      "1234#@evil.com",
      "1234 ",
      " 1234",
      "0x1234",
      "1e4",
      "+1234",
      "-1234",
      "12_34",
      "evil.com",
      "//evil.com",
      "http://evil.com",
      "",
    ]) {
      expect(loopbackTarget(attack), `"${attack}" must be refused`).toBeNull()
    }
  })

  it("refuses privileged and out-of-range ports", () => {
    expect(loopbackTarget("0")).toBeNull()
    expect(loopbackTarget("80")).toBeNull()
    expect(loopbackTarget("443")).toBeNull()
    expect(loopbackTarget("1023")).toBeNull()
    expect(loopbackTarget("65536")).toBeNull()
    expect(loopbackTarget("999999")).toBeNull()
  })

  it("refuses a missing port", () => {
    expect(loopbackTarget(null)).toBeNull()
  })

  it("never produces a host other than 127.0.0.1", () => {
    // The host is not caller-supplied at all; this pins that it stays that way.
    for (const port of ["1024", "8080", "65535"]) {
      expect(loopbackTarget(port)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    }
  })
})

describe("authorize", () => {
  const get = (query: string) =>
    authorizeCli(new Request(`http://localhost:3100/api/cli/authorize${query}`))

  it("rejects a bad port or state before looking at the session", async () => {
    expect((await get("?port=80&state=abcdefgh")).status).toBe(400)
    expect((await get("?port=49152&state=short")).status).toBe(400)
    expect((await get("?port=49152")).status).toBe(400)
    // A state with characters that would need escaping in a URL is refused
    // rather than escaped, so nothing downstream has to guess an encoding.
    expect((await get("?port=49152&state=abc%20def%3Cscript%3E")).status).toBe(400)
  })

  it("sends an unauthenticated browser to sign in, and comes back here", async () => {
    const res = await get("?port=49152&state=abcdefghij")
    expect(res.status).toBe(302)
    const location = res.headers.get("location") ?? ""
    expect(location.startsWith("/?next=")).toBe(true)
    // The round trip must return to authorize with the SAME port and state, or
    // signing in would strand the CLI waiting forever.
    const next = decodeURIComponent(location.slice("/?next=".length))
    expect(next).toContain("/api/cli/authorize")
    expect(next).toContain("port=49152")
    expect(next).toContain("state=abcdefghij")
  })
})

describe("exchange", () => {
  const post = (body: unknown) =>
    exchangeCli(
      new Request("http://localhost:3100/api/cli/exchange", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    )

  it("refuses an unknown code", async () => {
    const res = await post({ code: "nope", state: "abcdefghij" })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "UNKNOWN_OR_EXPIRED_CODE" })
  })

  it("hands the credential over exactly once", async () => {
    __codesForTest.set("code-1", {
      cookie: "session=abc",
      userId: "u1",
      state: "abcdefghij",
      expiresAt: Date.now() + 60_000,
    })
    const first = await post({ code: "code-1", state: "abcdefghij" })
    expect(await first.json()).toEqual({ cookie: "session=abc", userId: "u1" })
    // Replaying a captured code must get nothing.
    expect((await post({ code: "code-1", state: "abcdefghij" })).status).toBe(400)
  })

  it("BURNS the code on a wrong state, so it cannot be brute-forced", async () => {
    __codesForTest.set("code-2", {
      cookie: "session=abc",
      userId: "u1",
      state: "the-real-state",
      expiresAt: Date.now() + 60_000,
    })
    expect((await post({ code: "code-2", state: "wrong-state!!!" })).status).toBe(400)
    // Even with the right state now, the code is spent.
    expect((await post({ code: "code-2", state: "the-real-state" })).status).toBe(400)
  })

  it("refuses an expired code without waiting for one to expire", async () => {
    __codesForTest.set("code-3", {
      cookie: "session=abc",
      userId: "u1",
      state: "abcdefghij",
      expiresAt: Date.now() - 1,
    })
    expect((await post({ code: "code-3", state: "abcdefghij" })).status).toBe(400)
  })

  it("refuses a request with no code at all", async () => {
    expect((await post({})).status).toBe(400)
  })
})
