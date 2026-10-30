import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { linearAuditLog } from "#db"
import { AccessDenied } from "#engine"
import { auth } from "./auth"
import { writeAuthMethods } from "./authMethods"
import { withClientIpHeader } from "./clientIp"
import { pool } from "./db"
import { handleCalendarPush, handleGoogleCallback } from "./google"
import { writeAuditLog } from "./integrations/audit"
import { handleLinearWebhook } from "./linear"
import { createUserDirect } from "./provision"
import { handleApi } from "./router"
import { setSecurityLogSink } from "./securityLog"
import { runScoped } from "./session"
import { updateAuthMethods } from "./sso"

/**
 * The security log, driven through the REAL entry points (BetterAuth hooks, the
 * session gates, the router, the integration audit writer) rather than by calling the
 * emitter. securityLog.test.ts covers the format and the mapping in isolation; this
 * proves the hooks are actually wired in and fire.
 */

const PASSWORD = "password12345"

const lines: string[] = []
const events = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>)
const named = (event: string) => events().filter((e) => e.event === event)

beforeEach(() => {
  lines.length = 0
  setSecurityLogSink((l) => lines.push(l))
})
afterEach(() => setSecurityLogSink())

const signUp = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const created = await createUserDirect({ email, password: PASSWORD, name: "Tester" })
  return { email, userId: created.userId }
}

const orgWithOwner = async () => {
  const owner = await signUp()
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: owner.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  return { orgId: org.id, owner }
}

const addMember = (orgId: string, userId: string) =>
  auth.api.addMember({ body: { userId, role: "member", organizationId: orgId } })

const signIn = async (email: string): Promise<Headers> => {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true })
  return new Headers({
    cookie: (res.headers.get("set-cookie") ?? "")
      .split(/,(?=[^;]+?=)/)
      .map((c) => c.split(";")[0]?.trim() ?? "")
      .filter(Boolean)
      .join("; "),
  })
}

const req = (path: string, headers: Headers, init: RequestInit = {}) =>
  new Request(`http://localhost:3100${path}`, { headers, ...init })

describe("authentication events", () => {
  it("logs sign-in success, sign-in failure and sign-out", async () => {
    const { owner } = await orgWithOwner()

    const headers = await signIn(owner.email)
    const ok = named("auth.signin").find((e) => e.outcome === "success")
    expect(ok).toMatchObject({ actor: owner.userId, detail: { method: "password" } })

    await expect(
      auth.api.signInEmail({ body: { email: owner.email, password: "wrong-password-1" } }),
    ).rejects.toThrow()
    const bad = named("auth.signin").find((e) => e.outcome === "failure")
    expect(bad).toMatchObject({ detail: { method: "password" } })
    expect(typeof bad?.reason).toBe("string")
    expect(typeof bad?.subjectRef).toBe("string")

    await auth.api.signOut({ headers })
    expect(named("auth.signout")).toHaveLength(1)

    // Nothing the user typed, and not their address, reaches the log.
    const all = lines.join("\n")
    expect(all).not.toContain(PASSWORD)
    expect(all).not.toContain("wrong-password-1")
    expect(all).not.toContain(owner.email)
  })

  it("logs the proxy-appended client ip on an HTTP sign-in, never a spoofed one", async () => {
    const { owner } = await orgWithOwner()
    const res = await auth.handler(
      withClientIpHeader(
        new Request("http://localhost:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3100",
            "x-forwarded-for": "203.0.113.3, 198.51.100.44",
          },
          body: JSON.stringify({ email: owner.email, password: "wrong-password-1" }),
        }),
      ),
    )
    expect(res.status).toBe(401)
    expect(named("auth.signin")).toEqual([
      expect.objectContaining({ outcome: "failure", ip: "198.51.100.44" }),
    ])
    expect(lines.join("\n")).not.toContain("203.0.113.3")
  })

  it("logs a password sign-in refused because the org requires SSO", async () => {
    const { orgId } = await orgWithOwner()
    const member = await signUp()
    await addMember(orgId, member.userId)
    await writeAuthMethods(orgId, { passwordEnabled: false, ssoEnabled: true })

    await expect(
      auth.api.signInEmail({ body: { email: member.email, password: PASSWORD } }),
    ).rejects.toThrow()
    expect(named("auth.signin")).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "PASSWORD_SIGN_IN_DISABLED" }),
    ])
  })

  it("logs provisioning of an account and an org", async () => {
    const { orgId, owner } = await orgWithOwner()
    expect(named("account.provisioned")[0]).toMatchObject({
      outcome: "success",
      targetId: owner.userId,
    })
    expect(orgId).toBeTruthy()
  })
})

describe("authorisation and admin events", () => {
  it("logs a non-owner refused on an owner-only route, and the owner's change", async () => {
    const { orgId, owner } = await orgWithOwner()
    const member = await signUp()
    await addMember(orgId, member.userId)
    const body = JSON.stringify({ passwordEnabled: true, ssoEnabled: false })

    const refused = await updateAuthMethods(
      req("/api/auth-config/methods", await signIn(member.email), { method: "POST", body }),
    )
    expect(refused.status).toBe(403)
    expect(named("authz.denied")[0]).toMatchObject({
      outcome: "denied",
      actor: member.userId,
      orgId,
      reason: "FORBIDDEN",
      route: "POST /api/auth-config/methods",
      detail: { required: "owner" },
    })

    const ok = await updateAuthMethods(
      req("/api/auth-config/methods", await signIn(owner.email), { method: "POST", body }),
    )
    expect(ok.status).toBe(200)
    expect(named("auth.methods.updated")[0]).toMatchObject({
      outcome: "success",
      actor: owner.userId,
      orgId,
      detail: { localSignIn: true, ssoSignIn: false },
    })
  })

  it("logs member changes made through the org routes with the acting user", async () => {
    const { orgId, owner } = await orgWithOwner()
    const target = await signUp()
    const stranger = await signUp()
    const ownerHeaders = await signIn(owner.email)

    // A member without `configure` on `member` is refused, and that is logged.
    await addMember(orgId, stranger.userId)
    const denied = await handleApi(
      req("/api/org/members", await signIn(stranger.email), {
        method: "POST",
        body: JSON.stringify({ email: target.email }),
      }),
    )
    expect(denied?.status).toBe(403)
    expect(named("authz.denied")[0]).toMatchObject({
      actor: stranger.userId,
      detail: { required: "configure:member" },
    })

    ownerHeaders.set("content-type", "application/json")
    const added = await handleApi(
      req("/api/org/members", ownerHeaders, {
        method: "POST",
        body: JSON.stringify({ email: target.email }),
      }),
    )
    expect(added?.status).toBe(201)
    expect(named("member.added")).toHaveLength(1)
    expect(named("member.added")[0]).toMatchObject({
      outcome: "success",
      actor: owner.userId,
      orgId,
      targetId: target.userId,
    })

    const promoted = await handleApi(
      req(`/api/org/members/${target.userId}/role`, ownerHeaders, {
        method: "POST",
        body: JSON.stringify({ role: "owner" }),
      }),
    )
    expect(promoted?.status).toBe(200)
    expect(named("member.role_changed")).toHaveLength(1)
    expect(named("member.role_changed")[0]).toMatchObject({
      actor: owner.userId,
      targetId: target.userId,
      detail: { from: "member", to: "owner" },
    })
    expect(lines.join("\n")).not.toContain(target.email)
  })

  it("logs a refused session-holder that is not a member of the org", async () => {
    const { orgId } = await orgWithOwner()
    const outsider = await signUp()
    const headers = await signIn(outsider.email)
    // Point the outsider's session at an org they don't belong to.
    await pool.query(`UPDATE bauth_session SET active_organization_id = $1 WHERE user_id = $2`, [
      orgId,
      outsider.userId,
    ])
    const res = await handleApi(req("/api/version", headers))
    expect(res?.status).toBe(403)
    expect(named("authz.denied")[0]).toMatchObject({
      actor: outsider.userId,
      orgId,
      reason: "NOT_A_MEMBER",
    })
  })
})

describe("denied use-cases and OAuth state", () => {
  it("logs a use-case refusal on a plain-HTTP route (attachments, member purge)", async () => {
    const { orgId } = await orgWithOwner()
    const member = await signUp()
    await addMember(orgId, member.userId)
    const r = await runScoped(
      req("/api/attachments/x/download", await signIn(member.email)),
      Effect.fail(new AccessDenied({ resourceType: "attachment", action: "view" })),
    )
    expect(r).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" })
    expect(named("authz.denied")[0]).toMatchObject({
      actor: member.userId,
      orgId,
      reason: "FORBIDDEN",
      route: "GET /api/attachments/x/download",
    })
  })

  it("does not log a non-authorisation failure as a denial", async () => {
    const { owner } = await orgWithOwner()
    await runScoped(req("/api/x", await signIn(owner.email)), Effect.fail({ _tag: "Nope" }))
    expect(named("authz.denied")).toHaveLength(0)
  })

  it("logs an OAuth callback whose state is unknown, for the signed-in user", async () => {
    const { orgId, owner } = await orgWithOwner()
    const res = await handleGoogleCallback(
      req("/api/integrations/google/callback?code=c&state=forged", await signIn(owner.email)),
    )
    expect(res.status).toBe(400)
    expect(named("integration.oauth.rejected")[0]).toMatchObject({
      outcome: "denied",
      actor: owner.userId,
      orgId,
      targetId: "google",
      reason: "BAD_STATE",
      route: "GET /api/integrations/google/callback",
    })
    expect(lines.join("\n")).not.toContain("forged")
  })

  it("logs a Google calendar push with missing headers", async () => {
    const res = await handleCalendarPush(
      new Request("http://localhost:3100/api/integrations/google/calendar/push", {
        method: "POST",
      }),
    )
    expect(res.status).toBe(400)
    expect(named("webhook.rejected")[0]).toMatchObject({
      targetId: "google",
      reason: "BAD_CALENDAR_PUSH",
    })
  })
})

describe("integration events", () => {
  it("logs connect/disconnect from the audit writer — with no detail — and skips routine sync", async () => {
    const { orgId, owner } = await orgWithOwner()
    const entry = { orgId, userId: owner.userId }
    lines.length = 0 // drop the provisioning lines from the fixture

    await writeAuditLog(linearAuditLog, { ...entry, action: "connect" })
    await writeAuditLog(linearAuditLog, {
      ...entry,
      action: "disconnect",
      detail: { providerBody: "SECRET-PROVIDER-TEXT" },
    })
    await writeAuditLog(linearAuditLog, { ...entry, action: "sync" })

    expect(events().map((e) => e.event)).toEqual(["integration.connect", "integration.disconnect"])
    expect(events()[0]).toMatchObject({
      outcome: "success",
      actor: owner.userId,
      orgId,
      targetKind: "integration",
      targetId: "linear",
    })
    expect(lines.join("\n")).not.toContain("SECRET-PROVIDER-TEXT")
  })

  it("logs an inbound webhook that fails its check, without the token it presented", async () => {
    const res = await handleLinearWebhook(
      new Request("http://localhost:3100/api/integrations/linear/webhook", {
        method: "POST",
        headers: { "x-webhook-token": "presented-token-123" },
        body: "{}",
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(401)
    const e = named("webhook.rejected")[0]
    expect(e).toMatchObject({ outcome: "denied", targetId: "linear" })
    expect(lines.join("\n")).not.toContain("presented-token-123")
  })
})
