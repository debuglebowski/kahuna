import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OrgContext } from "#engine"
import { type AfterHookContext, auditAuthResponse } from "./authAudit"
import { instrumentHandler } from "./rpcAudit"
import {
  clientIp,
  routeOf,
  securityEvent,
  setSecurityLogSink,
  subjectRef,
  webhookRejected,
} from "./securityLog"

const lines: string[] = []
const events = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>)

beforeEach(() => {
  lines.length = 0
  setSecurityLogSink((l) => lines.push(l))
})
afterEach(() => setSecurityLogSink())

describe("securityEvent format", () => {
  it("writes ONE line of JSON with the fixed envelope", () => {
    securityEvent({ event: "auth.signin", outcome: "success", actor: "u1", orgId: "o1" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("\n")
    const e = events()[0]!
    expect(e).toMatchObject({
      type: "security",
      level: "info",
      service: "kahuna",
      event: "auth.signin",
      outcome: "success",
      actor: "u1",
      orgId: "o1",
    })
    expect(new Date(e.ts as string).toISOString()).toBe(e.ts)
  })

  it("warns for failure and denied, and omits unset fields", () => {
    securityEvent({ event: "authz.denied", outcome: "denied" })
    securityEvent({ event: "auth.signin", outcome: "failure", reason: null, actor: undefined })
    expect(events().map((e) => e.level)).toEqual(["warn", "warn"])
    expect(Object.keys(events()[1]!)).not.toContain("actor")
    expect(Object.keys(events()[1]!)).not.toContain("reason")
  })

  it("cannot be split into a second line by hostile input", () => {
    securityEvent({
      event: "x",
      outcome: "failure",
      reason: 'a"\n{"type":"security","event":"forged"}',
    })
    expect(lines).toHaveLength(1)
    expect(events()[0]!.event).toBe("x")
  })

  it("drops sensitive-looking detail keys and clips long values", () => {
    securityEvent({
      event: "x",
      outcome: "success",
      detail: {
        password: "hunter2",
        accessToken: "t",
        clientSecret: "s",
        messageText: "hello",
        email: "a@b.c",
        requestBody: "{}",
        apiKey: "k",
        role: "owner",
        count: 3,
        long: "y".repeat(500),
      },
    })
    const d = events()[0]!.detail as Record<string, unknown>
    expect(Object.keys(d).sort()).toEqual(["count", "long", "role"])
    expect((d.long as string).length).toBeLessThan(250)
    expect(lines[0]).not.toMatch(/hunter2|a@b\.c/)
  })

  it("never throws, even if the sink does", () => {
    setSecurityLogSink(() => {
      throw new Error("pipe closed")
    })
    expect(() => securityEvent({ event: "x", outcome: "success" })).not.toThrow()
  })
})

describe("identifiers", () => {
  // The full matrix (hops, ports, junk) is in clientIp.test.ts.
  it("logs the address the proxy appended, never the one the client sent", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.4" }))).toBe(
      "198.51.100.4",
    )
    expect(clientIp(new Headers({ "x-forwarded-for": 'evil", "x":"y' }))).toBeNull()
    expect(clientIp(undefined)).toBeNull()
  })

  it("references an email by keyed hash: stable, case-insensitive, not the address", () => {
    const a = subjectRef("Person@Example.com ")
    expect(a).toBe(subjectRef("person@example.com"))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(subjectRef("other@example.com"))
  })

  it("strips the query string from a route", () => {
    expect(routeOf(new Request("http://x.test/api/a/b?token=SECRET&code=1"))).toBe("GET /api/a/b")
  })

  it("webhookRejected logs connector + reason, never the presented token", async () => {
    const res = webhookRejected(
      "linear",
      new Request("http://x.test/api/integrations/linear/webhook?token=SECRET", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.4", authorization: "Bearer SECRET" },
      }),
      "BAD_TOKEN",
      403,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "BAD_TOKEN" })
    expect(events()[0]).toMatchObject({
      event: "webhook.rejected",
      outcome: "denied",
      targetId: "linear",
      reason: "BAD_TOKEN",
      ip: "198.51.100.4",
      route: "POST /api/integrations/linear/webhook",
    })
    expect(lines[0]).not.toContain("SECRET")
  })
})

const apiError = (statusCode: number, code: string) => ({ statusCode, body: { code } })
const ctx = (over: Partial<AfterHookContext> & { path: string }): AfterHookContext => ({
  context: {},
  ...over,
})

describe("BetterAuth after-hook mapping", () => {
  it("password sign-in success carries the user and active org", () => {
    auditAuthResponse(
      ctx({
        path: "/sign-in/email",
        body: { email: "a@b.c", password: "pw" },
        context: { newSession: { user: { id: "u1" }, session: { activeOrganizationId: "o1" } } },
      }),
    )
    expect(events()[0]).toMatchObject({
      event: "auth.signin",
      outcome: "success",
      actor: "u1",
      orgId: "o1",
      detail: { method: "password" },
    })
    expect(lines[0]).not.toMatch(/a@b\.c|"pw"|"password":/)
  })

  it("password sign-in failure logs the reason and a subjectRef, not the address", () => {
    auditAuthResponse(
      ctx({
        path: "/sign-in/email",
        headers: new Headers({ "x-forwarded-for": "192.0.2.7" }),
        body: { email: "victim@example.com", password: "guess" },
        context: { returned: apiError(401, "INVALID_EMAIL_OR_PASSWORD") },
      }),
    )
    const e = events()[0]!
    expect(e).toMatchObject({
      event: "auth.signin",
      outcome: "failure",
      reason: "INVALID_EMAIL_OR_PASSWORD",
      ip: "192.0.2.7",
      subjectRef: subjectRef("victim@example.com"),
    })
    expect(lines[0]).not.toMatch(/victim|guess/)
  })

  it("SSO callback: a minted session is a sign-in, no session is a failure with the IdP error code", () => {
    auditAuthResponse(
      ctx({
        path: "/sso/callback/:providerId",
        context: { newSession: { user: { id: "u2" } } },
      }),
    )
    auditAuthResponse(
      ctx({
        path: "/sso/callback/:providerId",
        context: {
          returned: { statusCode: 302 },
          responseHeaders: new Headers({ location: "/login?error=account_not_linked&x=1" }),
        },
      }),
    )
    expect(events()[0]).toMatchObject({
      outcome: "success",
      actor: "u2",
      detail: { method: "sso" },
    })
    expect(events()[1]).toMatchObject({ outcome: "failure", reason: "account_not_linked" })
  })

  it("sign-out, password change and account deletion", () => {
    auditAuthResponse(ctx({ path: "/sign-out", context: { session: { user: { id: "u1" } } } }))
    auditAuthResponse(
      ctx({
        path: "/change-password",
        body: { currentPassword: "old", newPassword: "new" },
        context: { session: { user: { id: "u1" } } },
      }),
    )
    auditAuthResponse(
      ctx({
        path: "/delete-user",
        context: { session: { user: { id: "u1" } }, returned: apiError(400, "SESSION_EXPIRED") },
      }),
    )
    expect(events().map((e) => [e.event, e.outcome])).toEqual([
      ["auth.signout", "success"],
      ["auth.password.change_password", "success"],
      ["account.deleted", "failure"],
    ])
    expect(lines.join("")).not.toMatch(/"old"|"new"/)
  })

  it("direct org-membership calls are logged only when they arrive over HTTP", () => {
    const base = {
      path: "/organization/update-member-role",
      body: { memberId: "m1", role: "owner", organizationId: "o1" },
      context: { session: { user: { id: "admin1" } } },
    }
    auditAuthResponse(ctx(base)) // in-process: our own code logs it with the real actor
    expect(lines).toHaveLength(0)
    auditAuthResponse(ctx({ ...base, request: new Request("http://x.test") }))
    expect(events()[0]).toMatchObject({
      event: "member.role_changed",
      actor: "admin1",
      orgId: "o1",
      targetId: "m1",
      detail: { role: "owner" },
    })
  })

  it("ignores endpoints that are not security events", () => {
    auditAuthResponse(ctx({ path: "/get-session" }))
    expect(lines).toHaveLength(0)
  })
})

describe("RPC audit wrapper", () => {
  const scope = { orgId: "o1", actor: "admin1", role: "member" } as never
  const run = <A, E>(eff: Effect.Effect<A, E, OrgContext>) =>
    Effect.runPromiseExit(eff.pipe(Effect.provide(Layer.succeed(OrgContext, scope))))

  it("logs a successful role change with actor, org and ids — and no payload", async () => {
    const handler = instrumentHandler("assignRole", () => Effect.succeed({ ok: true }) as never)
    await run(handler({ roleId: "r1", userId: "u9", note: "free text" }) as never)
    expect(events()[0]).toMatchObject({
      event: "access.role.assigned",
      outcome: "success",
      actor: "admin1",
      orgId: "o1",
      targetKind: "user",
      targetId: "u9",
      detail: { rpc: "assignRole", roleId: "r1" },
    })
    expect(lines[0]).not.toContain("free text")
  })

  it("logs a schema change with the concept as target", async () => {
    const handler = instrumentHandler("updateConcept", () => Effect.succeed({}) as never)
    await run(handler({ id: "c1", name: "Renamed" }) as never)
    expect(events()[0]).toMatchObject({
      event: "schema.concept.updated",
      targetKind: "concept",
      targetId: "c1",
      detail: { rpc: "updateConcept" },
    })
    expect(lines[0]).not.toContain("Renamed")
  })

  it("does not log a failed change as a success", async () => {
    const handler = instrumentHandler(
      "deleteRole",
      () => Effect.fail({ code: "NOT_FOUND" }) as never,
    )
    await run(handler({ id: "r1" }) as never)
    expect(lines).toHaveLength(0)
  })

  it("logs authz.denied for ANY rpc that fails FORBIDDEN, and passes the error through", async () => {
    const handler = instrumentHandler(
      "createConcept",
      () => Effect.fail({ code: "FORBIDDEN" }) as never,
    )
    const exit = await run(handler({ name: "Secret concept name" }) as never)
    expect(exit._tag).toBe("Failure")
    expect(events()[0]).toMatchObject({
      event: "authz.denied",
      outcome: "denied",
      actor: "admin1",
      reason: "FORBIDDEN",
      detail: { rpc: "createConcept" },
    })
    expect(lines[0]).not.toContain("Secret concept name")
  })

  it("passes non-Effect (streaming) handlers through untouched", () => {
    const stream = { not: "an effect" }
    expect(instrumentHandler("watch", () => stream as never)()).toBe(stream)
  })
})
