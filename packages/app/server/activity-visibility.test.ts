import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConceptService, emptyPolicy, type PolicySet, unrestrictedPolicy } from "#engine"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { runEngineOrThrow, sessionScope, systemScope } from "./runtime"
import {
  createNote,
  createRecord,
  createTask,
  getActivity,
  listFiles,
  listNotes,
  listTasks,
} from "./use-cases"

const orgWithOwner = async () => {
  const email = `act-${randomUUID()}@test.dev`
  const created = await createUserDirect({ email, password: "password12345", name: "Owner" })
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: created.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  return { orgId: org.id, userId: created.userId }
}

/**
 * A policy granting full access to the named concepts and their records.
 *
 * Concept access used to come from the `visibility` column, so a test only had to
 * pick a role. It is now an explicit rule per (concept, role), written when the
 * concept is created — and a test that builds fixtures through the services directly
 * skips that, so it has to say what the caller may see.
 */
const seeing = (actor: string, conceptIds: ReadonlyArray<string>): PolicySet => ({
  ...emptyPolicy(actor),
  rules: conceptIds.flatMap((conceptId, i) =>
    (["concept", "record"] as const).map((resourceType, j) => ({
      id: `t${i}-${j}`,
      roleId: "test-role",
      effect: "allow" as const,
      actions: ["view", "create", "edit"] as const,
      resourceType,
      resourceId: resourceType === "concept" ? conceptId : null,
      conceptId: resourceType === "record" ? conceptId : null,
      condition: null,
    })),
  ),
})

describe("subject-keyed reads on a restricted concept", () => {
  /**
   * `annotations.subject_id` and `attachments.record_id` carry no concept column, so
   * these queries cannot filter on visibility themselves. Without an explicit gate a
   * member holding a restricted record's LINEAGE id could read its notes, tasks and
   * files — the same hole `getActivity` had.
   */
  it("a member cannot read notes / tasks / files of a restricted record", async () => {
    const { orgId, userId } = await orgWithOwner()
    const sys = systemScope(orgId, userId)

    const concept = await runEngineOrThrow(
      sys,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        return yield* concepts.create({ name: `Vault ${randomUUID().slice(0, 6)}` })
      }),
    )
    const rec = (await runEngineOrThrow(sys, createRecord(concept.id, {}))) as {
      recordId: string
    }
    await runEngineOrThrow(sys, createNote({ subjectId: rec.recordId, body: "the combination" }))
    await runEngineOrThrow(sys, createTask({ subjectId: rec.recordId, title: "rotate it" }))

    // "Restricted" is now the ABSENCE of a rule naming the concept, not a column on
    // it — so the member is given access first and it is taken away by dropping the
    // rule, which is the same before/after the old `setConceptVisibility` produced.
    const withAccess = sessionScope(orgId, userId, "member", seeing(userId, [concept.id]))
    const asMember = sessionScope(orgId, userId, "member", emptyPolicy(userId))
    // `role: "member"`, not `"owner"` — an unrestricted POLICY is the stand-in for
    // a privileged reader here (see the note in the previous test); since P3 the
    // owner flag no longer implies unrestricted, so `role: "owner"` would silently
    // discard this policy's `unrestricted: true` and this fixture would stop
    // meaning what its name says.
    const asPrivileged = sessionScope(orgId, userId, "member", unrestrictedPolicy(userId))

    // While readable, the member can read them — so the assertions below are about
    // the restriction, not about a fixture they never had access to.
    expect(
      ((await runEngineOrThrow(withAccess, listNotes(rec.recordId))) as unknown[]).length,
    ).toBe(1)

    // Typed loosely on purpose: the four effects have different success types, and
    // what is under test is that each REJECTS.
    const denied: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["listNotes", () => runEngineOrThrow(asMember, listNotes(rec.recordId))],
      ["listTasks", () => runEngineOrThrow(asMember, listTasks({ subjectId: rec.recordId }))],
      ["listFiles", () => runEngineOrThrow(asMember, listFiles({ recordId: rec.recordId }))],
      ["getActivity", () => runEngineOrThrow(asMember, getActivity(rec.recordId))],
    ]
    for (const [label, run] of denied) {
      await expect(run(), label).rejects.toThrow()
    }

    // A privileged reader still reads all of them.
    expect(
      ((await runEngineOrThrow(asPrivileged, listNotes(rec.recordId))) as unknown[]).length,
    ).toBe(1)
    expect(
      ((await runEngineOrThrow(asPrivileged, listTasks({ subjectId: rec.recordId }))) as unknown[])
        .length,
    ).toBe(1)
  })

  it("the global task list is unaffected (it names no lineage)", async () => {
    const { orgId, userId } = await orgWithOwner()
    const sys = systemScope(orgId, userId)
    await runEngineOrThrow(sys, createTask({ subjectId: null, title: "standalone" }))
    // No subjectId → nothing SUBJECT-based to gate; a member's own task list must
    // still work. `unrestrictedPolicy` stands in for "holds whatever grants `view`
    // on `task`" (P8 made that a real, separate check) — this test is about the
    // list not requiring a lineage, not about permission grants.
    const rows = (await runEngineOrThrow(
      sessionScope(orgId, userId, "member", unrestrictedPolicy(userId)),
      listTasks({}),
    )) as unknown[]
    expect(rows.length).toBeGreaterThan(0)
  })
})
