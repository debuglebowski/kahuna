import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { pool } from "./db"
import { createUserDirect } from "./provision"
import { handleApi, isBetterAuthPath, isBlockedSsoPath } from "./router"
import { runEngineOrThrow, systemScope } from "./runtime"
import { deactivateMember, listDeactivatedMembers } from "./use-cases"

/** Convert a Set-Cookie response header into a request Cookie header. */
const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

const signUp = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  const created = await createUserDirect({ email, password, name: "Tester" })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  return { email, headers, userId: created.userId }
}

const signUpAndOrg = async () => {
  const u = await signUp()
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: u.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: u.headers })
  return { ...u, orgId: org.id }
}

const postMember = (headers: Headers, body: unknown) => {
  const h = new Headers(headers)
  h.set("content-type", "application/json")
  return handleApi(
    new Request("http://localhost/api/org/members", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    }),
  )
}

/**
 * THE TIER-FREE ADMIN PATH.
 *
 * `/api/org` exists because BetterAuth's own `organization.update` decides from the
 * caller's MEMBERSHIP tier, and an administrator is a membership-`member` holding the
 * Admin role now — that endpoint would refuse them. If this route ever regresses to a
 * tier check, renaming the org silently becomes owner-only.
 */
describe("POST /api/org (rename)", () => {
  const postOrg = (headers: Headers, body: unknown) =>
    handleApi(
      new Request("http://localhost/api/org", {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(headers),
          "content-type": "application/json",
        }),
        body: JSON.stringify(body),
      }),
    )

  it("an administrator who is NOT an owner can rename the org", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const added = await postMember(owner.headers, { email: target.email })
    const { userId } = (await added?.json()) as { userId: string }
    await auth.api.setActiveOrganization({
      body: { organizationId: owner.orgId },
      headers: target.headers,
    })

    // A plain member cannot.
    expect((await postOrg(target.headers, { name: "Nope" }))?.status).toBe(403)

    // Grant the Admin role — no membership change at all.
    const adminRole = await pool.query<{ id: string }>(
      "SELECT id FROM access_roles WHERE org_id = $1 AND key = 'admin' LIMIT 1",
      [owner.orgId],
    )
    await pool.query(
      `INSERT INTO access_role_actors (org_id, role_id, actor_id) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, actor_id) DO NOTHING`,
      [owner.orgId, adminRole.rows[0]!.id, userId],
    )
    await pool.query(
      `INSERT INTO access_policy_versions (org_id, version) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET version = access_policy_versions.version + 1`,
      [owner.orgId],
    )

    const res = await postOrg(target.headers, { name: "Renamed by an admin" })
    expect(res?.status).toBe(200)
    expect(((await res?.json()) as { name: string }).name).toBe("Renamed by an admin")

    // Still a plain member as far as BetterAuth is concerned — which is the point.
    const [row] = await pool
      .query<{ role: string }>(
        "SELECT role FROM bauth_member WHERE organization_id = $1 AND user_id = $2",
        [owner.orgId, userId],
      )
      .then((r) => r.rows)
    expect(row?.role).toBe("member")
  })

  it("refuses an empty name", async () => {
    const owner = await signUpAndOrg()
    expect((await postOrg(owner.headers, { name: "   " }))?.status).toBe(400)
  })
})

describe("POST /api/org/members (add member by email)", () => {
  it("admin adds an existing user; duplicates and unknowns are rejected", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()

    const ok = await postMember(owner.headers, { email: target.email, role: "member" })
    expect(ok?.status).toBe(201)

    const dup = await postMember(owner.headers, { email: target.email, role: "member" })
    expect(dup?.status).toBe(409)

    const missing = await postMember(owner.headers, {
      email: `nobody-${randomUUID()}@test.dev`,
      role: "member",
    })
    expect(missing?.status).toBe(404)
  })

  it("the email match is case-insensitive", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const res = await postMember(owner.headers, {
      email: target.email.toUpperCase(),
      role: "admin",
    })
    expect(res?.status).toBe(201)
  })

  it("non-admin members are forbidden (403)", async () => {
    const owner = await signUpAndOrg()
    const member = await signUp()
    await postMember(owner.headers, { email: member.email, role: "member" })
    // The member signed in before joining, so point their session at the org.
    await auth.api.setActiveOrganization({
      body: { organizationId: owner.orgId },
      headers: member.headers,
    })
    const res = await postMember(member.headers, {
      email: `x-${randomUUID()}@test.dev`,
      role: "member",
    })
    expect(res?.status).toBe(403)
  })

  it("rejects an unauthenticated request", async () => {
    const res = await postMember(new Headers(), { email: "x@test.dev", role: "member" })
    expect(res?.ok).toBe(false)
    expect(res?.status).toBe(401)
  })
})

describe("POST /api/org/members/:userId/role (change a member's role)", () => {
  const postRole = (headers: Headers, userId: string, body: unknown) => {
    const h = new Headers(headers)
    h.set("content-type", "application/json")
    return handleApi(
      new Request(`http://localhost/api/org/members/${userId}/role`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      }),
    )
  }

  it("an owner makes and unmakes owners; refuses to unmake the LAST one", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const added = await postMember(owner.headers, { email: target.email })
    const { userId } = (await added?.json()) as { userId: string }

    // Make them an owner, then take it back.
    expect((await postRole(owner.headers, userId, { role: "owner" }))?.status).toBe(200)
    expect((await postRole(owner.headers, userId, { role: "member" }))?.status).toBe(200)

    // The sole owner can't unmake themselves — the rule that used to live only in
    // the UI that drew the menu. It matters MORE now: an owner is the one actor no
    // rule can restrict, so an org with none can be locked out by editing a role.
    const ownerSession = await auth.api.getSession({ headers: owner.headers })
    const ownerId = ownerSession?.user.id
    if (!ownerId) throw new Error("missing owner session")
    const lastOwner = await postRole(owner.headers, ownerId, { role: "member" })
    expect(lastOwner?.status).toBe(409)
    expect(((await lastOwner?.json()) as { error?: string }).error).toBe("LAST_OWNER")

    // With a second owner present it is allowed.
    expect((await postRole(owner.headers, userId, { role: "owner" }))?.status).toBe(200)
    expect((await postRole(owner.headers, ownerId, { role: "member" }))?.status).toBe(200)
  })

  it("OWNER-ONLY: an administrator cannot hand out the bypass", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const added = await postMember(owner.headers, { email: target.email })
    const { userId } = (await added?.json()) as { userId: string }
    await auth.api.setActiveOrganization({
      body: { organizationId: owner.orgId },
      headers: target.headers,
    })

    // Give the target full org configuration — everything an "admin" is now.
    const adminRole = await pool.query<{ id: string }>(
      "SELECT id FROM access_roles WHERE org_id = $1 AND key = 'admin' LIMIT 1",
      [owner.orgId],
    )
    await pool.query(
      `INSERT INTO access_role_actors (org_id, role_id, actor_id) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, actor_id) DO NOTHING`,
      [owner.orgId, adminRole.rows[0]!.id, userId],
    )
    await pool.query(
      `INSERT INTO access_policy_versions (org_id, version) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET version = access_policy_versions.version + 1`,
      [owner.orgId],
    )

    // Still 403. Owner is the one thing `configure` does not buy: an administrator
    // who could grant it could promote themselves past the rules that define them.
    expect((await postRole(target.headers, userId, { role: "owner" }))?.status).toBe(403)
    expect((await postRole(new Headers(), userId, { role: "owner" }))?.status).toBe(401)
    expect((await postRole(owner.headers, userId, { role: "superuser" }))?.status).toBe(400)
    expect((await postRole(owner.headers, randomUUID(), { role: "owner" }))?.status).toBe(404)
  })
})

describe("DELETE /api/org/members/:userId (purge a deactivated member)", () => {
  it("requires deactivation first; deactivation blocks org access; purge removes the membership", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const added = await postMember(owner.headers, { email: target.email, role: "member" })
    expect(added?.status).toBe(201)
    const { userId } = (await added?.json()) as { userId: string }
    await auth.api.setActiveOrganization({
      body: { organizationId: owner.orgId },
      headers: target.headers,
    })

    const del = (headers: Headers) =>
      handleApi(
        new Request(`http://localhost/api/org/members/${userId}`, { method: "DELETE", headers }),
      )

    // An ACTIVE member can't be purged (the archive→delete convention).
    expect((await del(owner.headers))?.status).toBe(409)

    await runEngineOrThrow(systemScope(owner.orgId, owner.email), deactivateMember(userId))

    // The deactivated member is blocked at the session boundary (any /api route).
    const blocked = await postMember(target.headers, { email: "x@test.dev", role: "member" })
    expect(blocked?.status).toBe(403)
    expect(((await blocked?.json()) as { error?: string }).error).toBe("DEACTIVATED")

    // Purge: membership + per-member engine data go; a second delete 404s.
    expect((await del(owner.headers))?.status).toBe(200)
    expect((await del(owner.headers))?.status).toBe(404)
    const markers = await runEngineOrThrow(
      systemScope(owner.orgId, owner.email),
      listDeactivatedMembers,
    )
    expect(
      (markers as ReadonlyArray<{ userId: string }>).find((m) => m.userId === userId),
    ).toBeUndefined()
  })
})

/**
 * The dispatch in index.ts, not the handlers. Every other test in the suite
 * calls a handler directly, so a path that never REACHES `handleApi` stays
 * invisible to them — which is exactly how `/api/auth-config/*` shipped dead
 * (BetterAuth's `startsWith("/api/auth")` ate it and 404'd).
 */
describe("path ownership: BetterAuth vs the app router", () => {
  it("claims only BetterAuth's own basePath, on a boundary", () => {
    expect(isBetterAuthPath("/api/auth")).toBe(true)
    expect(isBetterAuthPath("/api/auth/sign-in/email")).toBe(true)
    expect(isBetterAuthPath("/api/auth/sso/callback/org-1")).toBe(true)

    // Ours. A bare prefix match would hand all three to BetterAuth.
    expect(isBetterAuthPath("/api/auth-config/sso")).toBe(false)
    expect(isBetterAuthPath("/api/auth-config/methods")).toBe(false)
    expect(isBetterAuthPath("/api/authz")).toBe(false)
  })

  it("routes /api/auth-config/sso to the app router", async () => {
    const owner = await signUpAndOrg()
    const path = "/api/auth-config/sso"
    expect(isBetterAuthPath(path)).toBe(false)
    const res = await handleApi(new Request(`http://localhost${path}`, { headers: owner.headers }))
    expect(res?.status).toBe(200)
    expect((await res?.json()) as { canEdit?: boolean }).toMatchObject({ canEdit: true })
  })
})

describe("SSO provider management over HTTP", () => {
  it("is blocked, while sign-in and callbacks stay reachable", () => {
    for (const p of ["register", "update-provider", "delete-provider", "providers", "get-provider"])
      expect(isBlockedSsoPath(`/api/auth/sso/${p}`)).toBe(true)
    expect(isBlockedSsoPath("/api/auth/sign-in/sso")).toBe(false)
    expect(isBlockedSsoPath("/api/auth/sso/callback/org-1")).toBe(false)
  })
})
