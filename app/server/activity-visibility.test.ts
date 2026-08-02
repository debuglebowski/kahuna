import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConceptService, FieldService } from "#engine"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { runEngineOrThrow, sessionScope, systemScope } from "./runtime"
import {
  createInstance,
  createNote,
  createTask,
  getActivity,
  listFiles,
  listNotes,
  listTasks,
  setConceptVisibility,
  setFieldVisibility,
  updateInstance,
} from "./use-cases"

/**
 * `getActivity` is a SEPARATE leak channel from `instances.state`: it ships raw
 * event payloads plus a server-reconstructed `previous` map of overwritten values.
 * Field masking has to reach both — and ONLY at the final map, because the fold
 * that builds `previous` must see complete payloads or a later event would report a
 * value an earlier masked patch had already replaced.
 *
 * The log itself is never redacted; this is read-time filtering.
 */
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

type FeedEntry = {
  readonly eventType: string
  readonly payload?: Record<string, unknown>
  readonly previous?: Record<string, unknown>
}

describe("activity feed field masking", () => {
  it("masks hidden keys in payload AND previous, without corrupting the fold", async () => {
    const { orgId, userId } = await orgWithOwner()
    const sys = systemScope(orgId, userId)

    const schema = await runEngineOrThrow(
      sys,
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const c = yield* concepts.create({ name: `Staff ${randomUUID().slice(0, 6)}` })
        const open = yield* fields.addField({ conceptId: c.id, name: "Name", kind: "text" })
        const secret = yield* fields.addField({ conceptId: c.id, name: "Pay", kind: "text" })
        return { conceptId: c.id, openId: open.id, secretId: secret.id }
      }),
    )

    // Edited TWICE, so `previous` is reconstructed over a real history — that fold
    // is exactly what a mis-placed mask would corrupt.
    const rec = (await runEngineOrThrow(
      sys,
      createInstance(schema.conceptId, { [schema.openId]: "Ada", [schema.secretId]: "100" }),
    )) as { id: string; itemId: string; version: number }
    const v2 = (await runEngineOrThrow(
      sys,
      updateInstance(rec.id, rec.version, { [schema.openId]: "Grace", [schema.secretId]: "200" }),
    )) as { version: number }
    await runEngineOrThrow(sys, updateInstance(rec.id, v2.version, { [schema.secretId]: "300" }))
    await runEngineOrThrow(sys, setFieldVisibility(schema.secretId, "admin"))

    const feedFor = async (role: "member" | "owner") =>
      (await runEngineOrThrow(
        sessionScope(orgId, userId, role),
        getActivity(rec.itemId),
      )) as ReadonlyArray<FeedEntry>

    // ── as a MEMBER ──────────────────────────────────────────────────────────
    const asMember = await feedFor("member")
    const created = asMember.find((e) => e.eventType === "InstanceCreated")
    expect(created?.payload?.fields).toEqual({ [schema.openId]: "Ada" })

    for (const ev of asMember.filter((e) => e.eventType === "InstanceUpdated")) {
      expect(Object.keys((ev.payload?.patch ?? {}) as object)).not.toContain(schema.secretId)
      expect(Object.keys(ev.previous ?? {})).not.toContain(schema.secretId)
    }

    // The visible field's `previous` must still be CORRECT across a history that
    // also patched the hidden one. This is what proves the fold stayed intact: a
    // mask applied inside it would have left this undefined or wrong.
    const openEdit = asMember.find(
      (e) =>
        e.eventType === "InstanceUpdated" && schema.openId in ((e.payload?.patch ?? {}) as object),
    )
    expect(openEdit?.previous?.[schema.openId]).toBe("Ada")

    // ── as the OWNER, nothing is withheld ────────────────────────────────────
    const asOwner = await feedFor("owner")
    const ownerCreated = asOwner.find((e) => e.eventType === "InstanceCreated")
    expect(ownerCreated?.payload?.fields).toEqual({
      [schema.openId]: "Ada",
      [schema.secretId]: "100",
    })
    const sawFinalHidden = asOwner
      .filter((e) => e.eventType === "InstanceUpdated")
      .some((e) => ((e.payload?.patch ?? {}) as Record<string, unknown>)[schema.secretId] === "300")
    expect(sawFinalHidden).toBe(true)
    // …and the owner's `previous` for the hidden field spans the real history. The
    // feed is newest-first, so across the two edits the overwritten values are
    // "200" then "100" — assert the set rather than an order-dependent single hit.
    const ownerHiddenPrevs = asOwner
      .filter((e) => e.eventType === "InstanceUpdated")
      .map((e) => e.previous?.[schema.secretId])
      .filter((v) => v !== undefined)
    expect(ownerHiddenPrevs).toEqual(expect.arrayContaining(["100", "200"]))
  })
})

describe("subject-keyed reads on a restricted concept", () => {
  /**
   * `annotations.subject_id` and `attachments.item_id` carry no concept column, so
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
    const rec = (await runEngineOrThrow(sys, createInstance(concept.id, {}))) as {
      itemId: string
    }
    await runEngineOrThrow(sys, createNote({ subjectId: rec.itemId, body: "the combination" }))
    await runEngineOrThrow(sys, createTask({ subjectId: rec.itemId, title: "rotate it" }))

    const asMember = sessionScope(orgId, userId, "member")
    const asOwner = sessionScope(orgId, userId, "owner")

    // While VISIBLE, the member can read them — so the assertions below are about
    // the restriction, not about a fixture they never had access to.
    expect(((await runEngineOrThrow(asMember, listNotes(rec.itemId))) as unknown[]).length).toBe(1)

    await runEngineOrThrow(sys, setConceptVisibility(concept.id, "admin"))

    // Typed loosely on purpose: the four effects have different success types, and
    // what is under test is that each REJECTS.
    const denied: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["listNotes", () => runEngineOrThrow(asMember, listNotes(rec.itemId))],
      ["listTasks", () => runEngineOrThrow(asMember, listTasks({ subjectId: rec.itemId }))],
      ["listFiles", () => runEngineOrThrow(asMember, listFiles({ itemId: rec.itemId }))],
      ["getActivity", () => runEngineOrThrow(asMember, getActivity(rec.itemId))],
    ]
    for (const [label, run] of denied) {
      await expect(run(), label).rejects.toThrow()
    }

    // The owner still reads all of them.
    expect(((await runEngineOrThrow(asOwner, listNotes(rec.itemId))) as unknown[]).length).toBe(1)
    expect(
      ((await runEngineOrThrow(asOwner, listTasks({ subjectId: rec.itemId }))) as unknown[]).length,
    ).toBe(1)
  })

  it("the global task list is unaffected (it names no lineage)", async () => {
    const { orgId, userId } = await orgWithOwner()
    const sys = systemScope(orgId, userId)
    await runEngineOrThrow(sys, createTask({ subjectId: null, title: "standalone" }))
    // No subjectId → nothing to gate; a member's own task list must still work.
    const rows = (await runEngineOrThrow(
      sessionScope(orgId, userId, "member"),
      listTasks({}),
    )) as unknown[]
    expect(rows.length).toBeGreaterThan(0)
  })
})
