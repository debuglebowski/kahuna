import { randomUUID } from "node:crypto"
import { KahunaRpcs, layerRpcProtocolHttp } from "@kahunalabs/contract"
import { and, eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { member, session } from "#db"
import { type FakeIdp, startFakeIdp } from "../scripts/fake-idp"
import { db, pool } from "./db"
import { setSecurityLogSink } from "./securityLog"

/**
 * Roles from the identity provider's claim (idpRoles.ts), through the REAL sign-in
 * and callback routes against a local IdP, and the real RPC surface. Off is the
 * default and must behave exactly as before; on, the claim alone decides.
 *
 * `SSO_*` is read when deploymentIdp.ts loads, so everything that reaches it is
 * imported AFTER the env is set, never at the top of this file.
 */

const DOMAIN = "roles-idp.test"
const ORIGIN = "http://localhost:3100"
const MFA = ["pwd", "mfa"]
const SSO_KEYS = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "SSO_DOMAINS"] as const
const MAP = "Kahuna.Admin=admin,Kahuna.Member=member"

let idp: FakeIdp
let mod: {
  auth: typeof import("./auth").auth
  deploymentIdp: typeof import("./deploymentIdp")
  idpRoles: typeof import("./idpRoles")
  provision: typeof import("./provision")
  rpc: typeof import("./rpc")
  router: typeof import("./router")
}
let orgId: string
let owner: { email: string; userId: string }
let roleIds: { admin: string; member: string }

const cookiesOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ")

const ssoSignIn = async (): Promise<{ location: string; cookie: string }> => {
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
  const done = await mod.auth.handler(
    new Request(approved.headers.get("location") ?? "", { headers: { cookie: cookiesOf(start) } }),
  )
  return { location: done.headers.get("location") ?? "", cookie: cookiesOf(done) }
}

/** Sign in as a fresh (or given) person whose ID token carries these claims. */
const signInWith = async (
  claims: Record<string, unknown>,
  who?: { email: string; sub: string },
) => {
  const person = who ?? { email: `p-${randomUUID()}@${DOMAIN}`, sub: `sub-${randomUUID()}` }
  idp.setIdentity({ ...person, emailVerified: null, amr: MFA, claims })
  const res = await ssoSignIn()
  const [row] = await pool
    .query<{ id: string }>("SELECT id FROM bauth_user WHERE lower(email) = lower($1)", [
      person.email,
    ])
    .then((r) => r.rows)
  return { ...res, person, userId: row?.id ?? "" }
}

const PASSWORD = "password12345"

const signUp = async () => {
  const email = `owner-${randomUUID()}@test.dev`
  const created = await mod.provision.createUserDirect({ email, password: PASSWORD, name: "T" })
  return { email, userId: created.userId }
}

const cookieFor = async (email: string): Promise<string> => {
  const res = await mod.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  })
  return (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")
}

/** The real typed RPC client, with `fetch` routed into the server's handler. */
const rpcAs = (cookie: string) => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    mod.rpc.rpcHandler(new Request(input, init))) as typeof fetch
  const protocol = layerRpcProtocolHttp({
    url: `${ORIGIN}/api/rpc`,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeaders({ cookie, origin: ORIGIN }),
    ),
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    Layer.provide(RpcSerialization.layerNdjson),
  )
  const make = RpcClient.make(KahunaRpcs)
  type Client = Effect.Success<typeof make>
  class Api extends Context.Service<Api, Client>()("test/Api") {}
  const runtime = ManagedRuntime.make(Layer.effect(Api, make).pipe(Layer.provide(protocol)))
  return {
    call: async <A, E>(f: (c: Client) => Effect.Effect<A, E>): Promise<A> => {
      const exit = await runtime.runPromiseExit(Effect.flatMap(Api, f))
      if (Exit.isSuccess(exit)) return exit.value
      throw Cause.squash(exit.cause)
    },
    dispose: () => runtime.dispose(),
  }
}

const errorOf = (location: string) => new URL(location, ORIGIN).searchParams.get("error")

/** The ordinary people roles a user holds, by key (or name for custom ones). */
const heldKeys = async (userId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ k: string }>(
    `SELECT coalesce(r.key, r.name) AS k FROM access_role_actors a
     JOIN access_roles r ON r.id = a.role_id
     WHERE a.org_id = $1 AND a.actor_id = $2 AND r.personal_for IS NULL
     ORDER BY k`,
    [orgId, userId],
  )
  return rows.map((r) => r.k)
}

const tierOf = async (userId: string) => {
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
  return m?.role
}

const capture = () => {
  const lines: Array<Record<string, unknown>> = []
  setSecurityLogSink((l) => lines.push(JSON.parse(l) as Record<string, unknown>))
  return lines
}

const modeOn = (extra: Record<string, string> = {}) =>
  mod.idpRoles.setIdpRoleConfig(
    mod.idpRoles.parseIdpRoleConfig(
      { SSO_ROLES_FROM_IDP: "true", SSO_ROLE_MAP: MAP, ...extra },
      mod.deploymentIdp.deploymentIdp,
    ),
  )

beforeAll(async () => {
  idp = await startFakeIdp(0, { tls: false })
  process.env.SSO_ISSUER = idp.issuer
  process.env.SSO_CLIENT_ID = "kahuna-test"
  process.env.SSO_CLIENT_SECRET = "test-secret"
  process.env.SSO_DOMAINS = DOMAIN
  mod = {
    auth: (await import("./auth")).auth,
    deploymentIdp: await import("./deploymentIdp"),
    idpRoles: await import("./idpRoles"),
    provision: await import("./provision"),
    rpc: await import("./rpc"),
    router: await import("./router"),
  }
  owner = await signUp()
  const org = await mod.auth.api.createOrganization({
    body: { name: "Roles org", slug: `roles-${randomUUID().slice(0, 8)}`, userId: owner.userId },
  })
  if (!org) throw new Error("createOrganization returned null")
  orgId = org.id
  mod.deploymentIdp.setDeploymentOrgResolver(async () => orgId)
  await (await import("./authMethods")).writeAuthMethods(orgId, {
    passwordEnabled: true,
    ssoEnabled: true,
  })
  const roles = await mod.idpRoles.orgRoles(orgId)
  const id = (key: string) => roles.find((r) => r.key === key)?.id ?? ""
  roleIds = { admin: id("admin"), member: id("member") }
})

afterEach(() => {
  setSecurityLogSink()
  mod.idpRoles.setIdpRoleConfig(null)
})

afterAll(async () => {
  mod?.deploymentIdp.setDeploymentOrgResolver()
  mod?.idpRoles.setIdpRoleConfig()
  for (const k of SSO_KEYS) delete process.env[k]
  await idp?.close()
})

describe("config", () => {
  const parse = (env: Record<string, string>) =>
    mod.idpRoles.parseIdpRoleConfig(env, mod.deploymentIdp.deploymentIdp)

  it("is off unless turned on", () => {
    expect(parse({})).toBeNull()
    expect(parse({ SSO_ROLES_FROM_IDP: "false", SSO_ROLE_MAP: MAP })).toBeNull()
    expect(() => parse({ SSO_ROLES_FROM_IDP: "yes" })).toThrow(/true or false/)
  })

  it("defaults to the `roles` claim and deny, and parses the map in order", () => {
    expect(parse({ SSO_ROLES_FROM_IDP: "true", SSO_ROLE_MAP: MAP })).toEqual({
      claim: "roles",
      map: [
        { value: "Kahuna.Admin", target: "admin" },
        { value: "Kahuna.Member", target: "member" },
      ],
      unmapped: { kind: "deny" },
      ownerManaged: false,
    })
  })

  it("refuses what would lock everyone out or make everyone owner", () => {
    const on = { SSO_ROLES_FROM_IDP: "true" }
    expect(() => parse(on)).toThrow(/SSO_ROLE_MAP is empty/)
    expect(() => parse({ ...on, SSO_ROLE_MAP: "Kahuna.Admin" })).toThrow(/<claim value>=<role>/)
    expect(() => parse({ ...on, SSO_ROLE_MAP: MAP, SSO_ROLE_UNMAPPED: "Owner" })).toThrow(/owner/)
    expect(
      parse({ ...on, SSO_ROLE_MAP: "Kahuna.Owner=owner", SSO_ROLE_UNMAPPED: "member" }),
    ).toMatchObject({ ownerManaged: true, unmapped: { kind: "role", target: "member" } })
  })

  it("needs the identity provider in deployment config", () => {
    expect(() =>
      mod.idpRoles.parseIdpRoleConfig({ SSO_ROLES_FROM_IDP: "true", SSO_ROLE_MAP: MAP }, null),
    ).toThrow(/SSO_ISSUER/)
  })
})

describe("reading the claim", () => {
  const values = (c: Record<string, unknown>, n: string) => mod.idpRoles.claimValues(c, n)
  const SAML_ROLE = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"

  it("takes an array (Entra, Okta), a single string, and ignores the rest", () => {
    expect(values({ roles: ["A", "B", "A", 3, ""] }, "roles")).toEqual(["A", "B"])
    expect(values({ roles: "A" }, "roles")).toEqual(["A"])
    expect(values({ roles: { A: true } }, "roles")).toEqual([])
    expect(values({}, "roles")).toEqual([])
  })

  it("follows a dotted path (Keycloak), but an exact name wins (SAML attribute URIs)", () => {
    expect(values({ realm_access: { roles: ["A"] } }, "realm_access.roles")).toEqual(["A"])
    expect(values({ [SAML_ROLE]: ["A"] }, SAML_ROLE)).toEqual(["A"])
    expect(mod.idpRoles.DEFAULT_ROLE_CLAIM.saml).toBe(SAML_ROLE)
  })
})

describe("mode off (default): unchanged", () => {
  it("ignores the claim: an SSO sign-in lands on the auto-assign roles", async () => {
    const { cookie, userId } = await signInWith({ roles: ["Kahuna.Admin"] })
    expect(cookie).toContain("session_token")
    expect(await heldKeys(userId)).toEqual(["member"])
  })

  it("an unmapped claim still signs in", async () => {
    const { cookie } = await signInWith({ roles: ["Something.Else"] })
    expect(cookie).toContain("session_token")
  })

  it("role changes in the app work", async () => {
    const { userId } = await signInWith({})
    const api = rpcAs(await cookieFor(owner.email))
    try {
      await api.call((c) => c.assignRole({ roleId: roleIds.admin, userId }))
      expect(await heldKeys(userId)).toEqual(["admin", "member"])
      await api.call((c) => c.unassignRole({ roleId: roleIds.admin, userId }))
      expect(await heldKeys(userId)).toEqual(["member"])
      expect(await api.call((c) => c.myAccess())).toMatchObject({
        rolesManagedByIdp: false,
        ownerManagedByIdp: false,
      })
    } finally {
      await api.dispose()
    }
  })
})

describe("mode on: roles come from the claim", () => {
  it("grants the mapped role at sign-in, and only that one", async () => {
    modeOn()
    const lines = capture()
    const { cookie, userId } = await signInWith({ roles: ["Kahuna.Admin"] })
    expect(cookie).toContain("session_token")
    // No `member` — auto-assign does not apply when the IdP is the source.
    expect(await heldKeys(userId)).toEqual(["admin"])
    expect(lines.filter((l) => l.event === "access.role.from_idp")).toEqual([
      expect.objectContaining({
        outcome: "success",
        targetId: userId,
        detail: { roleId: roleIds.admin, change: "granted", claim: "Kahuna.Admin" },
      }),
    ])
  })

  it("replaces roles at the next sign-in: removed at the IdP, removed here", async () => {
    modeOn()
    const first = await signInWith({ roles: ["Kahuna.Admin"] })
    expect(await heldKeys(first.userId)).toEqual(["admin"])
    const lines = capture()
    const again = await signInWith({ roles: ["Kahuna.Member"] }, first.person)
    expect(again.cookie).toContain("session_token")
    expect(await heldKeys(first.userId)).toEqual(["member"])
    expect(lines.filter((l) => l.event === "access.role.from_idp").map((l) => l.detail)).toEqual([
      { roleId: roleIds.member, change: "granted", claim: "Kahuna.Member" },
      { roleId: roleIds.admin, change: "removed" },
    ])
  })

  it("also replaces roles granted in the app before the mode was turned on", async () => {
    const { userId, person } = await signInWith({})
    expect(await heldKeys(userId)).toEqual(["member"])
    modeOn()
    await signInWith({ roles: ["Kahuna.Admin"] }, person)
    expect(await heldKeys(userId)).toEqual(["admin"])
  })

  it("refuses a claim with no mapped value: no session, roles and sessions taken away", async () => {
    modeOn()
    const first = await signInWith({ roles: ["Kahuna.Admin"] })
    expect(first.cookie).toContain("session_token")
    const lines = capture()
    const again = await signInWith({ roles: ["Something.Else"] }, first.person)
    expect(errorOf(again.location)).toBe("SSO_NO_MAPPED_ROLE")
    expect(again.cookie).not.toContain("session_token")
    expect(await heldKeys(first.userId)).toEqual([])
    expect(
      await db.select({ id: session.id }).from(session).where(eq(session.userId, first.userId)),
    ).toEqual([])
    expect(lines.filter((l) => l.event === "auth.signin")).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "SSO_NO_MAPPED_ROLE" }),
    ])
  })

  it("refuses a first sign-in with no roles claim at all, creating nobody", async () => {
    modeOn()
    const { location, userId } = await signInWith({})
    expect(errorOf(location)).toBe("SSO_NO_MAPPED_ROLE")
    expect(userId).toBe("")
  })

  it("a mapped value naming no role is unmapped, and logged", async () => {
    modeOn({ SSO_ROLE_MAP: `${MAP},Kahuna.Ghost=no-such-role` })
    const lines = capture()
    const { location } = await signInWith({ roles: ["Kahuna.Ghost"] })
    expect(errorOf(location)).toBe("SSO_NO_MAPPED_ROLE")
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: "access.role.from_idp",
        outcome: "failure",
        reason: "ROLE_NOT_FOUND",
      }),
    )
  })

  it("SSO_ROLE_UNMAPPED=<role> falls back instead of refusing", async () => {
    modeOn({ SSO_ROLE_UNMAPPED: "member" })
    const { cookie, userId } = await signInWith({ roles: ["Something.Else"] })
    expect(cookie).toContain("session_token")
    expect(await heldKeys(userId)).toEqual(["member"])
  })

  it("reads a custom claim name and nested path", async () => {
    modeOn({ SSO_ROLE_CLAIM: "realm_access.roles" })
    const { userId } = await signInWith({ realm_access: { roles: ["Kahuna.Admin"] } })
    expect(await heldKeys(userId)).toEqual(["admin"])
  })

  it("maps `owner` onto the membership tier, both ways", async () => {
    modeOn({ SSO_ROLE_MAP: `${MAP},Kahuna.Owner=owner` })
    const first = await signInWith({ roles: ["Kahuna.Owner", "Kahuna.Admin"] })
    expect(await tierOf(first.userId)).toBe("owner")
    await signInWith({ roles: ["Kahuna.Admin"] }, first.person)
    expect(await tierOf(first.userId)).toBe("member")
  })
})

describe("mode on: role changes in the app are refused", () => {
  it("refuses assign, unassign, reorder and reassign over RPC, and logs each", async () => {
    const { userId } = await signInWith({})
    modeOn()
    const lines = capture()
    const api = rpcAs(await cookieFor(owner.email))
    try {
      const refused = { _tag: "RpcError", code: "ROLES_MANAGED_BY_IDP", status: 409 }
      await expect(
        api.call((c) => c.assignRole({ roleId: roleIds.admin, userId })),
      ).rejects.toMatchObject({
        ...refused,
        message: "Roles are managed by your identity provider.",
      })
      await expect(
        api.call((c) => c.unassignRole({ roleId: roleIds.member, userId })),
      ).rejects.toMatchObject(refused)
      await expect(
        api.call((c) => c.reorderMemberRoles({ userId, roleIds: [roleIds.member] })),
      ).rejects.toMatchObject(refused)
      await expect(
        api.call((c) =>
          c.reassignRoleHolders({ fromRoleId: roleIds.member, toRoleId: roleIds.admin }),
        ),
      ).rejects.toMatchObject(refused)
      expect(await heldKeys(userId)).toEqual(["member"])
      expect(await api.call((c) => c.myAccess())).toMatchObject({
        rolesManagedByIdp: true,
        ownerManagedByIdp: false,
      })
    } finally {
      await api.dispose()
    }
    expect(
      lines
        .filter((l) => l.event === "access.role_change.refused")
        .map((l) => [l.outcome, l.reason, (l.detail as { change: string }).change]),
    ).toEqual([
      ["denied", "ROLES_MANAGED_BY_IDP", "assignRole"],
      ["denied", "ROLES_MANAGED_BY_IDP", "unassignRole"],
      ["denied", "ROLES_MANAGED_BY_IDP", "reorderMemberRoles"],
      ["denied", "ROLES_MANAGED_BY_IDP", "reassignRoleHolders"],
    ])
  })

  it("still refuses a caller without permission as FORBIDDEN first", async () => {
    // Twice: the first SSO session predates the membership it creates.
    const first = await signInWith({})
    const outsider = await signInWith({}, first.person)
    modeOn()
    const api = rpcAs(outsider.cookie)
    try {
      await expect(
        api.call((c) => c.assignRole({ roleId: roleIds.admin, userId: outsider.userId })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    } finally {
      await api.dispose()
    }
  })

  it("refuses the owner toggle only when owner is mapped", async () => {
    const { userId } = await signInWith({})
    const toggle = async () =>
      mod.router.handleApi(
        new Request(`${ORIGIN}/api/org/members/${userId}/role`, {
          method: "POST",
          headers: {
            cookie: await cookieFor(owner.email),
            "content-type": "application/json",
            origin: ORIGIN,
          },
          body: JSON.stringify({ role: "member" }),
        }),
      )
    modeOn()
    expect((await toggle())?.status).toBe(200)
    modeOn({ SSO_ROLE_MAP: `${MAP},Kahuna.Owner=owner` })
    const res = await toggle()
    expect(res?.status).toBe(409)
    expect(await res?.json()).toMatchObject({ error: "ROLES_MANAGED_BY_IDP" })
  })
})
