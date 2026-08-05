import { randomUUID } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { AccessAction } from "../domain/access"
import { emptyPolicy } from "../domain/access"
import type { AutomationAction } from "../domain/types"
import { AutomationService } from "../services/AutomationService"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { RecordService } from "../services/RecordService"
import { newOrgId, testLayer } from "./harness"

/** Orgs shared between a fixture-building layer and the layer that reads it back
 *  under a policy — the id has to be the same on both sides. */
const ORG_A = newOrgId()
const ORG_B = newOrgId()

/** A minimal valid rule: post to Slack when a Deal changes. */
const baseInput = {
  name: "Won deals",
  trigger: { kind: "record.changed" as const },
  actions: [{ kind: "notifySlack" as const, channel: "#wins", text: "hi" }],
}

describe("AutomationService — CRUD + validation", () => {
  it.effect("creates disabled by default, and round-trips the three slots", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create({
        ...baseInput,
        conditions: [{ field: "f1", op: "changedTo", value: "won" }],
        match: "all",
      })
      // Disabled until explicitly enabled — creating a rule must never start
      // writing to records as a side effect.
      expect(a.enabled).toBe(false)
      expect(a.trigger.kind).toBe("record.changed")
      expect(a.conditions).toHaveLength(1)
      expect(a.conditions[0]?.op).toBe("changedTo")
      expect(a.actions[0]?.kind).toBe("notifySlack")
      expect(a.runCount).toBe(0)

      const fetched = yield* automations.getById(a.id)
      expect(fetched.name).toBe("Won deals")
      const list = yield* automations.list()
      expect(list.map((x) => x.id)).toContain(a.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rejects rules that could never fire", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      // No actions.
      const noActions = yield* automations.create({ ...baseInput, actions: [] }).pipe(Effect.flip)
      expect(noActions._tag).toBe("AutomationInvalid")
      // A schedule with no cadence.
      const badSchedule = yield* automations
        .create({ ...baseInput, trigger: { kind: "schedule" } })
        .pipe(Effect.flip)
      expect(badSchedule._tag).toBe("AutomationInvalid")
      // Month day beyond 28 — the cap that stops February silently skipping.
      const badDay = yield* automations
        .create({ ...baseInput, trigger: { kind: "schedule", every: "month", day: 31 } })
        .pipe(Effect.flip)
      expect(badDay._tag).toBe("AutomationInvalid")
      // A webhook to something that isn't http(s).
      const badUrl = yield* automations
        .create({
          ...baseInput,
          actions: [{ kind: "webhook", url: "file:///etc/passwd" }],
        })
        .pipe(Effect.flip)
      expect(badUrl._tag).toBe("AutomationInvalid")
      // A band trigger with no computed field.
      const noField = yield* automations
        .create({ ...baseInput, trigger: { kind: "record.band.changed" } })
        .pipe(Effect.flip)
      expect(noField._tag).toBe("AutomationInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("rejects malformed integration actions at the write boundary", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const reject = (actions: ReadonlyArray<AutomationAction>) =>
        automations.create({ ...baseInput, actions }).pipe(Effect.flip)

      // A reply with nothing to reply to would post at top level forever.
      const noParent = yield* reject([
        { kind: "slack.postThreadReply", channel: "#wins", threadTs: "", text: "hi" },
      ])
      expect(noParent._tag).toBe("AutomationInvalid")

      // Blocks that aren't JSON would fail on every run, with the reason buried
      // in a truncated run note — so they never persist.
      const badJson = yield* reject([
        { kind: "slack.postBlocks", channel: "#wins", blocks: "{not json", text: "fallback" },
      ])
      expect(badJson._tag).toBe("AutomationInvalid")

      const notArray = yield* reject([
        { kind: "slack.postBlocks", channel: "#wins", blocks: '{"type":"header"}', text: "f" },
      ])
      expect(notArray._tag).toBe("AutomationInvalid")

      // Interactive blocks render a button that cannot do anything, because
      // `handleInteractivity` only writes an audit row.
      const interactive = yield* reject([
        {
          kind: "slack.postBlocks",
          channel: "#wins",
          blocks: '[{"type":"actions","elements":[]}]',
          text: "f",
        },
      ])
      expect(interactive._tag).toBe("AutomationInvalid")

      // Omitting fallback text blanks the Slack push notification.
      const noFallback = yield* reject([
        { kind: "slack.postBlocks", channel: "#wins", blocks: '[{"type":"divider"}]', text: "" },
      ])
      expect(noFallback._tag).toBe("AutomationInvalid")

      const noEmoji = yield* reject([
        { kind: "slack.addReaction", channel: "#wins", ts: "{{slack.ts}}", name: "" },
      ])
      expect(noEmoji._tag).toBe("AutomationInvalid")

      const noEmail = yield* reject([{ kind: "linear.assign", email: "  " }])
      expect(noEmail._tag).toBe("AutomationInvalid")

      // Linear has no workspace-default team, so a create without one can't run.
      const noTeam = yield* reject([{ kind: "linear.createIssue", teamId: "", title: "x" }])
      expect(noTeam._tag).toBe("AutomationInvalid")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("accepts the integration actions that are well-formed", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      // `closeIssue`/`updateIssue` resolve their target from the triggering
      // record, so they carry no config of their own and must still save.
      const a = yield* automations.create({
        ...baseInput,
        actions: [
          { kind: "notifySlack", channel: "#wins", text: "{{record.title}}" },
          { kind: "slack.postThreadReply", channel: "", threadTs: "{{slack.ts}}", text: "more" },
          {
            kind: "slack.postBlocks",
            channel: "#wins",
            blocks: '[{"type":"divider"}]',
            text: "fallback",
          },
          {
            kind: "slack.addReaction",
            channel: "{{slack.channel}}",
            ts: "{{slack.ts}}",
            name: ":tada:",
          },
          { kind: "linear.closeIssue" },
          { kind: "linear.comment", body: "done" },
          { kind: "linear.assign", email: "a@b.com" },
        ],
      })
      expect(a.actions).toHaveLength(7)
      expect(a.actions.map((x) => x.kind)).toContain("slack.postBlocks")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("arms a schedule on enable and disarms it on disable", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create({
        ...baseInput,
        trigger: { kind: "schedule", every: "day", hour: 9 },
        enabled: true,
      })
      // Enabled + schedule ⇒ the tick must be able to find it.
      expect(a.nextRunAt).not.toBeNull()
      const off = yield* automations.update({ id: a.id, enabled: false })
      // Disabled ⇒ disarmed, so the tick can't claim a rule no list shows as on.
      expect(off.nextRunAt).toBeNull()
      const on = yield* automations.update({ id: a.id, enabled: true })
      expect(on.nextRunAt).not.toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("archive stops it; restore leaves it OFF", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create({
        ...baseInput,
        trigger: { kind: "schedule", every: "day", hour: 9 },
        enabled: true,
      })
      const archived = yield* automations.archive(a.id)
      expect(archived.archivedAt).not.toBeNull()
      expect(archived.enabled).toBe(false)
      expect(archived.nextRunAt).toBeNull()
      // Live list hides it; includeArchived surfaces it.
      const live = yield* automations.list()
      expect(live.map((x) => x.id)).not.toContain(a.id)
      const all = yield* automations.list({ includeArchived: true })
      expect(all.map((x) => x.id)).toContain(a.id)

      const restored = yield* automations.restore(a.id)
      expect(restored.archivedAt).toBeNull()
      // The important bit: a restore must NOT silently resume writing.
      expect(restored.enabled).toBe(false)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("re-enabling clears a self-pause, so the rate cap can't latch it off", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create({ ...baseInput, enabled: true })
      const paused = yield* automations.pause(a.id, "rate-cap")
      expect(paused.enabled).toBe(false)
      expect(paused.pausedReason).toBe("rate-cap")
      const back = yield* automations.update({ id: a.id, enabled: true })
      expect(back.enabled).toBe(true)
      expect(back.pausedReason).toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("delete removes the row and cascades its runs", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create(baseInput)
      const run = yield* automations.claimRun({
        automationId: a.id,
        eventId: 1,
        subjectId: null,
      })
      expect(run).not.toBeNull()
      yield* automations.remove(a.id)
      const gone = yield* automations.getById(a.id).pipe(Effect.flip)
      expect(gone._tag).toBe("AutomationNotFound")
      // Runs cascaded (the FK is ON DELETE CASCADE) — no orphan rows.
      const runs = yield* automations.listRuns(a.id)
      expect(runs).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("claimRun — the idempotency guard", () => {
  it.effect("a second claim for the SAME event loses the race and gets null", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create(baseInput)

      const first = yield* automations.claimRun({
        automationId: a.id,
        eventId: 42,
        subjectId: null,
      })
      expect(first).not.toBeNull()
      // THE guard: a duplicate delivery (two record versions, an SSE replay) must not
      // act twice. Correctness can't depend on there being one process.
      const second = yield* automations.claimRun({
        automationId: a.id,
        eventId: 42,
        subjectId: null,
      })
      expect(second).toBeNull()
      // A different event is still claimable.
      const other = yield* automations.claimRun({
        automationId: a.id,
        eventId: 43,
        subjectId: null,
      })
      expect(other).not.toBeNull()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("scheduled runs (null event_id) are never deduped against each other", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create(baseInput)
      // A sweep runs once per matching RECORD, so many null-event runs must all
      // be claimable — the unique index is deliberately partial on event_id.
      // (subject_id is a uuid column, hence real uuids here.)
      const r1 = yield* automations.claimRun({
        automationId: a.id,
        eventId: null,
        subjectId: randomUUID(),
      })
      const r2 = yield* automations.claimRun({
        automationId: a.id,
        eventId: null,
        subjectId: randomUUID(),
      })
      expect(r1).not.toBeNull()
      expect(r2).not.toBeNull()
      expect(r1?.id).not.toBe(r2?.id)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("finishRun counts real runs but NOT skips", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create(baseInput)

      const skipped = yield* automations.claimRun({
        automationId: a.id,
        eventId: 1,
        subjectId: null,
      })
      yield* automations.finishRun({
        runId: skipped!.id,
        automationId: a.id,
        status: "skipped",
        detail: { reason: "conditions" },
      })
      // A skip is not a run: counting it would trip the rate cap on events the
      // automation deliberately ignored.
      expect((yield* automations.getById(a.id)).runCount).toBe(0)
      expect(yield* automations.recentRunCount(a.id)).toBe(0)

      const ok = yield* automations.claimRun({
        automationId: a.id,
        eventId: 2,
        subjectId: null,
      })
      yield* automations.finishRun({
        runId: ok!.id,
        automationId: a.id,
        status: "ok",
        detail: { actions: [{ kind: "notifySlack", ok: true }] },
      })
      const after = yield* automations.getById(a.id)
      expect(after.runCount).toBe(1)
      expect(after.lastRunAt).not.toBeNull()
      expect(yield* automations.recentRunCount(a.id)).toBe(1)

      // The history reads newest-first and preserves each run's detail.
      const runs = yield* automations.listRuns(a.id)
      expect(runs).toHaveLength(2)
      expect(runs[0]?.status).toBe("ok")
      expect(runs[0]?.detail.actions?.[0]?.kind).toBe("notifySlack")
      expect(runs[1]?.detail.reason).toBe("conditions")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("the trace", () => {
  it.effect("AutomationRan rides the record's stream WITHOUT bumping its version", () =>
    Effect.gen(function* () {
      const concepts = yield* ConceptService
      const fields = yield* FieldService
      const recordVersions = yield* RecordService
      const automations = yield* AutomationService
      const events = yield* EventStore

      const c = yield* concepts.create({ name: "Deal" })
      yield* fields.addField({ conceptId: c.id, name: "Stage", kind: "text" })
      const inst = yield* recordVersions.create({ conceptId: c.id, fields: {} })
      const a = yield* automations.create(baseInput)

      yield* automations.appendRanEvent({
        automationId: a.id,
        name: a.name,
        subjectId: inst.id,
        conceptId: c.id,
        status: "ok",
        actions: ['createTask: task "Send contract"'],
      })

      // The record's own feed explains itself...
      const stream = yield* events.readStream(inst.id)
      const ran = stream.find((e) => e.eventType === "AutomationRan")
      expect(ran).toBeDefined()
      expect((ran?.payload as { name?: string }).name).toBe("Won deals")

      // ...and the marker must NOT bump `version`, or it would collide with a
      // user's optimistic-concurrency check on their next save.
      const after = yield* recordVersions.get(inst.id)
      expect(after.version).toBe(inst.version)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("a run with no record falls back to the automation's own stream", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const events = yield* EventStore
      const a = yield* automations.create(baseInput)
      yield* automations.appendRanEvent({
        automationId: a.id,
        name: a.name,
        subjectId: null,
        status: "ok",
        actions: [],
      })
      const stream = yield* events.readStream(a.id)
      expect(stream.some((e) => e.eventType === "AutomationRan")).toBe(true)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("definition edits leave an audit trail", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const events = yield* EventStore
      const a = yield* automations.create(baseInput)
      yield* automations.update({ id: a.id, enabled: true })
      yield* automations.update({ id: a.id, name: "Renamed" })
      const stream = yield* events.readStream(a.id)
      const types = stream.map((e) => e.eventType)
      expect(types).toContain("AutomationCreated")
      // An enable is the change people actually audit, so it gets its own tag
      // rather than hiding inside a generic update.
      expect(types).toContain("AutomationEnabled")
      expect(types).toContain("AutomationUpdated")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})

describe("org isolation", () => {
  it.effect("an automation is invisible to another org", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create(baseInput)
      return a.id
    }).pipe(
      Effect.provide(testLayer(newOrgId())),
      Effect.flatMap((id) =>
        Effect.gen(function* () {
          const automations = yield* AutomationService
          const list = yield* automations.list({ includeArchived: true })
          expect(list.map((x) => x.id)).not.toContain(id)
          const notFound = yield* automations.getById(id).pipe(Effect.flip)
          expect(notFound._tag).toBe("AutomationNotFound")
        }).pipe(Effect.provide(testLayer(newOrgId()))),
      ),
    ),
  )
})

/**
 * Automations have no owner column, so their DEFAULT is what the RPC boundary already
 * allows: anyone reads, admins write. Rules are therefore a NARROWING device, and the
 * Automations permission grid is only honest if a deny actually bites — in the list,
 * by id, and on every write path.
 */
describe("per-automation access rules", () => {
  const ACTOR = "user-dana"

  const denyOn = (automationId: string, actions: ReadonlyArray<AccessAction>) => ({
    ...emptyPolicy(ACTOR),
    rules: [
      {
        id: "r1",
        roleId: null,
        actorId: ACTOR,
        effect: "deny" as const,
        actions,
        resourceType: "automation" as const,
        resourceId: automationId,
        conceptId: null,
        condition: null,
      },
    ],
  })

  it.effect("a view deny hides one automation from the list and by id", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const hidden = yield* automations.create(baseInput)
      const shown = yield* automations.create({ ...baseInput, name: "Other" })
      return { org: null, hidden: hidden.id, shown: shown.id }
    }).pipe(
      Effect.provide(testLayer(ORG_A)),
      Effect.flatMap(({ hidden, shown }) =>
        Effect.gen(function* () {
          const automations = yield* AutomationService
          const list = yield* automations.list()
          expect(list.map((x) => x.id)).not.toContain(hidden)
          // The deny is surgical: everything else still lists.
          expect(list.map((x) => x.id)).toContain(shown)
          // Not-found, not a distinct error — the existence of a hidden automation
          // is itself information.
          const err = yield* automations.getById(hidden).pipe(Effect.flip)
          expect(err._tag).toBe("AutomationNotFound")
        }).pipe(Effect.provide(testLayer(ORG_A, ACTOR, "member", denyOn(hidden, ["view"])))),
      ),
    ),
  )

  it.effect("an edit deny freezes an automation that is still readable", () =>
    Effect.gen(function* () {
      const automations = yield* AutomationService
      const a = yield* automations.create(baseInput)
      return a.id
    }).pipe(
      Effect.provide(testLayer(ORG_B)),
      Effect.flatMap((id) =>
        Effect.gen(function* () {
          const automations = yield* AutomationService
          // Readable…
          expect((yield* automations.getById(id)).id).toBe(id)
          // …but every write path refuses, including the ones that only "pause" it.
          const edit = yield* automations.update({ id, name: "Renamed" }).pipe(Effect.flip)
          expect(edit._tag).toBe("AutomationNotFound")
          const archived = yield* automations.archive(id).pipe(Effect.flip)
          expect(archived._tag).toBe("AutomationNotFound")
          const removed = yield* automations.remove(id).pipe(Effect.flip)
          expect(removed._tag).toBe("AutomationNotFound")
        }).pipe(
          Effect.provide(
            testLayer(ORG_B, ACTOR, "member", denyOn(id, ["edit", "archive", "delete"])),
          ),
        ),
      ),
    ),
  )
})
