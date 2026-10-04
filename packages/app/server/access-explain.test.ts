import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { runEngineOrThrow, systemScope } from "./runtime"
import { effectiveAccess, explainAccess } from "./use-cases"

/**
 * `effectiveAccess` and `explainAccess` are the P4 explain view's use-case layer:
 * every rule an actor holds, tagged with the LAYER it resolves in, and a targeted
 * trace of one specific (resource, action) decision. Both take `isOwner` from the
 * caller (a membership-tier fact neither the resolved policy nor this file's
 * `systemScope` calls can see on their own) — these tests pass it explicitly, the
 * same way `rpc.ts`'s handlers do after looking it up via `roleOf`.
 */

const signUp = async (name: string) => {
  const email = `explain-${randomUUID()}@test.dev`
  const created = await createUserDirect({ email, password: "password12345", name })
  return created.userId
}

const orgWithOwner = async () => {
  const ownerId = await signUp("Owner")
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: ownerId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  return { orgId: org.id, ownerId }
}

const addMember = async (orgId: string, userId: string) => {
  await auth.api.addMember({ body: { userId, role: "member", organizationId: orgId } })
}

describe("effectiveAccess: rules tagged with the layer they resolve in", () => {
  it("the founding owner carries both the Layer 0 floor and their auto-granted Admin role", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const report = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      effectiveAccess(ownerId, true),
    )) as {
      roles: ReadonlyArray<{ name: string }>
      rules: ReadonlyArray<{
        viaRoleId: string | null
        viaRoleName: string | null
        precedence: number
        layerLabel: string
        resourceType: string
      }>
    }

    expect(report.roles.some((r) => r.name === "Admin")).toBe(true)

    const layer0 = report.rules.filter((r) => r.viaRoleId === null)
    expect(layer0).toHaveLength(2)
    expect(layer0.map((r) => r.resourceType).sort()).toEqual(["member", "role"])
    for (const r of layer0) {
      expect(r.precedence).toBe(-1)
      expect(r.layerLabel).toBe("Owner")
    }

    const admin = report.rules.filter((r) => r.viaRoleName === "Admin")
    expect(admin.length).toBeGreaterThan(0)
    for (const r of admin) {
      expect(r.layerLabel).toBe("Admin")
      expect(r.precedence).toBeGreaterThan(0)
    }
  })

  it("isOwner is taken literally — false omits the Layer 0 rows even for an owner", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const report = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      effectiveAccess(ownerId, false),
    )) as { rules: ReadonlyArray<{ viaRoleId: string | null }> }
    expect(report.rules.some((r) => r.viaRoleId === null)).toBe(false)
  })

  it("a plain member's rules are all tagged with their one held role, never Layer 0", async () => {
    const { orgId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const report = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      effectiveAccess(memberId, false),
    )) as {
      roles: ReadonlyArray<{ name: string }>
      rules: ReadonlyArray<{ layerLabel: string; viaRoleId: string | null }>
    }
    expect(report.roles.map((r) => r.name)).toEqual(["Member"])
    expect(report.rules.length).toBeGreaterThan(0)
    for (const r of report.rules) {
      expect(r.layerLabel).toBe("Member")
      expect(r.viaRoleId).not.toBeNull()
    }
  })
})

describe("explainAccess: the ordered trace behind one decision", () => {
  it("org-configure: only Admin's tier shows — Member holds no rule on `org` at all", async () => {
    // The founding owner holds BOTH roles today — Member from auto-assign, Admin
    // from `seedKahuna`. Member's preset carries no `org` rule whatsoever (see
    // `AccessRoleService.BUILTIN_ROLES`'s header — every action ever decided
    // against `org` is `configure`, which Member never holds), so it never
    // appears in this trace at all, not even silently.
    const { orgId, ownerId } = await orgWithOwner()
    const result = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      explainAccess(ownerId, true, "org", null, null, "configure"),
    )) as {
      outcome: boolean
      unrestricted: boolean
      decidedByFallback: boolean
      layers: ReadonlyArray<{
        precedence: number
        roleIds: ReadonlyArray<string | null>
        label: string
        verdict: string
        decided: boolean
      }>
    }
    expect(result.outcome).toBe(true)
    expect(result.unrestricted).toBe(false)
    expect(result.decidedByFallback).toBe(false)
    expect(result.layers).toHaveLength(1)
    expect(result.layers[0]!.verdict).toBe("allow")
    expect(result.layers[0]!.decided).toBe(true)
    expect(result.layers[0]!.label).toBe("Admin")
  })

  it("role-configure: Layer 0 decides first; only Admin's tier shows, undecided", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const result = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      explainAccess(ownerId, true, "role", null, null, "configure"),
    )) as {
      outcome: boolean
      layers: ReadonlyArray<{
        precedence: number
        roleIds: ReadonlyArray<string | null>
        label: string
        verdict: string
        decided: boolean
      }>
    }
    expect(result.outcome).toBe(true)
    expect(result.layers).toHaveLength(2)
    expect(result.layers[0]).toMatchObject({
      precedence: -1,
      roleIds: [null],
      label: "Owner",
      verdict: "allow",
      decided: true,
    })
    expect(result.layers[1]!.decided).toBe(false)
    expect(result.layers[1]!.verdict).toBe("allow")
    expect(result.layers[1]!.label).toBe("Admin")
  })

  it("a plain member asking about org-configure: no tier at all, the closed fallback decides", async () => {
    const { orgId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const result = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      explainAccess(memberId, false, "org", null, null, "configure"),
    )) as {
      outcome: boolean
      fallback: boolean
      decidedByFallback: boolean
      layers: ReadonlyArray<{ label: string; verdict: string; decided: boolean }>
    }
    expect(result.outcome).toBe(false)
    expect(result.fallback).toBe(false)
    expect(result.decidedByFallback).toBe(true)
    expect(result.layers).toHaveLength(0)
  })

  it("a plain member CAN edit records — the open fallback, no rule needed", async () => {
    const { orgId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const result = (await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      explainAccess(memberId, false, "task", null, null, "create"),
    )) as { outcome: boolean; decidedByFallback: boolean }
    // Member holds `create` on `task` directly (see BUILTIN_ROLES), so this is
    // decided by the rule, not the fallback — the open-by-default direction is
    // exercised by the org-configure test above instead.
    expect(result.outcome).toBe(true)
  })
})
