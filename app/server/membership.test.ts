import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { assertAssigneeMember, assertMembers } from "./rpc"
import { runEngineOrThrow } from "./runtime"
import { addField, createConcept, deactivateMember } from "./use-cases"

/**
 * The auth-tier membership guards at the RPC boundary. The engine treats a user
 * id as an opaque logical FK and never reads the auth tables, so "is this a real,
 * ACTIVE member?" is enforced here — and a deactivated member must fail it, since
 * they're blocked from the org at every entry point and could never act on the
 * work assigned to them.
 */

const signUp = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const created = await createUserDirect({ email, password: "password12345", name: "Tester" })
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

const addMember = async (orgId: string, userId: string) => {
  await auth.api.addMember({ body: { userId, role: "member", organizationId: orgId } })
}

/** A concept carrying one `user`-kind field; returns both ids. */
const conceptWithUserField = async (orgId: string, actor: string) => {
  const concept = (await runEngineOrThrow(
    { orgId, actor },
    createConcept(`Assignable ${randomUUID().slice(0, 6)}`),
  )) as { id: string }
  const field = (await runEngineOrThrow(
    { orgId, actor },
    addField({ conceptId: concept.id, name: "Owner", kind: "user" }),
  )) as { id: string }
  return { conceptId: concept.id, fieldId: field.id }
}

describe("assertAssigneeMember", () => {
  it("accepts an active member, rejects a non-member and a DEACTIVATED member", async () => {
    const { orgId, owner } = await orgWithOwner()
    const target = await signUp()
    const stranger = await signUp()
    await addMember(orgId, target.userId)

    // Active member: fine.
    await expect(assertAssigneeMember(orgId, target.userId)).resolves.toBeUndefined()
    // Never joined this org.
    await expect(assertAssigneeMember(orgId, stranger.userId)).rejects.toThrow(
      /not an active org member/,
    )
    // Unset assignee is a no-op.
    await expect(assertAssigneeMember(orgId, null)).resolves.toBeUndefined()

    // Deactivate them: still a `bauth_member` row, but no longer assignable.
    await runEngineOrThrow({ orgId, actor: owner.userId }, deactivateMember(target.userId))
    await expect(assertAssigneeMember(orgId, target.userId)).rejects.toThrow(
      /not an active org member/,
    )
  })
})

describe("assertMembers (user-kind field values)", () => {
  it("rejects a deactivated member in a user field, single and array valued", async () => {
    const { orgId, owner } = await orgWithOwner()
    const target = await signUp()
    await addMember(orgId, target.userId)
    const { conceptId, fieldId } = await conceptWithUserField(orgId, owner.userId)

    await expect(
      assertMembers(orgId, conceptId, { [fieldId]: target.userId }),
    ).resolves.toBeUndefined()

    await runEngineOrThrow({ orgId, actor: owner.userId }, deactivateMember(target.userId))

    await expect(assertMembers(orgId, conceptId, { [fieldId]: target.userId })).rejects.toThrow(
      /not org members/,
    )
    // Multi-value fields are checked element-wise, so the owner passing alongside
    // a deactivated id must not mask them.
    await expect(
      assertMembers(orgId, conceptId, { [fieldId]: [owner.userId, target.userId] }),
    ).rejects.toThrow(/not org members/)
    // No user-kind values in the patch → nothing to check.
    await expect(assertMembers(orgId, conceptId, {})).resolves.toBeUndefined()
  })
})
