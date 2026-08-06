import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConceptService, RecordService } from "#engine"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { resolvePolicy, runEngineOrThrow, sessionScope, systemScope } from "./runtime"
import {
  archiveRecord,
  createConcept,
  createRecord,
  downloadAttachment,
  restoreRecord,
  uploadAttachment,
} from "./use-cases"

/**
 * Four places that took no access check at all, found reviewing the managed-role
 * defaults for reasonableness (a grant is only real if something decides it — these
 * decided NOTHING, for anyone): `createConcept`, `RecordService.create`, the
 * whole-lineage `archiveRecord`/`restoreRecord`, and `downloadAttachment`. Each test
 * proves the new gate refuses an actor with no rule for it, and that a real member
 * (or, for the managed-concept guard, an integration writing directly) still works.
 */

const signUp = async (name: string) => {
  const email = `access-gaps-${randomUUID()}@test.dev`
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

describe("createConcept now gates on create", () => {
  it("an actor holding no role at all is refused", async () => {
    const { orgId } = await orgWithOwner()
    const bareId = `bare-${randomUUID()}`
    const scope = sessionScope(orgId, bareId, "member", await resolvePolicy(orgId, bareId))
    await expect(runEngineOrThrow(scope, createConcept("Nope", null))).rejects.toThrow()
  })

  it("the stock Member role can still create a concept", async () => {
    const { orgId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const scope = sessionScope(orgId, memberId, "member", await resolvePolicy(orgId, memberId))
    const concept = (await runEngineOrThrow(scope, createConcept("Deals", null))) as { id: string }
    expect(concept.id).toBeTruthy()
  })
})

describe("createRecord now gates on being able to read the concept", () => {
  it("an actor holding no role at all is refused", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const concept = await runEngineOrThrow(
      systemScope(orgId, ownerId),
      Effect.flatMap(ConceptService, (c) => c.create({ name: `Deal ${randomUUID().slice(0, 6)}` })),
    )
    const bareId = `bare-${randomUUID()}`
    const scope = sessionScope(orgId, bareId, "member", await resolvePolicy(orgId, bareId))
    await expect(runEngineOrThrow(scope, createRecord(concept.id, {}))).rejects.toThrow()
  })

  it("the stock Member role can still create a record", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const concept = await runEngineOrThrow(
      systemScope(orgId, ownerId),
      Effect.flatMap(ConceptService, (c) => c.create({ name: `Deal ${randomUUID().slice(0, 6)}` })),
    )
    const scope = sessionScope(orgId, memberId, "member", await resolvePolicy(orgId, memberId))
    const record = await runEngineOrThrow(scope, createRecord(concept.id, {}))
    expect(record).toBeTruthy()
  })
})

describe("whole-lineage archiveRecord/restoreRecord now gate like their per-version siblings", () => {
  it("refused for a concept the actor cannot read", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const { concept, record } = await runEngineOrThrow(
      systemScope(orgId, ownerId),
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const c = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 6)}` })
        const rec = yield* Effect.flatMap(RecordService, (r) =>
          r.create({ conceptId: c.id, fields: {} }),
        )
        return { concept: c, record: rec }
      }),
    )
    const bareId = `bare-${randomUUID()}`
    const scope = sessionScope(orgId, bareId, "member", await resolvePolicy(orgId, bareId))
    await expect(runEngineOrThrow(scope, archiveRecord(record.recordId))).rejects.toThrow()
    await expect(runEngineOrThrow(scope, restoreRecord(record.recordId))).rejects.toThrow()
    expect(concept.id).toBeTruthy()
  })

  it("refused on a managed concept, same as the per-version guard", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const { record } = await runEngineOrThrow(
      systemScope(orgId, ownerId),
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const c = yield* concepts.create({
          name: `Synced ${randomUUID().slice(0, 6)}`,
          managedBy: "google.gmail",
        })
        const rec = yield* Effect.flatMap(RecordService, (r) =>
          r.create({ conceptId: c.id, fields: {} }),
        )
        return { record: rec }
      }),
    )
    const scope = sessionScope(orgId, memberId, "member", await resolvePolicy(orgId, memberId))
    await expect(runEngineOrThrow(scope, archiveRecord(record.recordId))).rejects.toThrow()
  })
})

describe("downloadAttachment now gates on the host record being readable", () => {
  it("refused for an attachment on a record the actor cannot read", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const attachment = await runEngineOrThrow(
      systemScope(orgId, ownerId),
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const c = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 6)}` })
        const rec = yield* Effect.flatMap(RecordService, (r) =>
          r.create({ conceptId: c.id, fields: {} }),
        )
        return yield* uploadAttachment(
          { recordId: rec.recordId },
          "secret.txt",
          "text/plain",
          new Uint8Array([1, 2, 3]),
        )
      }),
    )
    const bareId = `bare-${randomUUID()}`
    const scope = sessionScope(orgId, bareId, "member", await resolvePolicy(orgId, bareId))
    await expect(runEngineOrThrow(scope, downloadAttachment(attachment.id))).rejects.toThrow()
  })

  it("the stock Member role can still download an attachment on a record it can read", async () => {
    const { orgId, ownerId } = await orgWithOwner()
    const memberId = await signUp("Member")
    await addMember(orgId, memberId)
    const attachment = await runEngineOrThrow(
      systemScope(orgId, ownerId),
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const c = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 6)}` })
        const rec = yield* Effect.flatMap(RecordService, (r) =>
          r.create({ conceptId: c.id, fields: {} }),
        )
        return yield* uploadAttachment(
          { recordId: rec.recordId },
          "note.txt",
          "text/plain",
          new Uint8Array([1, 2, 3]),
        )
      }),
    )
    const scope = sessionScope(orgId, memberId, "member", await resolvePolicy(orgId, memberId))
    const downloaded = (await runEngineOrThrow(scope, downloadAttachment(attachment.id))) as {
      attachment: { filename: string }
    }
    expect(downloaded.attachment.filename).toBe("note.txt")
  })
})
