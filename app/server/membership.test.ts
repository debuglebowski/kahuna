import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { pool } from "./db"
import { syncMembershipRole } from "./membership"
import { createUserDirect } from "./provision"
import { assertAssigneeMember, assertMembers } from "./rpc"
import { runEngineOrThrow, systemScope } from "./runtime"
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
    systemScope(orgId, actor),
    createConcept(`Assignable ${randomUUID().slice(0, 6)}`),
  )) as { id: string }
  const field = (await runEngineOrThrow(
    systemScope(orgId, actor),
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
    await runEngineOrThrow(systemScope(orgId, owner.userId), deactivateMember(target.userId))
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

    await runEngineOrThrow(systemScope(orgId, owner.userId), deactivateMember(target.userId))

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

describe("membership role ↔ access role stay in step", () => {
  /**
   * THE BUG THIS PINS. Membership lives in BetterAuth, access in
   * `access_role_actors`. The backfill assigned presets to members that existed when
   * access control shipped, and nothing kept the two in step afterwards — so a member
   * who JOINED later held no access role.
   *
   * It hid for as long as everything fell through to the role-derived default (which
   * P1/P2 made identical to the presets) and surfaced the moment something read the
   * RULES: the irreducible-floor check counted zero `configure` holders and stopped
   * protecting the org. `verify-roles.ts` caught it; this keeps it caught.
   */
  it("a member who joins holds the matching preset, and a role change re-points it", async () => {
    const email = `sync-${randomUUID().slice(0, 8)}@example.test`
    const u = await createUserDirect({ email, password: "password12345", name: "Sync" })
    const orgId = randomUUID()

    const presetsFor = async (userId: string): Promise<ReadonlyArray<string>> => {
      const r = await pool.query<{ key: string | null }>(
        `SELECT ro.key FROM access_role_actors a
         JOIN access_roles ro ON ro.id = a.role_id
         WHERE a.org_id = $1 AND a.actor_id = $2`,
        [orgId, userId],
      )
      return r.rows.map((x) => x.key).filter((k): k is string => k !== null)
    }

    await syncMembershipRole(orgId, u.userId, "member")
    expect(await presetsFor(u.userId)).toEqual(["member"])

    // A promotion must MOVE the preset, not add a second one — holding both `member`
    // and `admin` would union their rules and quietly widen access.
    await syncMembershipRole(orgId, u.userId, "admin")
    expect(await presetsFor(u.userId)).toEqual(["admin"])

    // And a demotion must actually remove the admin rules.
    await syncMembershipRole(orgId, u.userId, "member")
    expect(await presetsFor(u.userId)).toEqual(["member"])

    // An unrecognised role fails CLOSED to the narrowest preset.
    await syncMembershipRole(orgId, u.userId, "wat")
    expect(await presetsFor(u.userId)).toEqual(["member"])
  })

  it("a CUSTOM role assignment survives a membership role change", async () => {
    // The sync mirrors only the three membership presets. Clobbering a custom role
    // would silently undo an admin's deliberate grant on every promotion.
    const email = `sync2-${randomUUID().slice(0, 8)}@example.test`
    const u = await createUserDirect({ email, password: "password12345", name: "Sync2" })
    const orgId = randomUUID()
    await syncMembershipRole(orgId, u.userId, "member")

    const custom = await pool.query<{ id: string }>(
      `INSERT INTO access_roles (org_id, key, name, managed, position)
       VALUES ($1, NULL, 'Sales', false, 9) RETURNING id`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO access_role_actors (org_id, role_id, actor_id) VALUES ($1, $2, $3)`,
      [orgId, custom.rows[0]!.id, u.userId],
    )

    await syncMembershipRole(orgId, u.userId, "admin")
    const held = await pool.query<{ name: string }>(
      `SELECT ro.name FROM access_role_actors a
       JOIN access_roles ro ON ro.id = a.role_id
       WHERE a.org_id = $1 AND a.actor_id = $2 ORDER BY ro.name`,
      [orgId, u.userId],
    )
    expect(held.rows.map((r) => r.name)).toEqual(["Admin", "Sales"])
  })
})
