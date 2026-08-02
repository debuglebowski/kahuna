import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { createUserDirect } from "./provision"

/**
 * Self-serve sign-up and self-serve org creation are both closed (see auth.ts).
 * These assert the closure AND the two provisioning paths that must keep working
 * — the whole test suite depends on the latter, so a regression here would show
 * up as a confusing failure everywhere else.
 */
describe("closed sign-up", () => {
  it("refuses sign-up, including through the server-side api", async () => {
    // The check lives inside the route handler, so `auth.api` is rejected too —
    // that is exactly why `provision.ts` writes the rows itself.
    await expect(
      auth.api.signUpEmail({
        body: { email: `x-${randomUUID()}@test.dev`, password: "password12345", name: "X" },
      }),
    ).rejects.toThrow()
  })

  it("an operator-provisioned account can still sign in", async () => {
    const email = `op-${randomUUID()}@test.dev`
    const password = "password12345"
    await createUserDirect({ email, password, name: "Operator" })
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
    expect(res.status).toBe(200)
  })

  it("a signed-in member cannot create an org, but the system path can", async () => {
    const email = `oc-${randomUUID()}@test.dev`
    const password = "password12345"
    const user = await createUserDirect({ email, password, name: "OrgCreator" })
    const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
    const headers = new Headers({
      cookie: (signIn.headers.get("set-cookie") ?? "")
        .split(/,(?=[^;]+?=)/)
        .map((c) => c.split(";")[0]?.trim() ?? "")
        .filter(Boolean)
        .join("; "),
    })

    // With a session → blocked by allowUserToCreateOrganization: false.
    await expect(
      auth.api.createOrganization({
        body: { name: "Nope", slug: `nope-${randomUUID().slice(0, 8)}` },
        headers,
      }),
    ).rejects.toThrow()

    // userId + no headers → better-auth's "system action" path, still allowed.
    const org = await auth.api.createOrganization({
      body: {
        name: "Allowed",
        slug: `allowed-${randomUUID().slice(0, 8)}`,
        userId: user.userId,
      },
    })
    expect(org?.id).toBeTruthy()
  })
})
