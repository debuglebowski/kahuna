import { describe, expect, it } from "@effect/vitest"
import { latestVersionName, nextVersionName } from "@kahunalabs/contract"
import { Effect } from "effect"
import { emptyPolicy, type PolicySet, unrestrictedPolicy } from "../domain/access"
import type { ApprovalPolicy } from "../domain/types"
import { ConceptService } from "../services/ConceptService"
import { FieldService } from "../services/FieldService"
import { OrgContext } from "../services/OrgContext"
import { RecordService } from "../services/RecordService"
import { RelationService } from "../services/RelationService"
import { newOrgId, testLayer } from "./harness"

/**
 * Named versions + approval — the policy "Document History" table, as events.
 * The default actor is "tester"; `as(...)` re-runs a step as someone else so an
 * approval really is a second person's event.
 */

const versioned = (approvalPolicy: ApprovalPolicy = "none") =>
  Effect.gen(function* () {
    const concepts = yield* ConceptService
    const fields = yield* FieldService
    const records = yield* RecordService
    const c = yield* concepts.create({ name: `Policy ${Math.random()}` })
    yield* concepts.update({ id: c.id, description: null, versioningEnabled: true, approvalPolicy })
    const title = yield* fields.addField({ conceptId: c.id, name: "title", kind: "text" })
    const draft = yield* records.create({ conceptId: c.id, fields: { [title.id]: "Access" } })
    return { concept: c, title, draft }
  })

const as =
  (orgId: string, actor: string, policy?: PolicySet) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    Effect.provideService(eff, OrgContext, {
      orgId,
      actor,
      role: policy ? "member" : "system",
      policy: policy ?? unrestrictedPolicy(actor),
    })

/** Can SEE policies, can't edit them — the approver Sara typically is. */
const viewOnly = (actor: string): PolicySet => ({
  ...emptyPolicy(actor),
  rules: [
    {
      id: "v-concept",
      roleId: "r",
      effect: "allow",
      actions: ["view"],
      resourceType: "concept",
      resourceId: null,
      conceptId: null,
      condition: null,
    },
    {
      id: "v-record",
      roleId: "r",
      effect: "allow",
      actions: ["view"],
      resourceType: "record",
      resourceId: null,
      conceptId: null,
      condition: null,
    },
  ],
})

describe("nextVersionName", () => {
  it("bumps the last number of a free-text name", () => {
    expect(nextVersionName("1.1.0")).toBe("1.1.1")
    expect(nextVersionName("v3")).toBe("v4")
    expect(nextVersionName("Rev 7 (final)")).toBe("Rev 8 (final)")
    expect(nextVersionName("1.09")).toBe("1.10")
    expect(nextVersionName(null)).toBe("1.0")
    expect(nextVersionName("Draft A")).toBe("1.0")
  })
  it("reads the newest named published version", () => {
    const v = (versionSeq: number, name: string | null, versionStatus = "published" as const) => ({
      versionSeq,
      versionStatus,
      release: { name },
    })
    expect(latestVersionName([v(0, "1.0.0"), v(1, "1.1.0"), v(2, null)])).toBe("1.1.0")
    expect(latestVersionName([])).toBeNull()
  })
})

describe("version release", () => {
  it.effect("publish records name, note, kind, date and author; rebuild reproduces it", () =>
    Effect.gen(function* () {
      const records = yield* RecordService
      const { draft } = yield* versioned()
      const pub = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        name: " 1.0.0 ",
        note: "First issue",
        effectiveDate: "2026-10-12",
      })
      expect(pub.versionStatus).toBe("published")
      expect(pub.release).toMatchObject({
        name: "1.0.0",
        note: "First issue",
        effectiveDate: "2026-10-12",
        publishedBy: "tester",
        approvedBy: null,
        pending: null,
      })
      const rebuilt = yield* records.rebuild(draft.id)
      expect(rebuilt.release).toEqual(pub.release)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a name is unique within the lineage; bad dates are refused", () =>
    Effect.gen(function* () {
      const records = yield* RecordService
      const { draft } = yield* versioned()
      const v1 = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        name: "1.0.0",
      })
      const v2 = yield* records.newVersion({ recordId: v1.recordId })
      const dup = yield* records
        .publishVersion({ recordVersionId: v2.id, expectedVersion: v2.version, name: "1.0.0" })
        .pipe(Effect.flip)
      expect(dup._tag).toBe("VersionReleaseInvalid")
      const badDate = yield* records
        .publishVersion({
          recordVersionId: v2.id,
          expectedVersion: v2.version,
          name: "1.1.0",
          effectiveDate: "2026-02-30",
        })
        .pipe(Effect.flip)
      expect(badDate._tag).toBe("VersionReleaseInvalid")
      // A legacy caller (no release info at all) still publishes, unnamed.
      const plain = yield* records.publishVersion({
        recordVersionId: v2.id,
        expectedVersion: v2.version,
      })
      expect(plain.release.name).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("policy 'all': every publish needs an approver, never yourself", () =>
    Effect.gen(function* () {
      const records = yield* RecordService
      const { draft } = yield* versioned("all")
      const noApprover = yield* records
        .publishVersion({ recordVersionId: draft.id, expectedVersion: draft.version, name: "1.0" })
        .pipe(Effect.flip)
      expect(noApprover._tag).toBe("VersionReleaseInvalid")
      const self = yield* records
        .publishVersion({
          recordVersionId: draft.id,
          expectedVersion: draft.version,
          approverId: "tester",
        })
        .pipe(Effect.flip)
      expect(self._tag).toBe("VersionReleaseInvalid")
      const req = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        approverId: "sara",
      })
      expect(req.release.pending?.approverId).toBe("sara")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "approval: request locks the draft; only the named approver signs off, on read access",
    () => {
      const orgId = newOrgId()
      return Effect.gen(function* () {
        const records = yield* RecordService
        const { draft, title } = yield* versioned("all")
        const req = yield* records.publishVersion({
          recordVersionId: draft.id,
          expectedVersion: draft.version,
          name: "2.0.0",
          note: "Privileged access removed same business day",
          approverId: "sara",
          taskId: "task-1",
        })
        expect(req.versionStatus).toBe("draft")
        expect(req.release.pending).toMatchObject({
          approverId: "sara",
          requestedBy: "tester",
          name: "2.0.0",
          taskId: "task-1",
        })
        // Locked: no edit, discard, archive or second request while pending.
        const edit = yield* records
          .update({
            recordVersionId: draft.id,
            expectedVersion: req.version,
            patch: { [title.id]: "x" },
          })
          .pipe(Effect.flip)
        expect(edit._tag).toBe("VersionPendingApproval")
        expect(
          (yield* records.discardDraft({ recordVersionId: draft.id }).pipe(Effect.flip))._tag,
        ).toBe("VersionPendingApproval")
        // Someone else can't approve.
        const wrong = yield* as(
          orgId,
          "mallory",
        )(records.approveVersion({ recordVersionId: draft.id })).pipe(Effect.flip)
        expect(wrong._tag).toBe("NotTheApprover")
        // Sara can only VIEW policies — and that is enough to sign off.
        const approved = yield* as(
          orgId,
          "sara",
          viewOnly("sara"),
        )(records.approveVersion({ recordVersionId: draft.id }))
        expect(approved.versionStatus).toBe("published")
        expect(approved.release).toMatchObject({
          name: "2.0.0",
          note: "Privileged access removed same business day",
          publishedBy: "tester",
          approvedBy: "sara",
          pending: null,
        })
        expect(approved.release.approvedAt).not.toBeNull()
        // Replay == incremental.
        expect((yield* records.rebuild(draft.id)).release).toEqual(approved.release)
        // Signed-off info is frozen.
        const backfill = yield* records
          .setVersionInfo({ recordVersionId: draft.id, note: "changed after" })
          .pipe(Effect.flip)
        expect(backfill._tag).toBe("VersionReleaseInvalid")
      }).pipe(Effect.provide(testLayer(orgId)))
    },
  )

  it.effect("reject and withdraw unlock the draft; rejection reason is kept", () => {
    const orgId = newOrgId()
    return Effect.gen(function* () {
      const records = yield* RecordService
      const { draft, title } = yield* versioned("all")
      const req = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        approverId: "sara",
      })
      const rejected = yield* as(
        orgId,
        "sara",
      )(records.rejectVersion({ recordVersionId: draft.id, reason: "Cite ISO clause" }))
      expect(rejected.release.pending).toBeNull()
      expect(rejected.release.lastRejection).toMatchObject({
        by: "sara",
        reason: "Cite ISO clause",
      })
      // Editable again.
      const edited = yield* records.update({
        recordVersionId: draft.id,
        expectedVersion: rejected.version,
        patch: { [title.id]: "Access v2" },
      })
      const again = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: edited.version,
        approverId: "sara",
      })
      expect(again.version).toBeGreaterThan(req.version)
      const withdrawn = yield* records.withdrawApproval({ recordVersionId: draft.id })
      expect(withdrawn.release.pending).toBeNull()
      expect(withdrawn.versionStatus).toBe("draft")
    }).pipe(Effect.provide(testLayer(orgId)))
  })

  it.effect("voluntary approval works under policy 'none'", () => {
    const orgId = newOrgId()
    return Effect.gen(function* () {
      const records = yield* RecordService
      const { draft } = yield* versioned("none")
      const req = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
        approverId: "sara",
      })
      expect(req.release.pending?.approverId).toBe("sara")
      const ok = yield* as(orgId, "sara")(records.approveVersion({ recordVersionId: draft.id }))
      expect(ok.release.approvedBy).toBe("sara")
    }).pipe(Effect.provide(testLayer(orgId)))
  })

  it.effect("backfill: setVersionInfo names an imported v1", () =>
    Effect.gen(function* () {
      const records = yield* RecordService
      const { draft } = yield* versioned()
      const v1 = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })
      const named = yield* records.setVersionInfo({
        recordVersionId: v1.id,
        name: "1.1.0",
        note: "Privileged access removed same business day",
        effectiveDate: "2026-10-12",
        attributedAuthor: "Kalle",
        attributedApprover: "Sara",
      })
      expect(named.release).toMatchObject({
        name: "1.1.0",
        effectiveDate: "2026-10-12",
        attributedAuthor: "Kalle",
        attributedApprover: "Sara",
        publishedBy: "tester",
      })
      // Only the keys sent change; null clears.
      const cleared = yield* records.setVersionInfo({ recordVersionId: v1.id, note: null })
      expect(cleared.release.note).toBeNull()
      expect(cleared.release.name).toBe("1.1.0")
      expect((yield* records.rebuild(v1.id)).release).toEqual(cleared.release)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("history import goes BEFORE v1, newest first; Latest is unchanged; frozen", () =>
    Effect.gen(function* () {
      const records = yield* RecordService
      const relations = yield* RelationService
      const fields = yield* FieldService
      const concepts = yield* ConceptService
      const { draft, title, concept } = yield* versioned()
      const v1 = yield* records.publishVersion({
        recordVersionId: draft.id,
        expectedVersion: draft.version,
      })
      yield* records.setVersionInfo({
        recordVersionId: v1.id,
        name: "1.1.0",
        effectiveDate: "2026-10-12",
      })
      const h1 = yield* records.importHistoricalVersion({
        recordId: v1.recordId,
        name: "1.0.1",
        note: "Typo fixes",
        effectiveDate: "2026-03-01",
        attributedAuthor: "Kalle",
        attributedApprover: "Sara",
      })
      expect(h1.versionSeq).toBe(0)
      expect(h1.versionStatus).toBe("published")
      expect(h1.release.historical).toBe(true)
      expect(h1.state[title.id]).toBe("Access")
      // Newer than the current oldest → refused (import newest first).
      const late = yield* records
        .importHistoricalVersion({
          recordId: v1.recordId,
          name: "1.0.2",
          effectiveDate: "2026-05-01",
        })
        .pipe(Effect.flip)
      expect(late._tag).toBe("VersionReleaseInvalid")
      const h0 = yield* records.importHistoricalVersion({
        recordId: v1.recordId,
        name: "1.0.0",
        effectiveDate: "2025-01-15",
      })
      expect(h0.versionSeq).toBe(-1)
      // Names are still unique across real + history rows.
      const dup = yield* records
        .importHistoricalVersion({
          recordId: v1.recordId,
          name: "1.1.0",
          effectiveDate: "2024-01-01",
        })
        .pipe(Effect.flip)
      expect(dup._tag).toBe("VersionReleaseInvalid")
      // Lineage reads oldest → newest; Latest is still v1.
      const list = yield* records.listVersions(v1.recordId)
      expect(list.map((v) => v.release.name)).toEqual(["1.0.0", "1.0.1", "1.1.0"])
      expect((yield* records.headOf(v1.recordId))?.id).toBe(v1.id)
      // Frozen even when the concept allows amendments.
      yield* concepts.update({ id: concept.id, description: null, editReach: "any" })
      const amend = yield* records
        .update({ recordVersionId: h1.id, expectedVersion: h1.version, patch: { [title.id]: "x" } })
        .pipe(Effect.flip)
      expect(amend._tag).toBe("VersionFrozen")
      // Never a pin target.
      const other = yield* concepts.create({ name: `Ref ${Math.random()}` })
      const rel = yield* fields.addField({
        conceptId: other.id,
        name: "policy",
        kind: "relation",
        config: { target: concept.id, cardinality: "one" },
      })
      const from = yield* records.create({ conceptId: other.id, fields: {} })
      const pin = yield* relations
        .create({ fieldId: rel.id, fromId: from.id, toRecordId: v1.recordId, toVersionId: h1.id })
        .pipe(Effect.flip)
      expect(pin._tag).toBe("RelationPinToDraft")
      // A new draft still branches from Latest and gets the next seq.
      const next = yield* records.newVersion({ recordId: v1.recordId })
      expect(next.versionSeq).toBe(2)
      expect((yield* records.rebuild(h1.id)).release).toEqual(
        list.find((v) => v.id === h1.id)?.release,
      )
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
