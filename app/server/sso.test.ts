import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { session as sessionTable, ssoProvider } from "#db"
import { auth } from "./auth"
import {
  type AuthMethods,
  domainMatches,
  emailDomain,
  passwordSignInAllowed,
  resolveSignInProvider,
  writeAuthMethods,
} from "./authMethods"
import { db } from "./db"
import { createUserDirect } from "./provision"
import { resolveOrg } from "./session"
import { authConfigStatus, publicAuthMethods, updateAuthMethods } from "./sso"

/**
 * The per-org sign-in gates, the owner-only config surface, and the two traps
 * that make SSO different from the integration connectors: an org can be
 * configured into a state where nobody can sign in, and a first SSO login
 * produces a session that has no active org yet.
 *
 * Provider REGISTRATION is not covered — `registerSSOProvider` fetches the
 * issuer's discovery document, so exercising it would need a live IdP. Tests
 * that need a provider to exist insert the row directly; what is under test here
 * is our gating around it, not better-auth's OIDC.
 */

const PASSWORD = "password12345"

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

const addMember = async (orgId: string, userId: string, role: "member" | "admin" = "member") => {
  await auth.api.addMember({ body: { userId, role, organizationId: orgId } })
}

/** Sign in and return the cookie header a request would carry. */
const signIn = async (email: string): Promise<Headers> => {
  const res = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  })
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`)
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

/** A provider row, without going near the plugin's discovery fetch. */
const insertProvider = async (orgId: string, userId: string, domain: string) => {
  await db.insert(ssoProvider).values({
    id: randomUUID(),
    issuer: "https://idp.test.dev",
    domain,
    oidcConfig: JSON.stringify({ clientId: "cid", clientSecret: "shh" }),
    userId,
    providerId: `org-${orgId}`,
    organizationId: orgId,
  })
}

describe("domain matching", () => {
  it("handles the comma-separated list better-auth stores, case-insensitively", () => {
    expect(domainMatches("acme.com", "acme.com")).toBe(true)
    expect(domainMatches("ACME.com", " acme.com , acme.co.uk ")).toBe(true)
    expect(domainMatches("acme.co.uk", "acme.com,acme.co.uk")).toBe(true)
    // The whole point of the guard: a personal address at a shared issuer.
    expect(domainMatches("gmail.com", "acme.com")).toBe(false)
    expect(domainMatches("", "acme.com")).toBe(false)
    // NOT a suffix match — evil-acme.com must not pass for acme.com.
    expect(domainMatches("evil-acme.com", "acme.com")).toBe(false)
  })

  it("extracts an email domain, and tolerates malformed input", () => {
    expect(emailDomain("Person@Acme.com")).toBe("acme.com")
    expect(emailDomain("not-an-email")).toBe("")
  })
})

describe("password sign-in gate", () => {
  it("allows password sign-in by default (no settings row)", async () => {
    const { orgId } = await orgWithOwner()
    const user = await signUp()
    await addMember(orgId, user.userId)
    expect(await passwordSignInAllowed(user.email)).toBe(true)
  })

  it("allows an address with no memberships, and an unknown one", async () => {
    const orphan = await signUp()
    expect(await passwordSignInAllowed(orphan.email)).toBe(true)
    expect(await passwordSignInAllowed(`nobody-${randomUUID()}@test.dev`)).toBe(true)
  })

  it("blocks a member whose only org is SSO-only — through the real sign-in route", async () => {
    const { orgId } = await orgWithOwner()
    const user = await signUp()
    await addMember(orgId, user.userId)
    await writeAuthMethods(orgId, { passwordEnabled: false, ssoEnabled: true })

    expect(await passwordSignInAllowed(user.email)).toBe(false)
    // And the gate is actually wired into better-auth, not merely callable.
    // A `before` hook THROWS, so this rejects rather than resolving to a 403
    // response — which is the point: the route never runs, so no session is
    // minted even for correct credentials.
    await expect(
      auth.api.signInEmail({ body: { email: user.email, password: PASSWORD }, asResponse: true }),
    ).rejects.toThrow(/requires signing in with SSO/)
  })

  it("BREAK-GLASS: the owner still signs in when password sign-in is off", async () => {
    const { orgId, owner } = await orgWithOwner()
    await writeAuthMethods(orgId, { passwordEnabled: false, ssoEnabled: true })

    expect(await passwordSignInAllowed(owner.email)).toBe(true)
    const res = await auth.api.signInEmail({
      body: { email: owner.email, password: PASSWORD },
      asResponse: true,
    })
    expect(res.status).toBe(200)
  })

  it("does not lock a member out of a second org that still allows passwords", async () => {
    const a = await orgWithOwner()
    const b = await orgWithOwner()
    const user = await signUp()
    await addMember(a.orgId, user.userId)
    await addMember(b.orgId, user.userId)
    await writeAuthMethods(a.orgId, { passwordEnabled: false, ssoEnabled: true })

    expect(await passwordSignInAllowed(user.email)).toBe(true)
  })
})

describe("sign-in provider resolution", () => {
  it("resolves by providerId, by bare domain and by email domain", async () => {
    const { orgId, owner } = await orgWithOwner()
    const domain = `d-${randomUUID().slice(0, 8)}.test`
    await insertProvider(orgId, owner.userId, domain)

    expect((await resolveSignInProvider({ providerId: `org-${orgId}` }))?.organizationId).toBe(
      orgId,
    )
    expect((await resolveSignInProvider({ domain }))?.organizationId).toBe(orgId)
    expect((await resolveSignInProvider({ email: `x@${domain}` }))?.organizationId).toBe(orgId)
    expect(await resolveSignInProvider({ email: "x@nowhere.invalid" })).toBeNull()
    expect(await resolveSignInProvider({})).toBeNull()
  })
})

describe("auth config surface", () => {
  it("is readable by an admin but NOT writable — only the owner may write", async () => {
    const { orgId, owner } = await orgWithOwner()
    const admin = await signUp()
    await addMember(orgId, admin.userId, "admin")

    const adminHeaders = await signIn(admin.email)
    const read = await authConfigStatus(req("/api/auth-config/sso", adminHeaders))
    expect(read.status).toBe(200)
    expect(((await read.json()) as { canEdit: boolean }).canEdit).toBe(false)

    const write = await updateAuthMethods(
      req("/api/auth-config/methods", adminHeaders, {
        method: "POST",
        body: JSON.stringify({ passwordEnabled: true, ssoEnabled: false }),
      }),
    )
    expect(write.status).toBe(403)

    const ownerHeaders = await signIn(owner.email)
    const ownerRead = await authConfigStatus(req("/api/auth-config/sso", ownerHeaders))
    expect(((await ownerRead.json()) as { canEdit: boolean }).canEdit).toBe(true)
  })

  it("reports the redirect URI the operator must register, derived from the org id", async () => {
    const { orgId, owner } = await orgWithOwner()
    const res = await authConfigStatus(req("/api/auth-config/sso", await signIn(owner.email)))
    const body = (await res.json()) as { callbackUrl: string }
    expect(body.callbackUrl).toContain(`/api/auth/sso/callback/org-${orgId}`)
  })

  it("refuses to leave an org with no way in, or SSO on with no provider", async () => {
    const { orgId, owner } = await orgWithOwner()
    const headers = await signIn(owner.email)
    const post = (body: unknown) =>
      updateAuthMethods(
        req("/api/auth-config/methods", headers, { method: "POST", body: JSON.stringify(body) }),
      )

    const bothOff = await post({ passwordEnabled: false, ssoEnabled: false })
    expect(bothOff.status).toBe(400)
    expect(((await bothOff.json()) as { error: string }).error).toBe("NO_SIGN_IN_METHOD")

    const noProvider = await post({ passwordEnabled: true, ssoEnabled: true })
    expect(noProvider.status).toBe(400)
    expect(((await noProvider.json()) as { error: string }).error).toBe("NO_SSO_PROVIDER")

    // With a provider on file the same call succeeds.
    await insertProvider(orgId, owner.userId, `d-${randomUUID().slice(0, 8)}.test`)
    expect((await post({ passwordEnabled: true, ssoEnabled: true })).status).toBe(200)
  })

  it("never serializes the client secret", async () => {
    const { orgId, owner } = await orgWithOwner()
    await insertProvider(orgId, owner.userId, "acme.test")
    const res = await authConfigStatus(req("/api/auth-config/sso", await signIn(owner.email)))
    const raw = await res.text()
    expect(raw).not.toContain("shh")
    expect(raw).toContain('"hasSecret":true')
  })
})

describe("public sign-in methods", () => {
  it("is readable with NO session, and leaks only booleans", async () => {
    const res = await publicAuthMethods()
    expect(res.status).toBe(200)
    const raw = await res.text()
    const body = JSON.parse(raw) as AuthMethods
    expect(typeof body.passwordEnabled).toBe("boolean")
    expect(typeof body.ssoEnabled).toBe("boolean")
    // No issuer, client id, domain or secret — those stay admin-gated.
    expect(Object.keys(body).sort()).toEqual(["passwordEnabled", "ssoEnabled"])
  })

  it("falls back to offering both when the org is ambiguous", async () => {
    // The suite creates many orgs, so this exercises the 2+ branch: a visitor's
    // org is unknowable, and hiding a method they can use would lock them out.
    const body = (await (await publicAuthMethods()).json()) as AuthMethods
    expect(body.passwordEnabled).toBe(true)
    expect(body.ssoEnabled).toBe(true)
  })
})

describe("active org self-heal", () => {
  it("adopts the user's membership when the session has no active org", async () => {
    // Exactly the state a first SSO login leaves behind: the plugin creates the
    // session BEFORE `assignOrganizationFromProvider` writes the member row, so
    // `databaseHooks.session.create.before` stamps null.
    const { orgId, owner } = await orgWithOwner()
    const headers = await signIn(owner.email)
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: null })
      .where(eq(sessionTable.userId, owner.userId))

    const resolved = await resolveOrg(req("/api/rpc", headers))
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.orgId).toBe(orgId)

    // …and it was repaired on the session, not just papered over per-request.
    const [row] = await db
      .select({ activeOrganizationId: sessionTable.activeOrganizationId })
      .from(sessionTable)
      .where(eq(sessionTable.userId, owner.userId))
      .limit(1)
    expect(row?.activeOrganizationId).toBe(orgId)
  })

  it("still reports NO_ACTIVE_ORG for a user who genuinely has no membership", async () => {
    const orphan = await signUp()
    const resolved = await resolveOrg(req("/api/rpc", await signIn(orphan.email)))
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.code).toBe("NO_ACTIVE_ORG")
  })
})
