import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { account, member, user } from "#db"
import { type FakeIdp, startFakeIdp } from "../scripts/fake-idp"
import { db } from "./db"

/**
 * The identity provider declared in deployment config, driven through the REAL
 * sign-in and callback routes against a local IdP that behaves like Entra: no
 * `email_verified` claim. The case that matters is an operator-provisioned account
 * signing in through SSO for the first time — before this, `account_not_linked`.
 *
 * `SSO_*` is read when deploymentIdp.ts loads, so everything that reaches it is
 * imported AFTER the env is set (below), never at the top of this file.
 */

const DOMAIN = "idp.test"
const PASSWORD = "password12345"
const ORIGIN = "http://localhost:3100"
const SSO_KEYS = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "SSO_DOMAINS"] as const

let idp: FakeIdp
let mod: {
  auth: typeof import("./auth").auth
  deploymentIdp: typeof import("./deploymentIdp")
  provision: typeof import("./provision")
  sso: typeof import("./sso")
  writeAuthMethods: typeof import("./authMethods").writeAuthMethods
}
let orgId: string
let owner: { email: string; userId: string }

const cookiesOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ")

const newUser = async (email: string) => {
  const created = await mod.provision.createUserDirect({ email, password: PASSWORD, name: "T" })
  return { email, userId: created.userId }
}

/** Start SSO, let the IdP approve, deliver the callback. Returns where it lands. */
const ssoSignIn = async (): Promise<{ status: number; location: string; cookie: string }> => {
  const start = await mod.auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ providerId: "deployment-idp", callbackURL: "/home" }),
    }),
  )
  expect(start.status).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const approved = await fetch(url, { redirect: "manual" })
  const callback = approved.headers.get("location") ?? ""
  expect(callback).toContain("/api/auth/sso/callback/deployment-idp")
  const done = await mod.auth.handler(
    new Request(callback, { headers: { cookie: cookiesOf(start) } }),
  )
  return {
    status: done.status,
    location: done.headers.get("location") ?? "",
    cookie: cookiesOf(done),
  }
}

beforeAll(async () => {
  idp = await startFakeIdp(0, { tls: false })
  process.env.SSO_ISSUER = idp.issuer
  process.env.SSO_CLIENT_ID = "kahuna-test"
  process.env.SSO_CLIENT_SECRET = "test-secret"
  process.env.SSO_DOMAINS = DOMAIN
  mod = {
    auth: (await import("./auth")).auth,
    deploymentIdp: await import("./deploymentIdp"),
    provision: await import("./provision"),
    sso: await import("./sso"),
    writeAuthMethods: (await import("./authMethods")).writeAuthMethods,
  }

  owner = await newUser(`owner-${randomUUID()}@test.dev`)
  const org = await mod.auth.api.createOrganization({
    body: { name: "IdP org", slug: `idp-${randomUUID().slice(0, 8)}`, userId: owner.userId },
  })
  if (!org) throw new Error("createOrganization returned null")
  orgId = org.id
  // The suite's database holds many orgs; a real deployment holds one.
  mod.deploymentIdp.setDeploymentOrgResolver(async () => orgId)
  await mod.writeAuthMethods(orgId, { passwordEnabled: true, ssoEnabled: true })
})

afterAll(async () => {
  mod?.deploymentIdp.setDeploymentOrgResolver()
  for (const k of SSO_KEYS) delete process.env[k]
  await idp?.close()
})

describe("SSO_* parsing", () => {
  const env = {
    SSO_ISSUER: "https://login.example.com/tenant/v2.0",
    SSO_CLIENT_ID: "id",
    SSO_CLIENT_SECRET: "secret",
    SSO_DOMAINS: "Acme.com, acme.co.uk",
  }
  const parse = (e: Record<string, string | undefined>, isProd = true) =>
    mod.deploymentIdp.parseDeploymentIdp(e, isProd)

  it("is off with none set, and refuses a half-set config", () => {
    expect(parse({})).toBeNull()
    expect(() => parse({ ...env, SSO_CLIENT_SECRET: "" })).toThrow(/Missing: SSO_CLIENT_SECRET/)
  })

  it("normalizes domains and refuses anything that isn't one", () => {
    expect(parse(env)?.domain).toBe("acme.com,acme.co.uk")
    expect(() => parse({ ...env, SSO_DOMAINS: "ada@acme.com" })).toThrow(/SSO_DOMAINS/)
  })

  it("requires https, except a loopback issuer outside production", () => {
    const local = { ...env, SSO_ISSUER: "http://127.0.0.1:9000" }
    expect(() => parse({ ...env, SSO_ISSUER: "http://idp.example.com" })).toThrow(/https/)
    expect(() => parse(local)).toThrow(/https/)
    expect(parse(local, false)?.oidcConfig.issuer).toBe("http://127.0.0.1:9000")
  })
})

describe("sign-in through the provider in deployment config", () => {
  it("links an existing account even though the IdP asserts no email_verified", async () => {
    const ada = await newUser(`ada-${randomUUID()}@${DOMAIN}`)
    idp.setIdentity({ sub: `sub-${ada.userId}`, email: ada.email, emailVerified: null })

    const { location, cookie } = await ssoSignIn()
    expect(decodeURIComponent(location)).toBe("/home")
    expect(cookie).toContain("session_token")

    const [linked] = await db
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, "deployment-idp"), eq(account.userId, ada.userId)))
    expect(linked).toBeDefined()
    const [m] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, ada.userId)))
    expect(m?.role).toBe("member")
  })

  it("refuses an identity outside its domains: no session, no membership", async () => {
    const email = `eve-${randomUUID()}@elsewhere.test`
    idp.setIdentity({ sub: `sub-${randomUUID()}`, email, emailVerified: null })
    const { status, cookie } = await ssoSignIn()
    // The domain guard in auth.ts (`SSO_DOMAIN_NOT_ALLOWED`).
    expect(status).toBe(403)
    expect(cookie).not.toContain("session_token")
    const joined = await db
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, orgId), eq(user.email, email)))
    expect(joined).toEqual([])
  })
})

describe("settings while the deployment declares the provider", () => {
  const ownerRequest = async (method: string, body?: unknown) => {
    const signedIn = await mod.auth.api.signInEmail({
      body: { email: owner.email, password: PASSWORD },
      asResponse: true,
    })
    return new Request(`${ORIGIN}/api/auth-config/sso`, {
      method,
      headers: { cookie: cookiesOf(signedIn), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it("shows the provider read-only, with its own redirect URI", async () => {
    const res = await mod.sso.authConfigStatus(await ownerRequest("GET"))
    const body = (await res.json()) as {
      provider: { managed: boolean; issuer: string; hasSecret: boolean }
      callbackUrl: string
    }
    expect(body.provider).toMatchObject({ managed: true, issuer: idp.issuer, hasSecret: true })
    expect(body.callbackUrl).toMatch(/\/api\/auth\/sso\/callback\/deployment-idp$/)
    expect(JSON.stringify(body)).not.toContain("test-secret")
  })

  it("refuses to register or remove a provider, even for the owner", async () => {
    const input = {
      issuer: "https://other.example",
      domain: DOMAIN,
      clientId: "x",
      clientSecret: "y",
    }
    const saved = await mod.sso.saveSsoProvider(await ownerRequest("POST", input))
    expect(saved.status).toBe(409)
    expect(await saved.json()).toEqual({ error: "SSO_MANAGED_BY_DEPLOYMENT" })
    const removed = await mod.sso.deleteSsoProvider(await ownerRequest("DELETE"))
    expect(removed.status).toBe(409)
  })
})
