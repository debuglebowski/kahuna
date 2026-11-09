import { randomUUID } from "node:crypto"
import type { RoleConfig } from "@normain/idp-role-contract"
import {
  type AcceptanceObservation,
  type AcceptanceScenario,
  runAdapterAcceptance,
  runCommonFixtures,
} from "@normain/idp-role-contract/fixtures"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type FakeIdp, startFakeIdp } from "../scripts/fake-idp"
import { pool } from "./db"

/**
 * Roles from the identity provider, driven through Kahuna's REAL entry points:
 * BetterAuth's SSO sign-in and callback against a local OIDC provider (with refresh
 * tokens), the typed RPC surface, the `/api/*` router, the SSE stream, the CLI
 * device flow and BetterAuth's own endpoints — and the persisted tables. The
 * shared contract's acceptance runner (`runAdapterAcceptance`) is fed from these
 * native observations; nothing here calls the shared pure functions to manufacture
 * an answer.
 *
 * ISOLATION. Needs the shared TEST database (vitest's globalSetup), never a real
 * one: activation deletes EVERY `bauth_session` row, which is the point of it.
 * Files run one at a time (`fileParallelism: false`), and `afterAll` persists the
 * mode OFF again so later files see the untouched default.
 *
 * `SSO_*` is read when deploymentIdp.ts loads, so everything that reaches it is
 * imported AFTER the env is set.
 */

const DOMAIN = "roles-idp.test"
const ORIGIN = "http://localhost:3100"
const MFA = ["pwd", "mfa"]
const SSO_KEYS = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "SSO_DOMAINS"] as const
const MAPPING = {
  "Kahuna.Owner": ["owner"],
  "Kahuna.Admin": ["admin"],
  "Kahuna.Member": ["member"],
  "Kahuna.Nothing": [],
}
const MANAGED_ENV = {
  IDP_ROLES_ENABLED: "true",
  IDP_ROLE_CLAIM: "roles",
  IDP_ROLE_MAPPING: JSON.stringify(MAPPING),
}

let idp: FakeIdp
let mod: {
  auth: typeof import("./auth").auth
  deploymentIdp: typeof import("./deploymentIdp")
  idp: typeof import("./idpRoles")
  client: typeof import("./rpc-test-client")
  router: typeof import("./router")
  stream: typeof import("./stream")
  cli: typeof import("./cli-auth")
}
let orgId: string
let owner: { email: string; userId: string }
let roleIds: { admin: string; member: string; automation: string }
let audit: Array<Record<string, unknown>> = []
let clockNow = Math.floor(Date.now() / 1000)

const cookiesOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ")

/** One verified sign-in through the deployment IdP, end to end. */
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
    new Request(approved.headers.get("location") ?? "", {
      headers: { cookie: cookiesOf(start) },
    }),
  )
  return { location: done.headers.get("location") ?? "", cookie: cookiesOf(done) }
}

type Person = { email: string; sub: string }
const newPerson = (): Person => ({
  email: `p-${randomUUID()}@${DOMAIN}`,
  sub: `sub-${randomUUID()}`,
})

const signInAs = async (person: Person, claims: Record<string, unknown>) => {
  idp.setIdentity({ ...person, emailVerified: null, amr: MFA, claims })
  const res = await ssoSignIn()
  // A first SSO session predates its membership; any routed request adopts the
  // org (session.ts `adoptFirstOrg`), as the SPA's first request does.
  if (res.cookie.includes("session_token"))
    await mod.router.handleApi(
      new Request(`${ORIGIN}/api/version`, { headers: { cookie: res.cookie } }),
    )
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM bauth_user WHERE lower(email) = lower($1)",
    [person.email],
  )
  return { ...res, userId: rows[0]?.id ?? "", error: errorOf(res.location) }
}

const errorOf = (location: string) => new URL(location, ORIGIN).searchParams.get("error")

/** Held people roles + tier, in mapping vocabulary. */
const held = async (userId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ k: string }>(
    `SELECT coalesce(r.key, r.id::text) AS k FROM access_role_actors a
     JOIN access_roles r ON r.id = a.role_id
     WHERE a.org_id = $1 AND a.actor_id = $2 AND r.kind = 'user' AND r.personal_for IS NULL
     UNION ALL
     SELECT 'owner' FROM bauth_member
     WHERE organization_id = $1 AND user_id = $2 AND role = 'owner'
     ORDER BY 1`,
    [orgId, userId],
  )
  return rows.map((r) => r.k)
}

const sessionCount = async (userId: string): Promise<number> =>
  Number(
    (await pool.query("SELECT count(*)::int AS n FROM bauth_session WHERE user_id = $1", [userId]))
      .rows[0]?.n ?? 0,
  )

const verifiedAt = async (userId: string): Promise<number | null> => {
  const { rows } = await pool.query<{ v: string | null }>(
    "SELECT verified_at AS v FROM idp_role_identities WHERE user_id = $1",
    [userId],
  )
  return rows[0]?.v == null ? null : Number(rows[0].v)
}

const activation = async () =>
  (
    await pool.query<{ enabled: boolean; epoch: number }>(
      "SELECT enabled, epoch FROM idp_role_activation WHERE id = 1",
    )
  ).rows[0]

/** An automation actor holding an automation role — must never be touched. */
const automationHolds = async (actor: string): Promise<boolean> =>
  (
    await pool.query(
      "SELECT 1 FROM access_role_actors WHERE org_id = $1 AND role_id = $2 AND actor_id = $3",
      [orgId, roleIds.automation, actor],
    )
  ).rows.length === 1

const giveAutomation = async (): Promise<string> => {
  const actor = `system:automation:${randomUUID()}`
  await pool.query(
    "INSERT INTO access_role_actors (org_id, role_id, actor_id) VALUES ($1, $2, $3)",
    [orgId, roleIds.automation, actor],
  )
  return actor
}

/** The RPC surface as a caller with this cookie sees it. */
const rpc = async <A>(
  cookie: string,
  f: Parameters<ReturnType<typeof import("./rpc-test-client").rpcAs>["call"]>[0],
): Promise<
  { ok: true; value: A } | { ok: false; code: string; status: number; message: string }
> => {
  const api = mod.client.rpcAs(cookie)
  try {
    return { ok: true, value: (await api.call(f)) as A }
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string }
    return {
      ok: false,
      code: err.code ?? "?",
      status: err.status ?? 0,
      message: err.message ?? "",
    }
  } finally {
    await api.dispose()
  }
}
const myAccess = (cookie: string) =>
  rpc<{ rolesManagedByIdp: boolean }>(cookie, (c) => c.myAccess())

const parse = (env: Record<string, string>): Promise<RoleConfig> => mod.idp.loadIdpRoleConfig(env)

/**
 * Turn the mode on (persisted, as a boot would). After a NEW activation, wait for
 * the next second: evidence signed in the activation's own second is refused
 * (see `establishLogin`'s cutoff), as it would be for a real sign-in.
 */
const modeOn = async (extra: Record<string, string> = {}) => {
  const cfg = await parse({ ...MANAGED_ENV, ...extra })
  mod.idp.setIdpRoleConfig(cfg)
  const out = await mod.idp.activate(cfg)
  if (out.change !== "unchanged") await nextSecond()
  return out
}
const nextSecond = () => new Promise((r) => setTimeout(r, 1010 - (Date.now() % 1000)))
const modeOff = async () => {
  const cfg = await parse({})
  mod.idp.setIdpRoleConfig(cfg)
  return mod.idp.activate(cfg)
}

const capture = () => {
  audit = []
  mod.idp.setIdpAuditSink((l) => audit.push(JSON.parse(l) as Record<string, unknown>))
}
const events = (name: string) => audit.filter((e) => e.event === name)

const setNow = (t: number) => {
  clockNow = t
  mod.idp.setClock(() => clockNow)
  idp.setClock(() => clockNow)
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
    idp: await import("./idpRoles"),
    client: await import("./rpc-test-client"),
    router: await import("./router"),
    stream: await import("./stream"),
    cli: await import("./cli-auth"),
  }
  owner = await mod.client.signUp()
  const org = await mod.auth.api.createOrganization({
    body: { name: "IdP roles", slug: `idpr-${randomUUID().slice(0, 8)}`, userId: owner.userId },
  })
  if (!org) throw new Error("createOrganization returned null")
  orgId = org.id
  mod.deploymentIdp.setDeploymentOrgResolver(async () => orgId)
  await (await import("./authMethods")).writeAuthMethods(orgId, {
    passwordEnabled: true,
    ssoEnabled: true,
  })
  const { rows } = await pool.query<{ id: string; key: string }>(
    "SELECT id::text AS id, key FROM access_roles WHERE org_id = $1 AND key IS NOT NULL",
    [orgId],
  )
  const id = (k: string) => rows.find((r) => r.key === k)?.id ?? ""
  roleIds = { admin: id("admin"), member: id("member"), automation: id("automation_full") }
  await modeOff()
})

afterEach(async () => {
  mod.idp.setIdpAuditSink()
  mod.idp.setClock()
  mod.idp.setIdpTransport()
  idp.setClock()
  idp.setRefreshMode("ok")
  clockNow = Math.floor(Date.now() / 1000)
  await modeOff()
})

afterAll(async () => {
  if (mod) {
    await modeOff()
    mod.idp.setIdpRoleConfig(null)
    mod.deploymentIdp.setDeploymentOrgResolver()
  }
  for (const k of SSO_KEYS) delete process.env[k]
  await idp?.close()
})

// ── shared fixtures ─────────────────────────────────────────────────────────

describe("shared contract 0.1.0", () => {
  it("passes its common fixtures in this runtime", async () => {
    expect((await runCommonFixtures()).passed).toBeGreaterThan(0)
  })
})

// ── config ──────────────────────────────────────────────────────────────────

describe("config (IDP_*), validated against this org's roles", () => {
  it("is off by default and parses the managed shape", async () => {
    expect((await parse({})).enabled).toBe(false)
    const cfg = await parse(MANAGED_ENV)
    expect(cfg).toMatchObject({ enabled: true, claim: "roles", intervalSec: 3600 })
    expect(cfg.mapping["Kahuna.Admin"]).toEqual(["admin"])
  })

  it("rejects this branch's old names, unknown targets, names, and intervals over 3600", async () => {
    await expect(parse({ ...MANAGED_ENV, SSO_ROLE_MAP: "x=admin" })).rejects.toThrow()
    await expect(parse({ SSO_ROLES_FROM_IDP: "false" })).rejects.toThrow()
    await expect(
      parse({ ...MANAGED_ENV, IDP_ROLE_MAPPING: '{"A":["no-such-role"]}' }),
    ).rejects.toThrow()
    // Targets are keys or ids, never renameable names.
    await expect(parse({ ...MANAGED_ENV, IDP_ROLE_MAPPING: '{"A":["Admin"]}' })).rejects.toThrow()
    expect(
      (await parse({ ...MANAGED_ENV, IDP_ROLE_MAPPING: JSON.stringify({ A: [roleIds.admin] }) }))
        .mapping.A,
    ).toEqual([roleIds.admin])
    await expect(parse({ ...MANAGED_ENV, IDP_RECHECK_INTERVAL_SECONDS: "3601" })).rejects.toThrow()
    await expect(parse({ IDP_ROLES_ENABLED: "true" })).rejects.toThrow()
  })
})

// ── the shared acceptance suite, on native observations ─────────────────────

/**
 * Each scenario resets to a fresh activation and fresh people, then drives the real
 * routes and reads the real tables. Observations are what happened, never echoes
 * of what the scenario expects.
 */
const scenario = async (s: AcceptanceScenario): Promise<AcceptanceObservation> => {
  await modeOff()
  if (s !== "mode_off") await modeOn()
  capture()
  const base = { nativeIntegration: true as const }

  switch (s) {
    case "mode_off": {
      // SSO ignores the claim and lands on auto-assign; password and in-app
      // role changes work as before.
      const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const ownerCookie = await mod.client.cookieFor(owner.email)
      const assigned = await rpc(ownerCookie, (c) =>
        c.assignRole({ roleId: roleIds.admin, userId: a.userId }),
      )
      const access = await myAccess(a.cookie)
      return {
        ...base,
        allowed: access.ok && assigned.ok,
        grants: await held(a.userId),
        localBehaviorPreserved:
          ownerCookie.includes("session_token") &&
          access.ok &&
          !access.value.rolesManagedByIdp &&
          audit.length === 0,
      }
    }
    case "grant": {
      const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const access = await myAccess(a.cookie)
      return { ...base, allowed: access.ok, grants: await held(a.userId) }
    }
    case "remove": {
      const p = newPerson()
      const first = await signInAs(p, { roles: ["Kahuna.Admin", "Kahuna.Member"] })
      const previousGrants = await held(first.userId)
      const again = await signInAs(p, { roles: ["Kahuna.Member"] })
      const access = await myAccess(again.cookie)
      return { ...base, allowed: access.ok, grants: await held(first.userId), previousGrants }
    }
    case "deny":
    case "invalid_claim":
    case "credentials_revoked": {
      const p = newPerson()
      const bot = await giveAutomation()
      const first = await signInAs(p, { roles: ["Kahuna.Admin"] })
      const second = await signInAs(p, { roles: ["Kahuna.Admin"] }) // a second credential
      const previousGrants = await held(first.userId)
      const claims =
        s === "invalid_claim" ? { roles: { admin: true } } : { roles: ["Kahuna.Nothing"] }
      const denied = await signInAs(p, claims)
      const oldCookie = await myAccess(first.cookie)
      const cliCookie = await myAccess(second.cookie)
      return {
        ...base,
        allowed: !denied.error && !denied.cookie.includes("session_token"),
        grants: await held(first.userId),
        previousGrants,
        humanSessionsRevoked: (await sessionCount(first.userId)) === 0 && !oldCookie.ok,
        userCredentialsRevoked: !cliCookie.ok,
        automationCredentialsPreserved: await automationHolds(bot),
        errorCode: denied.error ?? undefined,
      }
    }
    case "password_refused": {
      const res = await mod.auth.api
        .signInEmail({ body: { email: owner.email, password: mod.client.PASSWORD } })
        .then(() => null)
        .catch((e: { body?: { code?: string } }) => e.body?.code ?? "?")
      return {
        ...base,
        allowed: res === null,
        grants: [],
        requiresSso: res === "PASSWORD_SIGN_IN_DISABLED",
        errorCode: res ?? undefined,
      }
    }
    case "local_change_refused": {
      const admin = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const target = await signInAs(newPerson(), { roles: ["Kahuna.Member"] })
      const r = await rpc(admin.cookie, (c) =>
        c.assignRole({ roleId: roleIds.admin, userId: target.userId }),
      )
      return {
        ...base,
        allowed: r.ok,
        grants: await held(target.userId),
        ...(r.ok ? {} : { statusCode: r.status, errorCode: r.code, message: r.message }),
      }
    }
    case "freshness_deadline": {
      const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const before = await verifiedAt(a.userId)
      setNow((before ?? 0) + 3600)
      idp.setRefreshMode("no_id_token")
      const r = await myAccess(a.cookie)
      return {
        ...base,
        allowed: r.ok,
        grants: await held(a.userId),
        requiresSso: !r.ok && r.code === mod.idp.IDP_REAUTH_REQUIRED,
        verifiedAtUnchanged: (await verifiedAt(a.userId)) === before,
      }
    }
    case "activation": {
      const bot = await giveAutomation()
      const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const epochBefore = (await activation())?.epoch ?? 0
      // Restart with the same config: nothing changes, the session stays.
      const restart = await modeOn()
      const stillValid = (await myAccess(a.cookie)).ok
      // Off then on: a new epoch, every human session ended.
      await modeOff()
      const on = await modeOn()
      const persisted = await activation()
      const oldSession = await myAccess(a.cookie)
      // A sign-in after activation is valid, and a further restart keeps it.
      const b = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      await modeOn()
      const fresh = await myAccess(b.cookie)
      return {
        ...base,
        allowed: fresh.ok,
        grants: await held(b.userId),
        activationPersisted: persisted?.enabled === true && persisted.epoch === on.epoch,
        activationIdempotent: restart.change === "unchanged" && stillValid,
        humanSessionsRevoked:
          on.epoch === epochBefore + 1 && !oldSession.ok && (await sessionCount(a.userId)) === 0,
        userCredentialsRevoked: !oldSession.ok,
        automationCredentialsPreserved: await automationHolds(bot),
        newlyVerifiedSessionValid: fresh.ok,
      }
    }
    case "audit": {
      const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const line = events("idp_roles.granted").find((e) => e.subject === a.userId)
      if (!line) return { ...base, allowed: false, grants: [] }
      const { ts, type, level, outcome, ...contract } = line
      void ts
      void type
      void level
      void outcome
      return {
        ...base,
        allowed: true,
        grants: await held(a.userId),
        audit: contract as unknown as AcceptanceObservation["audit"],
      }
    }
  }
}

describe("shared acceptance suite, native routes and storage", () => {
  it("passes every scenario", async () => {
    const { passed } = await runAdapterAcceptance({ run: scenario })
    expect(passed).toBeGreaterThan(0)
  }, 120_000)
})

// ── native-only coverage ────────────────────────────────────────────────────

describe("managed sign-in", () => {
  it("persists the signed iat, binds the session, audits with the contract fields", async () => {
    await modeOn()
    capture()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Member"] })
    const v = await verifiedAt(a.userId)
    expect(v).not.toBeNull()
    expect(Math.abs((v ?? 0) - Math.floor(Date.now() / 1000))).toBeLessThan(30)
    expect(
      (await pool.query("SELECT 1 FROM idp_role_sessions WHERE user_id = $1", [a.userId])).rows,
    ).toHaveLength(1)
    const [line] = events("idp_roles.granted")
    expect(line).toEqual(
      expect.objectContaining({
        service: "kahuna",
        actor: "system:idp-roles",
        subject: a.userId,
        source: "oidc",
        previousGrants: [],
        newGrants: ["member"],
        reason: "login",
      }),
    )
    expect(JSON.stringify(audit)).not.toMatch(/eyJ|rt-|refresh/)
  })

  it("never auto-assigns: a managed sign-in holds only what the claim maps to", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    expect(await held(a.userId)).toEqual(["admin"])
  })

  it("manages the owner tier always: granted by a claim, legacy owners demoted", async () => {
    await modeOn()
    const p = newPerson()
    const first = await signInAs(p, { roles: ["Kahuna.Owner", "Kahuna.Admin"] })
    expect(await held(first.userId)).toEqual(["admin", "owner"])
    await signInAs(p, { roles: ["Kahuna.Admin"] })
    expect(await held(first.userId)).toEqual(["admin"])

    // An owner made in the app before the mode existed, and a mapping with no owner.
    const legacy = newPerson()
    await modeOff()
    const pre = await signInAs(legacy, {})
    await pool.query(
      "UPDATE bauth_member SET role = 'owner' WHERE organization_id = $1 AND user_id = $2",
      [orgId, pre.userId],
    )
    await modeOn({ IDP_ROLE_MAPPING: JSON.stringify({ "Kahuna.Admin": ["admin"] }) })
    await signInAs(legacy, { roles: ["Kahuna.Admin"] })
    expect(await held(pre.userId)).toEqual(["admin"])
  })

  it("keeps personal overrides: they are local, not the IdP's", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    const personal = await rpc<{ id: string }>(a.cookie, (c) =>
      c.ensurePersonalRole({ userId: a.userId }),
    )
    expect(personal.ok).toBe(true)
    await signInAs(p, { roles: ["Kahuna.Member"] })
    const { rows } = await pool.query(
      `SELECT 1 FROM access_role_actors a JOIN access_roles r ON r.id = a.role_id
       WHERE a.actor_id = $1 AND r.personal_for = $1`,
      [a.userId],
    )
    expect(rows).toHaveLength(1)
  })
})

describe("in-app role changes while managed", () => {
  it("refuses every holder change over RPC, the owner toggle, and BetterAuth's org routes", async () => {
    await modeOn()
    const admin = await signInAs(newPerson(), { roles: ["Kahuna.Owner", "Kahuna.Admin"] })
    const t = await signInAs(newPerson(), { roles: ["Kahuna.Member"] })
    capture()
    const want = {
      ok: false,
      status: 409,
      code: "ROLES_MANAGED_BY_IDP",
      message: "Roles are managed by your identity provider.",
    }
    expect(
      await rpc(admin.cookie, (c) => c.assignRole({ roleId: roleIds.admin, userId: t.userId })),
    ).toEqual(want)
    expect(
      await rpc(admin.cookie, (c) => c.unassignRole({ roleId: roleIds.member, userId: t.userId })),
    ).toEqual(want)
    expect(
      await rpc(admin.cookie, (c) =>
        c.reorderMemberRoles({ userId: t.userId, roleIds: [roleIds.member] }),
      ),
    ).toEqual(want)
    expect(
      await rpc(admin.cookie, (c) =>
        c.reassignRoleHolders({ fromRoleId: roleIds.member, toRoleId: roleIds.admin }),
      ),
    ).toEqual(want)

    const toggle = await mod.router.handleApi(
      new Request(`${ORIGIN}/api/org/members/${t.userId}/role`, {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ role: "owner" }),
      }),
    )
    expect(toggle?.status).toBe(409)

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM bauth_member WHERE organization_id = $1 AND user_id = $2",
      [orgId, t.userId],
    )
    const direct = await mod.auth.handler(
      new Request(`${ORIGIN}/api/auth/organization/update-member-role`, {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ memberId: rows[0]?.id, role: "owner", organizationId: orgId }),
      }),
    )
    expect(direct.status).toBe(409)
    expect(await held(t.userId)).toEqual(["member"])
    expect(events("idp_roles.local_change_refused").map((e) => e.reason)).toEqual([
      "assignRole",
      "unassignRole",
      "reorderMemberRoles",
      "reassignRoleHolders",
      "setMemberRole",
      "/organization/update-member-role",
    ])
    const access = await myAccess(admin.cookie)
    expect(access.ok && access.value.rolesManagedByIdp).toBe(true)
  })

  it("Settings → Authentication shows the effective SSO-only state; stored toggles kept", async () => {
    const sso = await import("./sso")
    const read = async (cookie: string) =>
      (await sso
        .authConfigStatus(new Request(`${ORIGIN}/api/auth-config/sso`, { headers: { cookie } }))
        .then((r) => r.json())) as {
        methods: { passwordEnabled: boolean; ownerPasswordFallback: boolean }
        idpRolesManaged: boolean
      }
    const ownerCookie = await mod.client.cookieFor(owner.email)
    const off = await read(ownerCookie)
    expect(off.idpRolesManaged).toBe(false)
    expect(await sso.publicAuthMethodsFor(orgId)).toMatchObject({ passwordEnabled: true })

    await modeOn()
    const admin = await signInAs(newPerson(), { roles: ["Kahuna.Owner", "Kahuna.Admin"] })
    const on = await read(admin.cookie)
    expect(on.idpRolesManaged).toBe(true)
    // The stored setting is untouched (it applies again with the mode off)…
    expect(on.methods).toMatchObject({ passwordEnabled: true, ownerPasswordFallback: true })
    // …while the sign-in page is told what is actually accepted.
    expect(await sso.publicAuthMethodsFor(orgId)).toEqual({
      passwordEnabled: false,
      ownerPasswordFallback: false,
      ssoEnabled: true,
      ssoProviderId: "deployment-idp",
    })
  })

  it("refuses password sign-in for everyone, owners included, with no fallback", async () => {
    await modeOn()
    const res = await mod.auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: owner.email, password: mod.client.PASSWORD }),
      }),
    )
    expect(res.status).toBe(403)
    expect(cookiesOf(res)).not.toContain("session_token")
  })
})

describe("the freshness deadline (≤ 3600 s), at every entry point", () => {
  it("revalidates at the deadline: refreshed roles applied, signed iat persisted", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    const v0 = (await verifiedAt(a.userId)) ?? 0
    const refreshesBefore = idp.refreshRequests.length

    setNow(v0 + 3599) // still fresh: no refresh
    expect((await myAccess(a.cookie)).ok).toBe(true)
    expect(idp.refreshRequests.length).toBe(refreshesBefore)

    // Roles changed at the IdP; the deadline is inclusive.
    idp.setIdentity({ ...p, emailVerified: null, amr: MFA, claims: { roles: ["Kahuna.Member"] } })
    setNow(v0 + 3600)
    capture()
    expect((await myAccess(a.cookie)).ok).toBe(true)
    expect(idp.refreshRequests.length).toBe(refreshesBefore + 1)
    expect(await verifiedAt(a.userId)).toBe(v0 + 3600)
    expect(await held(a.userId)).toEqual(["member"])
    expect(events("idp_roles.revalidated")[0]).toMatchObject({
      previousGrants: ["admin"],
      newGrants: ["member"],
      reason: "verified",
    })
  })

  it("spends the refresh token once when requests race the deadline", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    setNow(((await verifiedAt(a.userId)) ?? 0) + 3600)
    const before = idp.refreshRequests.length
    const results = await Promise.all([myAccess(a.cookie), myAccess(a.cookie), myAccess(a.cookie)])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(idp.refreshRequests.length).toBe(before + 1)
  })

  for (const mode of ["no_id_token", "error"] as const) {
    it(`refresh ${mode}: refused everywhere, sessions ended, roles cleared, time not extended`, async () => {
      await modeOn()
      const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
      const v0 = await verifiedAt(a.userId)
      setNow((v0 ?? 0) + 3600)
      idp.setRefreshMode(mode)
      const r = await myAccess(a.cookie)
      expect(r).toMatchObject({ ok: false, status: 401, code: "IDP_REAUTH_REQUIRED" })
      expect(await verifiedAt(a.userId)).toBe(v0)
      expect(await held(a.userId)).toEqual([])
      expect(await sessionCount(a.userId)).toBe(0)
    })
  }

  it("gates the /api routes, the SSE stream, BetterAuth's session endpoint and CLI polling", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    // A live stream is ended by the revocation.
    const live = await mod.stream.streamHandler(
      new Request(`${ORIGIN}/api/stream`, { headers: { cookie: a.cookie } }),
    )
    expect(live.status).toBe(200)
    const reader = live.body?.getReader()
    await reader?.read() // ": connected"
    // A CLI hand-over approved before the deadline.
    const deviceCode = randomUUID()
    const sessionId = (
      await pool.query<{ id: string }>("SELECT id FROM bauth_session WHERE user_id = $1", [
        a.userId,
      ])
    ).rows[0]?.id
    mod.cli.__pendingForTest.set(deviceCode, {
      userCode: "TEST-CODE",
      status: "approved",
      cookie: a.cookie,
      userId: a.userId,
      sessionId,
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })

    setNow(((await verifiedAt(a.userId)) ?? 0) + 3600)
    idp.setRefreshMode("error")
    const route = await mod.router.handleApi(
      new Request(`${ORIGIN}/api/version`, { headers: { cookie: a.cookie } }),
    )
    expect(route?.status).toBe(401)
    // The revocation ended the stream and dropped the hand-over.
    const ended = await reader?.read()
    expect(ended?.done).toBe(true)
    expect(mod.cli.__pendingForTest.has(deviceCode)).toBe(false)
    const reopen = await mod.stream.streamHandler(
      new Request(`${ORIGIN}/api/stream`, { headers: { cookie: a.cookie } }),
    )
    expect(reopen.status).toBe(401)
    const session = await mod.auth.handler(
      new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: a.cookie } }),
    )
    // The session was revoked with the person: BetterAuth answers "no session".
    expect(await session.json()).toBeNull()
  })

  /** Open a live stream as this cookie; frames are collected as they arrive. */
  const openStream = async (cookie: string) => {
    const res = await mod.stream.streamHandler(
      new Request(`${ORIGIN}/api/stream`, { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    const reader = res.body?.getReader()
    if (!reader) throw new Error("no body")
    const decoder = new TextDecoder()
    const frames: string[] = []
    let done = false
    const pump = (async () => {
      for (;;) {
        const r = await reader.read()
        if (r.done) {
          done = true
          return
        }
        frames.push(decoder.decode(r.value))
      }
    })()
    return { frames, isDone: () => done, closed: pump }
  }
  const envelope = (id: number) => ({
    org: orgId,
    id,
    at: Date.now(),
    kind: "label" as const,
    subjectId: randomUUID(),
    type: "LabelCreated",
    conceptId: null,
    concept: null,
    actor: null,
  })
  const tick = () => new Promise((r) => setTimeout(r, 50))

  it("SSE: frames flow at 3599 s, none at 3600 s, and the stream ends (production wiring)", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    const v0 = (await verifiedAt(a.userId)) ?? 0
    setNow(v0 + 3599)
    const s = await openStream(a.cookie)
    // The stream finishes its setup asynchronously; dispatch until it delivers.
    for (let i = 0; i < 40 && !s.frames.join("").includes("id: 9000001"); i++) {
      mod.stream.dispatch(envelope(9_000_001) as never)
      await tick()
    }
    expect(s.frames.join("")).toContain("id: 9000001")
    setNow(v0 + 3600)
    mod.stream.dispatch(envelope(9_000_002) as never)
    await s.closed
    expect(s.frames.join("")).not.toContain("id: 9000002")
  })

  it("SSE: closes AT the deadline with no traffic, without waiting on a hung refresh", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    const v0 = (await verifiedAt(a.userId)) ?? 0
    let refreshCalled = false
    mod.idp.setIdpTransport({
      refresh: () => {
        refreshCalled = true
        return new Promise(() => {}) // never answers
      },
    })
    // A millisecond clock that runs with real time, starting 0.7 s before the
    // deadline (…3599.3): the stream must close within the remaining 0.7 s, not
    // linger to …3600.999 as a floored-seconds timer would.
    const t0 = Date.now()
    const start = (v0 + 3600) * 1000 - 700
    mod.idp.setClockMs(() => start + (Date.now() - t0))
    try {
      const s = await openStream(a.cookie)
      await s.closed
      const closedAt = start + (Date.now() - t0)
      expect(closedAt).toBeGreaterThanOrEqual((v0 + 3600) * 1000)
      expect(closedAt - (v0 + 3600) * 1000).toBeLessThan(250)
      expect(refreshCalled).toBe(false)
    } finally {
      mod.idp.setClockMs()
    }
  })

  it("drops an approved CLI hand-over when the person is revoked", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    const deviceCode = randomUUID()
    mod.cli.__pendingForTest.set(deviceCode, {
      userCode: "TEST-CODE",
      status: "approved",
      cookie: a.cookie,
      userId: a.userId,
      sessionId: "x",
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })
    await signInAs(p, { roles: ["Kahuna.Nothing"] })
    expect(mod.cli.__pendingForTest.has(deviceCode)).toBe(false)
  })

  it("never hands a CLI a session that is not in the current epoch", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    const deviceCode = randomUUID()
    mod.cli.__pendingForTest.set(deviceCode, {
      userCode: "TEST-CODE",
      status: "approved",
      cookie: a.cookie,
      userId: a.userId,
      sessionId: "not-a-bound-session",
      expiresAt: Date.now() + 60_000,
      attempts: 0,
    })
    const res = await mod.cli.pollDevice(
      new Request(`${ORIGIN}/api/cli/device/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      }),
    )
    expect(await res.json()).toMatchObject({ status: "expired" })
  })
})

describe("persisted activation fences every replica", () => {
  it("a replica still running with the mode OFF refuses once the database says on", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    // This process now believes the mode is off; the database still says on.
    mod.idp.setIdpRoleConfig(await parse({}))
    const r = await myAccess(a.cookie)
    expect(r).toMatchObject({ ok: false, status: 503, code: "IDP_ROLES_CONFIG_MISMATCH" })
    const pw = await mod.auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: owner.email, password: mod.client.PASSWORD }),
      }),
    )
    expect(pw.status).toBe(403)
    // And it never auto-assigns a role on the way in.
    const late = await signInAs(newPerson(), {})
    expect(await held(late.userId)).toEqual([])
  })

  it("a replica with a different config identity (interval) refuses", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    mod.idp.setIdpRoleConfig(await parse({ ...MANAGED_ENV, IDP_RECHECK_INTERVAL_SECONDS: "1800" }))
    expect(await myAccess(a.cookie)).toMatchObject({ ok: false, status: 503 })
  })

  it("both off: untouched", async () => {
    await modeOff()
    const ownerCookie = await mod.client.cookieFor(owner.email)
    expect((await myAccess(ownerCookie)).ok).toBe(true)
  })

  it("a config change is a new epoch; credentials issued late never resurrect", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    // A password session minted by an off replica during the switch.
    await modeOff()
    const stray = await mod.client.cookieFor(owner.email)
    const changed = await modeOn({ IDP_RECHECK_INTERVAL_SECONDS: "1800" })
    expect(changed.change).toBe("activated")
    expect((await myAccess(a.cookie)).ok).toBe(false)
    // Same mode, new mapping: config_changed, new epoch, sessions ended again.
    const b = await signInAs(p, { roles: ["Kahuna.Admin"] })
    const next = await modeOn({
      IDP_RECHECK_INTERVAL_SECONDS: "1800",
      IDP_ROLE_MAPPING: JSON.stringify({ ...MAPPING, "Kahuna.Extra": ["member"] }),
    })
    expect(next).toMatchObject({ change: "config_changed", epoch: changed.epoch + 1 })
    expect((await myAccess(b.cookie)).ok).toBe(false)
    // The owner later signs in through the IdP; the stray session stays dead.
    await pool.query("UPDATE bauth_user SET email = $1 WHERE id = $2", [
      `owner-${randomUUID()}@${DOMAIN}`,
      owner.userId,
    ])
    const fresh = await signInAs(p, { roles: ["Kahuna.Admin"] })
    expect((await myAccess(fresh.cookie)).ok).toBe(true)
    expect((await myAccess(stray)).ok).toBe(false)
    expect((await myAccess(a.cookie)).ok).toBe(false)
  })
})

// ── controlled interleavings ────────────────────────────────────────────────

/** Make a person's evidence due now, without moving the clock (test setup). */
const makeDue = (userId: string) =>
  pool.query("UPDATE idp_role_identities SET verified_at = verified_at - 3600 WHERE user_id = $1", [
    userId,
  ])

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The SSO round trip split in two, so something can land between the halves. */
const ssoStart = async (person: Person, claims: Record<string, unknown>) => {
  idp.setIdentity({ ...person, emailVerified: null, amr: MFA, claims })
  const start = await mod.auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ providerId: "deployment-idp", callbackURL: "/home" }),
    }),
  )
  const { url } = (await start.json()) as { url: string }
  const approved = await fetch(url, { redirect: "manual" })
  return { callback: approved.headers.get("location") ?? "", cookie: cookiesOf(start) }
}
const ssoFinish = async (s: { callback: string; cookie: string }) => {
  const done = await mod.auth.handler(new Request(s.callback, { headers: { cookie: s.cookie } }))
  return {
    status: done.status,
    location: done.headers.get("location") ?? "",
    cookie: cookiesOf(done),
  }
}

describe("interleavings at the auth lifecycle boundary", () => {
  it("a failed refresh holding the lock cannot delete a newer sign-in waiting on it", async () => {
    await modeOn()
    const p = newPerson()
    const first = await signInAs(p, { roles: ["Kahuna.Admin"] })
    await makeDue(first.userId)

    // The refresh is in flight (holding the person's lock) and will fail.
    const inFlight = deferred<{ idToken?: string | null }>()
    const called = deferred<void>()
    mod.idp.setIdpTransport({
      refresh: () => {
        called.resolve()
        return inFlight.promise
      },
    })
    const oldRequest = myAccess(first.cookie)
    await called.promise

    // A newer verified sign-in arrives: the plugin commits its session, then
    // provisioning waits on the lock.
    const login = ssoStart(p, { roles: ["Kahuna.Member"] }).then(ssoFinish)
    await new Promise((r) => setTimeout(r, 300))
    inFlight.reject(new Error("token endpoint down"))

    expect(await oldRequest).toMatchObject({ ok: false, code: "IDP_REAUTH_REQUIRED" })
    const fresh = await login
    expect(fresh.cookie).toContain("session_token")
    expect(await held(first.userId)).toEqual(["member"])
    await mod.router.handleApi(
      new Request(`${ORIGIN}/api/version`, { headers: { cookie: fresh.cookie } }),
    )
    expect((await myAccess(fresh.cookie)).ok).toBe(true)
    expect((await myAccess(first.cookie)).ok).toBe(false)

    // The next shared refresh spends the NEWER sign-in's refresh token.
    mod.idp.setIdpTransport()
    const newest = idp.issuedRefreshTokens.at(-1)
    await makeDue(first.userId)
    expect((await myAccess(fresh.cookie)).ok).toBe(true)
    expect(idp.refreshRequests.at(-1)).toBe(newest)
  })

  it("a late, OLDER no-role assertion cannot revoke newer evidence", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    const v = (await verifiedAt(a.userId)) ?? 0
    capture()
    await mod.idp.denyLogin({ sub: p.sub, iat: v - 60, roles: [] }, "no_mapped_role", "x")
    expect(await held(a.userId)).toEqual(["admin"])
    expect((await myAccess(a.cookie)).ok).toBe(true)
    expect(events("idp_roles.denied")[0]).toMatchObject({ reason: "stale_evidence" })
  })

  it("after a newer denial, an OLDER mapped assertion cannot restore access", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    const v = (await verifiedAt(a.userId)) ?? 0
    await mod.idp.denyLogin({ sub: p.sub, iat: v, roles: [] }, "no_mapped_role", "x")
    expect(await held(a.userId)).toEqual([])
    await expect(
      mod.idp.establishLogin(a.userId, { sub: p.sub, iat: v, roles: ["Kahuna.Admin"] }, null),
    ).rejects.toThrow()
    expect(await held(a.userId)).toEqual([])
    // A genuinely newer sign-in restores it.
    await new Promise((r) => setTimeout(r, 1100))
    const again = await signInAs(p, { roles: ["Kahuna.Admin"] })
    expect((await myAccess(again.cookie)).ok).toBe(true)
  })

  it("an old-config callback landing after a new activation mints nothing usable", async () => {
    const oldCfg = await parse(MANAGED_ENV)
    await modeOn()
    const p = newPerson()
    const half = await ssoStart(p, { roles: ["Kahuna.Admin"] })
    // Meanwhile the deployment re-maps (new epoch, new config identity)…
    const newEnv = {
      ...MANAGED_ENV,
      IDP_ROLE_MAPPING: JSON.stringify({ "Kahuna.Admin": ["member"] }),
    }
    await modeOn(newEnv)
    // …and an old replica, still on the old mapping, receives the callback.
    mod.idp.setIdpRoleConfig(oldCfg)
    const landed = await ssoFinish(half)
    // Provisioning refuses it (fence mismatch), so no cookie is handed out.
    expect(landed.status).toBe(403)
    expect(landed.cookie).not.toContain("session_token")
    // The new runtime never honours whatever that minted.
    mod.idp.setIdpRoleConfig(await parse(newEnv))
    expect((await myAccess(landed.cookie)).ok).toBe(false)
    const { rows } = await pool.query(
      "SELECT 1 FROM idp_role_identities WHERE subject = $1 AND verified_at IS NOT NULL",
      [p.sub],
    )
    expect(rows).toHaveLength(0)
  })

  it("evidence signed before the activation never mints a post-activation session", async () => {
    await modeOn()
    const p = newPerson()
    // The ID token is signed BEFORE the next activation (a pending sign-in, or a
    // token cached/replayed from before it)…
    const signedAt = Math.floor(Date.now() / 1000)
    idp.setClock(() => signedAt)
    const half = await ssoStart(p, { roles: ["Kahuna.Admin"] })
    // …the deployment re-activates (same process, new config identity)…
    await modeOn({ IDP_ROLE_MAPPING: JSON.stringify({ ...MAPPING, "Kahuna.Other": ["member"] }) })
    // …and the callback is delivered afterwards, with that older evidence.
    const landed = await ssoFinish(half)
    expect(landed.status).toBe(403)
    expect(landed.cookie).not.toContain("session_token")
    // A genuinely fresh sign-in works.
    idp.setClock()
    const fresh = await signInAs(p, { roles: ["Kahuna.Admin"] })
    expect((await myAccess(fresh.cookie)).ok).toBe(true)
  })

  it("evidence signed before a denial never mints a session after it (delayed callback)", async () => {
    await modeOn()
    const p = newPerson()
    const a = await signInAs(p, { roles: ["Kahuna.Admin"] })
    await nextSecond()
    // A sign-in is started; its evidence is signed now…
    const signedAt = Math.floor(Date.now() / 1000)
    idp.setClock(() => signedAt)
    const half = await ssoStart(p, { roles: ["Kahuna.Admin"] })
    // …a newer, signed denial is processed first…
    await nextSecond()
    await mod.idp.denyLogin(
      { sub: p.sub, iat: Math.floor(Date.now() / 1000), roles: [] },
      "no_mapped_role",
      "x",
    )
    expect(await held(a.userId)).toEqual([])
    // …then the delayed callback arrives: refused, nothing restored.
    const landed = await ssoFinish(half)
    expect(landed.status).toBe(403)
    expect(await held(a.userId)).toEqual([])
    idp.setClock()
    await nextSecond()
    const fresh = await signInAs(p, { roles: ["Kahuna.Admin"] })
    expect((await myAccess(fresh.cookie)).ok).toBe(true)
  })

  it("the database switching OFF mid-flight refuses without destroying anything", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    await makeDue(a.userId)
    const on = await parse(MANAGED_ENV)
    await modeOff()
    mod.idp.setIdpRoleConfig(on) // this process has not caught up
    expect(await myAccess(a.cookie)).toMatchObject({ ok: false, status: 503 })
    expect(await held(a.userId)).toEqual(["admin"])
    expect(await sessionCount(a.userId)).toBe(1)
  })

  it("BetterAuth's provider-token routes cannot spend a second token store", async () => {
    await modeOn()
    const a = await signInAs(newPerson(), { roles: ["Kahuna.Admin"] })
    const { rows } = await pool.query<{ rt: string | null; at: string | null }>(
      "SELECT refresh_token AS rt, access_token AS at FROM bauth_account WHERE user_id = $1 AND provider_id = 'deployment-idp'",
      [a.userId],
    )
    expect(rows[0]).toEqual({ rt: null, at: null })
    await makeDue(a.userId)
    const before = idp.refreshRequests.length
    const route = (path: string) =>
      mod.auth.handler(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method: "POST",
          headers: { cookie: a.cookie, "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ providerId: "deployment-idp" }),
        }),
      )
    const [r1, r2, recheck] = await Promise.all([
      route("/refresh-token"),
      route("/get-access-token"),
      myAccess(a.cookie),
    ])
    expect([r1.status, r2.status]).toEqual([403, 403])
    expect(recheck.ok).toBe(true)
    expect(idp.refreshRequests.length).toBe(before + 1)
  })
})
