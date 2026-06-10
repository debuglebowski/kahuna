import { randomUUID } from "node:crypto"
import { ConceptService, FieldService, InstanceService } from "@kingsmaker/engine"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { runEngineOrThrow } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import { runScoped } from "./session"

/** Convert a Set-Cookie response header into a request Cookie header. */
const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

/** Sign up a fresh user, create an org (owner), make it active. */
const signUpAndOrg = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  await auth.api.signUpEmail({ body: { email, password, name: "Tester" } })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  const org = await auth.api.createOrganization({
    body: { name: `Org ${randomUUID().slice(0, 8)}`, slug: `org-${randomUUID().slice(0, 8)}` },
    headers,
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers })
  return { headers, orgId: org.id }
}

const listConcepts = Effect.flatMap(ConceptService, (c) => c.list())

describe("tier 0 (BetterAuth) + scoping", () => {
  it("rejects an unauthenticated request (401)", async () => {
    const result = await runScoped(new Request("http://localhost/api/concepts"), listConcepts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("an authenticated member runs engine ops scoped to their org", async () => {
    const { headers, orgId } = await signUpAndOrg()
    await runEngineOrThrow({ orgId, actor: "system" }, seedKingsmaker)
    const req = new Request("http://localhost/api/concepts", { headers })
    const result = await runScoped(req, listConcepts)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.length).toBe(8)
  })

  it("org A cannot see org B's instances (404 via session scope)", async () => {
    const a = await signUpAndOrg()
    const b = await signUpAndOrg()
    await runEngineOrThrow({ orgId: a.orgId, actor: "system" }, seedKingsmaker)
    const created = await runEngineOrThrow(
      { orgId: a.orgId, actor: "system" },
      Effect.flatMap(InstanceService, (i) => i.create({ conceptName: "Company", fields: {} })),
    )
    const reqB = new Request("http://localhost/x", { headers: b.headers })
    const res = await runScoped(
      reqB,
      Effect.flatMap(InstanceService, (i) => i.get(created.id)),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it("deleting an org purges its engine data (beforeDeleteOrganization hook)", async () => {
    const { headers, orgId } = await signUpAndOrg()
    await runEngineOrThrow({ orgId, actor: "system" }, seedKingsmaker)
    await runEngineOrThrow(
      { orgId, actor: "system" },
      Effect.flatMap(InstanceService, (i) => i.create({ conceptName: "Company", fields: {} })),
    )
    const before = await runEngineOrThrow({ orgId, actor: "system" }, listConcepts)
    expect(before.length).toBe(8)

    await auth.api.deleteOrganization({ body: { organizationId: orgId }, headers })

    const after = await runEngineOrThrow({ orgId, actor: "system" }, listConcepts)
    expect(after.length).toBe(0)
  })

  it("an illegal Agreement status transition surfaces as 422 ILLEGAL_TRANSITION", async () => {
    const a = await signUpAndOrg()
    await runEngineOrThrow({ orgId: a.orgId, actor: "system" }, seedKingsmaker)
    // Resolve the seeded Agreement.status field id, then create a draft agreement.
    const { instanceId, statusId } = await runEngineOrThrow(
      { orgId: a.orgId, actor: "system" },
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fieldSvc = yield* FieldService
        const instances = yield* InstanceService
        const agreement = yield* concepts.getByName("Agreement")
        const fs = yield* fieldSvc.listFields(agreement.id)
        const statusId = fs.find((f) => f.name === "status")!.id
        const inst = yield* instances.create({
          conceptId: agreement.id,
          fields: { [statusId]: "draft" },
        })
        return { instanceId: inst.id, statusId }
      }),
    )
    const req = new Request("http://localhost/x", { headers: a.headers })
    // draft only allows -> active; jumping to "expired" is illegal.
    const res = await runScoped(
      req,
      Effect.flatMap(InstanceService, (i) =>
        i.transition({ instanceId, expectedVersion: 0, field: statusId, to: "expired" }),
      ),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(422)
      expect(res.code).toBe("ILLEGAL_TRANSITION")
    }
  })
})
