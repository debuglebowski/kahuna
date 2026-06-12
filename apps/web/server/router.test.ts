import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { handleApi } from "./router"
import { runEngineOrThrow } from "./runtime"
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
  await auth.api.signUpEmail({ body: { email, password, name: "Tester" } })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  return { email, headers }
}

const signUpAndOrg = async () => {
  const u = await signUp()
  const org = await auth.api.createOrganization({
    body: { name: `Org ${randomUUID().slice(0, 8)}`, slug: `org-${randomUUID().slice(0, 8)}` },
    headers: u.headers,
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

    await runEngineOrThrow({ orgId: owner.orgId, actor: owner.email }, deactivateMember(userId))

    // The deactivated member is blocked at the session boundary (any /api route).
    const blocked = await postMember(target.headers, { email: "x@test.dev", role: "member" })
    expect(blocked?.status).toBe(403)
    expect(((await blocked?.json()) as { error?: string }).error).toBe("DEACTIVATED")

    // Purge: membership + per-member engine data go; a second delete 404s.
    expect((await del(owner.headers))?.status).toBe(200)
    expect((await del(owner.headers))?.status).toBe(404)
    const markers = await runEngineOrThrow(
      { orgId: owner.orgId, actor: owner.email },
      listDeactivatedMembers,
    )
    expect(
      (markers as ReadonlyArray<{ userId: string }>).find((m) => m.userId === userId),
    ).toBeUndefined()
  })
})
