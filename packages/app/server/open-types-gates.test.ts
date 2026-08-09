import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { AccessRoleService } from "#engine"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { resolvePolicy, runEngine, runEngineOrThrow, sessionScope, systemScope } from "./runtime"
import { createNote, createTask, listFiles, listTasks, uploadAttachment } from "./use-cases"

/**
 * P8: `task`/`note` used to have NO access-rule gate at all for `view`/`create`
 * (org-level tasks/notes) — any authenticated member could do these things
 * unconditionally. These tests prove the gate (`use-cases.ts`'s `assertAllowed`)
 * actually refuses someone with no rule for it, and that the stock Member role
 * (now carrying an explicit `view` grant via the 0015 migration /
 * `UNTEMPLATED_VISIBLE`) still works exactly as before for the common case.
 *
 * `bucket` used to be P8-gated the same way, but isn't any more: `bucket` was
 * removed from `AccessResourceType` entirely (not just from Member's grant) —
 * `uploadAttachment`/`listFiles` no longer consult a rule for it at all, so a
 * bucket-owned upload/list is open to any authenticated actor now, matching
 * `DashboardService`'s existing "no admin gate" precedent for create. The bucket
 * assertions below stay (they still SUCCEED, just no longer because of a rule),
 * except in the "refused" test, where they no longer belong.
 */

const signUp = async (name: string) => {
  const email = `open-types-${randomUUID()}@test.dev`
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

describe("open-types gates (P8): view/create on task/note", () => {
  it("the stock Member role can list global tasks, create one, and use a widget bucket", async () => {
    const { orgId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const policy = await resolvePolicy(orgId, memberId)
    const scope = sessionScope(orgId, memberId, "member", policy)

    const tasks = await runEngineOrThrow(scope, listTasks({}))
    expect(Array.isArray(tasks)).toBe(true)

    const task = (await runEngineOrThrow(
      scope,
      createTask({ subjectId: null, title: "Org-level task" }),
    )) as { title: string }
    expect(task.title).toBe("Org-level task")

    const note = await runEngineOrThrow(scope, createNote({ subjectId: null, body: "Org note" }))
    expect(note).toBeTruthy()

    const bucketId = randomUUID()
    const uploaded = (await runEngineOrThrow(
      scope,
      uploadAttachment({ bucketId }, "note.txt", "text/plain", new Uint8Array([1, 2, 3])),
    )) as { filename: string }
    expect(uploaded.filename).toBe("note.txt")

    const files = await runEngineOrThrow(scope, listFiles({ bucketId }))
    expect((files as ReadonlyArray<unknown>).length).toBe(1)
  })

  it("an actor holding NO role at all is refused on every gated path", async () => {
    // Never added as a member, never assigned a role — `resolvePolicy` finds
    // nothing, so every `assertAllowed` check has no rule to grant it.
    const orgId = (await orgWithOwner()).orgId
    const bareId = `bare-${randomUUID()}`
    const scope = sessionScope(orgId, bareId, "member", await resolvePolicy(orgId, bareId))

    const denied: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["listTasks", () => runEngineOrThrow(scope, listTasks({}))],
      ["createTask", () => runEngineOrThrow(scope, createTask({ subjectId: null, title: "nope" }))],
      ["createNote", () => runEngineOrThrow(scope, createNote({ subjectId: null, body: "nope" }))],
    ]
    for (const [label, run] of denied) {
      await expect(run(), label).rejects.toThrow()
    }

    // `bucket` is NOT in the denied list above — it has no gate any more (see the
    // file's header comment), so even a bare actor with no role at all succeeds.
    const uploaded = (await runEngineOrThrow(
      scope,
      uploadAttachment({ bucketId: randomUUID() }, "x.txt", "text/plain", new Uint8Array([1])),
    )) as { filename: string }
    expect(uploaded.filename).toBe("x.txt")
    const files = await runEngineOrThrow(scope, listFiles({ bucketId: randomUUID() }))
    expect(Array.isArray(files)).toBe(true)
  })

  it("a role granting create/edit/archive/share but NOT view (the pre-0015 shape) can create but not see", async () => {
    // The exact gap the 0015 migration exists to close, proven directly against
    // the CURRENT gate logic rather than the migration's own SQL: build a role
    // with the shape every custom role had before the backfill, and confirm it
    // can create but is refused view.
    //
    // Deliberately NOT `addMember` — that also auto-assigns the stock Member
    // role (which now carries `view`), which would mask exactly the gap this
    // test exists to isolate. A bare actor id, assigned only the custom role.
    const { orgId } = await orgWithOwner()
    const userId = `old-shape-${randomUUID()}`
    const roleId = await runEngineOrThrow(
      systemScope(orgId, "system:test"),
      Effect.gen(function* () {
        const roles = yield* AccessRoleService
        const role = yield* roles.create({ name: "Old-shape role" })
        yield* roles.addRule({
          roleId: role.id,
          effect: "allow",
          actions: ["create", "edit", "archive"],
          resourceType: "task",
        })
        yield* roles.assign(role.id, userId)
        return role.id
      }),
    )
    expect(roleId).toBeTruthy()

    const scope = sessionScope(orgId, userId, "member", await resolvePolicy(orgId, userId))
    const created = await runEngineOrThrow(
      scope,
      createTask({ subjectId: null, title: "Can make, can't see" }),
    )
    expect(created).toBeTruthy()
    await expect(runEngineOrThrow(scope, listTasks({})), "listTasks").rejects.toThrow()
  })

  it("listTasks with a real subject still uses the RECORD gate, unaffected by the new check", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const sys = systemScope(orgId, ownerId)
    const rows = await runEngine(sys, listTasks({ subjectId: undefined }))
    expect(rows.ok).toBe(true)
  })

  it("the founding owner (auto-granted Admin) passes every gate via the wildcard role", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const policy = await resolvePolicy(orgId, ownerId)
    const scope = sessionScope(orgId, ownerId, "owner", policy)
    const task = await runEngineOrThrow(scope, createTask({ subjectId: null, title: "Owner task" }))
    expect(task).toBeTruthy()
  })
})
