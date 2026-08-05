import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  ACTION_ALL,
  ConceptService,
  emptyPolicy,
  FieldService,
  type PolicySet,
  unrestrictedPolicy,
} from "#engine"
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
  setFieldVisibility,
  updateRecord,
} from "./use-cases"

/**
 * `getActivity` is a SEPARATE leak channel from `record versions.state`: it ships raw
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
      actorId: null,
      effect: "allow" as const,
      actions: [ACTION_ALL],
      resourceType,
      resourceId: resourceType === "concept" ? conceptId : null,
      conceptId: resourceType === "record" ? conceptId : null,
      condition: null,
    })),
  ),
})

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
      createRecord(schema.conceptId, { [schema.openId]: "Ada", [schema.secretId]: "100" }),
    )) as { id: string; recordId: string; version: number }
    const v2 = (await runEngineOrThrow(
      sys,
      updateRecord(rec.id, rec.version, { [schema.openId]: "Grace", [schema.secretId]: "200" }),
    )) as { version: number }
    await runEngineOrThrow(sys, updateRecord(rec.id, v2.version, { [schema.secretId]: "300" }))
    await runEngineOrThrow(sys, setFieldVisibility(schema.secretId, "admin"))

    // The record's CONCEPT must be readable for the feed to resolve at all — that is
    // now a rule, not a column. Field masking (what this test is about) is a separate
    // mechanism layered on top, still driven by `fields.visibility`.
    const feedFor = async (role: "member" | "owner") =>
      (await runEngineOrThrow(
        sessionScope(orgId, userId, role, seeing(userId, [schema.conceptId])),
        getActivity(rec.recordId),
      )) as ReadonlyArray<FeedEntry>

    // ── as a MEMBER ──────────────────────────────────────────────────────────
    const asMember = await feedFor("member")
    const created = asMember.find((e) => e.eventType === "RecordVersionCreated")
    expect(created?.payload?.fields).toEqual({ [schema.openId]: "Ada" })

    for (const ev of asMember.filter((e) => e.eventType === "RecordVersionUpdated")) {
      expect(Object.keys((ev.payload?.patch ?? {}) as object)).not.toContain(schema.secretId)
      expect(Object.keys(ev.previous ?? {})).not.toContain(schema.secretId)
    }

    // The visible field's `previous` must still be CORRECT across a history that
    // also patched the hidden one. This is what proves the fold stayed intact: a
    // mask applied inside it would have left this undefined or wrong.
    const openEdit = asMember.find(
      (e) =>
        e.eventType === "RecordVersionUpdated" &&
        schema.openId in ((e.payload?.patch ?? {}) as object),
    )
    expect(openEdit?.previous?.[schema.openId]).toBe("Ada")

    // ── as the OWNER, nothing is withheld ────────────────────────────────────
    const asOwner = await feedFor("owner")
    const ownerCreated = asOwner.find((e) => e.eventType === "RecordVersionCreated")
    expect(ownerCreated?.payload?.fields).toEqual({
      [schema.openId]: "Ada",
      [schema.secretId]: "100",
    })
    const sawFinalHidden = asOwner
      .filter((e) => e.eventType === "RecordVersionUpdated")
      .some((e) => ((e.payload?.patch ?? {}) as Record<string, unknown>)[schema.secretId] === "300")
    expect(sawFinalHidden).toBe(true)
    // …and the owner's `previous` for the hidden field spans the real history. The
    // feed is newest-first, so across the two edits the overwritten values are
    // "200" then "100" — assert the set rather than an order-dependent single hit.
    const ownerHiddenPrevs = asOwner
      .filter((e) => e.eventType === "RecordVersionUpdated")
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
    const asOwner = sessionScope(orgId, userId, "owner", unrestrictedPolicy(userId))

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

    // The owner still reads all of them.
    expect(((await runEngineOrThrow(asOwner, listNotes(rec.recordId))) as unknown[]).length).toBe(1)
    expect(
      ((await runEngineOrThrow(asOwner, listTasks({ subjectId: rec.recordId }))) as unknown[])
        .length,
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
