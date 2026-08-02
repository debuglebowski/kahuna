import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { handleApi } from "./router"
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

  it("admin promotes/demotes; refuses to demote the LAST owner", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const added = await postMember(owner.headers, { email: target.email, role: "member" })
    const { userId } = (await added?.json()) as { userId: string }

    // Promote to admin, then back down.
    expect((await postRole(owner.headers, userId, { role: "admin" }))?.status).toBe(200)
    expect((await postRole(owner.headers, userId, { role: "member" }))?.status).toBe(200)

    // The sole owner can't demote themselves — the rule that used to live only in
    // the UI that drew the menu.
    const ownerSession = await auth.api.getSession({ headers: owner.headers })
    const ownerId = ownerSession?.user.id
    if (!ownerId) throw new Error("missing owner session")
    const lastOwner = await postRole(owner.headers, ownerId, { role: "admin" })
    expect(lastOwner?.status).toBe(409)
    expect(((await lastOwner?.json()) as { error?: string }).error).toBe("LAST_OWNER")

    // With a second owner present the demotion is allowed.
    expect((await postRole(owner.headers, userId, { role: "owner" }))?.status).toBe(200)
    expect((await postRole(owner.headers, ownerId, { role: "admin" }))?.status).toBe(200)
  })

  it("rejects non-admins, unknown members and bogus roles", async () => {
    const owner = await signUpAndOrg()
    const target = await signUp()
    const added = await postMember(owner.headers, { email: target.email, role: "member" })
    const { userId } = (await added?.json()) as { userId: string }
    await auth.api.setActiveOrganization({
      body: { organizationId: owner.orgId },
      headers: target.headers,
    })

    // A plain member may not change roles — least of all their own.
    expect((await postRole(target.headers, userId, { role: "owner" }))?.status).toBe(403)
    expect((await postRole(new Headers(), userId, { role: "admin" }))?.status).toBe(401)
    expect((await postRole(owner.headers, userId, { role: "superuser" }))?.status).toBe(400)
    expect((await postRole(owner.headers, randomUUID(), { role: "admin" }))?.status).toBe(404)
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
