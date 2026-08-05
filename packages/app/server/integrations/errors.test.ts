import { describe, expect, it } from "vitest"
import { publicConnectorError } from "./errors"

/**
 * The point of these is NOT the exact prose — it's that no fragment of the
 * upstream body survives into the returned string. Each case uses a realistic
 * error built the way the connector wrappers build them
 * (`${Provider} API ${status}: ${await res.text()}`) and asserts the secret-ish
 * substrings are gone.
 */
describe("publicConnectorError", () => {
  const leaky = [
    {
      name: "PostHog validation body",
      error: Object.assign(
        new Error(
          'PostHog API 400: {"type":"validation_error","detail":"Global variable not found: nope","attr":null}',
        ),
        { status: 400 },
      ),
      secrets: ["validation_error", "Global variable", "nope", "attr"],
    },
    {
      name: "Linear auth body naming an internal host",
      error: Object.assign(
        new Error(
          'Linear API 401: {"error":"unauthorized","hint":"key rotated","node":"linear-internal-7.eu-west-1.rds.local"}',
        ),
        { status: 401 },
      ),
      secrets: ["rds.local", "linear-internal-7", "key rotated", "unauthorized"],
    },
    {
      name: "Slack body with a team id and token fragment",
      error: Object.assign(
        new Error(
          'Slack API 403: {"ok":false,"error":"invalid_auth","team":"T012AB3CD","warning":"xoxb-1234-abcd"}',
        ),
        { status: 403 },
      ),
      secrets: ["T012AB3CD", "xoxb-", "invalid_auth"],
    },
    {
      name: "Apollo 429 with quota detail",
      error: Object.assign(
        new Error('Apollo API 429: {"error":"rate limit","plan":"team-500","credits_remaining":0}'),
        { status: 429 },
      ),
      // NB: not asserting on "rate limit" — that phrase legitimately appears in
      // our own 429 text. The leak-worthy parts are the plan and credit balance.
      secrets: ["team-500", "credits_remaining"],
    },
    {
      name: "provider 500 with a stack-ish body",
      error: Object.assign(new Error("Google API 503: upstream connect error at 10.4.2.9:8080"), {
        status: 503,
      }),
      secrets: ["10.4.2.9", "8080", "upstream connect"],
    },
  ]

  for (const { name, error, secrets } of leaky) {
    it(`strips the upstream body: ${name}`, () => {
      const out = publicConnectorError(error)
      for (const secret of secrets) {
        expect(out).not.toContain(secret)
      }
      // Still says something useful.
      expect(out.length).toBeGreaterThan(10)
    })
  }

  it("maps status classes to actionable text", () => {
    const at = (status: number, provider = "Linear") =>
      publicConnectorError(Object.assign(new Error(`${provider} API ${status}: body`), { status }))
    expect(at(401)).toMatch(/credentials/i)
    expect(at(403)).toMatch(/credentials/i)
    expect(at(404)).toMatch(/could not find/i)
    expect(at(429)).toMatch(/rate limit/i)
    expect(at(503)).toMatch(/unavailable/i)
    expect(at(418)).toMatch(/rejected the request/i)
  })

  it("names the provider so the message is actionable", () => {
    const out = publicConnectorError(
      Object.assign(new Error("Slack API 401: nope"), { status: 401 }),
    )
    expect(out).toContain("Slack")
  })

  it("handles a network error with no status and no provider", () => {
    // A DNS/TLS/timeout failure: `String(error)` here could carry an internal
    // hostname, so the fallback must not echo the message either.
    const out = publicConnectorError(new Error("getaddrinfo ENOTFOUND internal-db.corp.local"))
    expect(out).not.toContain("internal-db.corp.local")
    expect(out).not.toContain("ENOTFOUND")
    expect(out).toMatch(/could not reach/i)
  })

  it("does not throw on a non-Error value", () => {
    expect(() => publicConnectorError("just a string")).not.toThrow()
    expect(() => publicConnectorError(null)).not.toThrow()
    expect(() => publicConnectorError(undefined)).not.toThrow()
  })
})
