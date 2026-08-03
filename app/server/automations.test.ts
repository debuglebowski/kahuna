import { describe, expect, it } from "vitest"
import { type AutomationTrigger, isAutomationActor, nextRunAfter } from "#engine"
import { noteForFailure, renderTemplate, resolveTransition, triggerMatches } from "./automations"

const trig = (t: Partial<AutomationTrigger> & { kind: AutomationTrigger["kind"] }) =>
  t as AutomationTrigger

describe("triggerMatches — the event-log filter", () => {
  it("maps a trigger kind to its event types", () => {
    expect(triggerMatches(trig({ kind: "record.created" }), { type: "InstanceCreated" })).toBe(true)
    expect(triggerMatches(trig({ kind: "record.created" }), { type: "InstanceUpdated" })).toBe(
      false,
    )
    // An amendment folds like an update, so record.changed must accept both.
    expect(triggerMatches(trig({ kind: "record.changed" }), { type: "InstanceUpdated" })).toBe(true)
    expect(triggerMatches(trig({ kind: "record.changed" }), { type: "VersionAmended" })).toBe(true)
    // Legacy archive tag still counts as archived.
    expect(triggerMatches(trig({ kind: "record.archived" }), { type: "InstanceDeleted" })).toBe(
      true,
    )
  })

  it("a schedule trigger never matches an event", () => {
    expect(
      triggerMatches(trig({ kind: "schedule", every: "day" }), { type: "InstanceCreated" }),
    ).toBe(false)
  })

  it("scopes by concept id — and never fires on an unattributed event", () => {
    const t = trig({ kind: "record.created", conceptId: "deal" })
    expect(triggerMatches(t, { type: "InstanceCreated", conceptId: "deal" })).toBe(true)
    expect(triggerMatches(t, { type: "InstanceCreated", conceptId: "person" })).toBe(false)
    // The important one: a concept-scoped rule must NOT fire when we couldn't
    // attribute the event to a concept — that would be a silent over-fire.
    expect(triggerMatches(t, { type: "InstanceCreated", conceptId: null })).toBe(false)
    // An unscoped trigger still accepts anything.
    expect(
      triggerMatches(trig({ kind: "record.created" }), {
        type: "InstanceCreated",
        conceptId: null,
      }),
    ).toBe(true)
  })

  it("record.changed with a field id fires only when that field is in the patch", () => {
    const t = trig({ kind: "record.changed", fieldId: "f-stage" })
    expect(
      triggerMatches(t, { type: "InstanceUpdated", payload: { patch: { "f-stage": "won" } } }),
    ).toBe(true)
    expect(
      triggerMatches(t, { type: "InstanceUpdated", payload: { patch: { "f-value": 10 } } }),
    ).toBe(false)
    // A field explicitly cleared to null IS in the patch, so it counts.
    expect(
      triggerMatches(t, { type: "InstanceUpdated", payload: { patch: { "f-stage": null } } }),
    ).toBe(true)
    expect(triggerMatches(t, { type: "InstanceUpdated", payload: {} })).toBe(false)
  })

  it("band + task-status triggers narrow on their payload", () => {
    const band = trig({ kind: "record.band.changed", fieldId: "f-heat", band: "cold" })
    expect(
      triggerMatches(band, {
        type: "ComputedBandChanged",
        payload: { field: "f-heat", to: "cold" },
      }),
    ).toBe(true)
    // Right field, wrong destination band.
    expect(
      triggerMatches(band, {
        type: "ComputedBandChanged",
        payload: { field: "f-heat", to: "cooling" },
      }),
    ).toBe(false)
    // Another decay field's crossing must not fire this rule.
    expect(
      triggerMatches(band, {
        type: "ComputedBandChanged",
        payload: { field: "f-other", to: "cold" },
      }),
    ).toBe(false)

    const st = trig({ kind: "task.status.changed", statusId: "s-done" })
    expect(triggerMatches(st, { type: "TaskStatusChanged", payload: { to: "s-done" } })).toBe(true)
    expect(triggerMatches(st, { type: "TaskStatusChanged", payload: { to: "s-open" } })).toBe(false)
  })

  it("an unknown trigger kind never matches (forward compatibility)", () => {
    expect(
      triggerMatches(trig({ kind: "future.thing" as never }), { type: "InstanceCreated" }),
    ).toBe(false)
  })
})

describe("the one-hop guard", () => {
  it("recognises automation actors and nothing else", () => {
    expect(isAutomationActor("system:automation:abc")).toBe(true)
    expect(isAutomationActor("system:decay-tick")).toBe(false)
    expect(isAutomationActor("user-123")).toBe(false)
    expect(isAutomationActor(null)).toBe(false)
    expect(isAutomationActor(undefined)).toBe(false)
  })
})

describe("renderTemplate — substitution, not evaluation", () => {
  const ctx = {
    title: "Acme Renewal",
    url: "/records/r1",
    actor: "system:automation:a1",
    now: new Date("2026-03-04T05:06:07.000Z"),
    from: "nego",
    to: "won",
    fields: { "f-value": 5000, "f-empty": null },
  }

  it("resolves every documented token", () => {
    expect(renderTemplate("{{record.title}} → {{trigger.to}}", ctx)).toBe("Acme Renewal → won")
    expect(renderTemplate("was {{trigger.from}}", ctx)).toBe("was nego")
    expect(renderTemplate("{{field:f-value}}", ctx)).toBe("5000")
    expect(renderTemplate("{{record.url}}", ctx)).toBe("/records/r1")
    expect(renderTemplate("{{actor}}", ctx)).toBe("system:automation:a1")
    expect(renderTemplate("{{now}}", ctx)).toBe("2026-03-04T05:06:07.000Z")
  })

  it("an unknown token renders empty rather than throwing", () => {
    // A typo in a Slack message must not fail a run.
    expect(renderTemplate("[{{nope}}]", ctx)).toBe("[]")
    expect(renderTemplate("[{{field:missing}}]", ctx)).toBe("[]")
    expect(renderTemplate("[{{field:f-empty}}]", ctx)).toBe("[]")
  })

  it("tolerates whitespace, leaves non-tokens alone, and has no expression syntax", () => {
    expect(renderTemplate("{{ record.title }}", ctx)).toBe("Acme Renewal")
    expect(renderTemplate("plain text", ctx)).toBe("plain text")
    expect(renderTemplate("{ record.title }", ctx)).toBe("{ record.title }")
    // Not an evaluator: arithmetic/paths beyond the closed set are just unknown.
    expect(renderTemplate("{{1+1}}", ctx)).toBe("{{1+1}}")
    expect(renderTemplate("{{record.state.secret}}", ctx)).toBe("")
  })

  it("renders empty context fields as empty strings", () => {
    expect(renderTemplate("{{record.title}}/{{trigger.to}}", {})).toBe("/")
  })
})

describe("nextRunAfter — schedule arithmetic", () => {
  // A fixed clock: Wednesday 2026-03-04T12:00:00Z.
  const from = new Date("2026-03-04T12:00:00.000Z")

  it("daily: today if the hour is still ahead, else tomorrow", () => {
    expect(nextRunAfter(trig({ kind: "schedule", every: "day", hour: 18 }), from)).toEqual(
      new Date("2026-03-04T18:00:00.000Z"),
    )
    expect(nextRunAfter(trig({ kind: "schedule", every: "day", hour: 9 }), from)).toEqual(
      new Date("2026-03-05T09:00:00.000Z"),
    )
    // Exactly now still moves forward — "strictly after" is what stops a run
    // from re-claiming itself inside the same tick.
    expect(nextRunAfter(trig({ kind: "schedule", every: "day", hour: 12 }), from)).toEqual(
      new Date("2026-03-05T12:00:00.000Z"),
    )
  })

  it("weekly: the next occurrence of the weekday", () => {
    // Wed → Fri (weekday 5) is 2 days out.
    expect(
      nextRunAfter(trig({ kind: "schedule", every: "week", weekday: 5, hour: 9 }), from),
    ).toEqual(new Date("2026-03-06T09:00:00.000Z"))
    // Wed → Mon (weekday 1) wraps to next week.
    expect(
      nextRunAfter(trig({ kind: "schedule", every: "week", weekday: 1, hour: 9 }), from),
    ).toEqual(new Date("2026-03-09T09:00:00.000Z"))
    // Same weekday, hour already passed → a full week later.
    expect(
      nextRunAfter(trig({ kind: "schedule", every: "week", weekday: 3, hour: 9 }), from),
    ).toEqual(new Date("2026-03-11T09:00:00.000Z"))
  })

  it("monthly: this month if the day is ahead, else next month", () => {
    expect(
      nextRunAfter(trig({ kind: "schedule", every: "month", day: 20, hour: 9 }), from),
    ).toEqual(new Date("2026-03-20T09:00:00.000Z"))
    expect(nextRunAfter(trig({ kind: "schedule", every: "month", day: 1, hour: 9 }), from)).toEqual(
      new Date("2026-04-01T09:00:00.000Z"),
    )
  })

  it("monthly day 28 survives a February rollover", () => {
    // The reason the editor caps at 28: every month contains it, so a schedule
    // can never silently skip a month.
    const jan31 = new Date("2026-01-31T12:00:00.000Z")
    expect(
      nextRunAfter(trig({ kind: "schedule", every: "month", day: 28, hour: 9 }), jan31),
    ).toEqual(new Date("2026-02-28T09:00:00.000Z"))
  })

  it("returns null for a non-schedule trigger", () => {
    expect(nextRunAfter(trig({ kind: "record.created" }), from)).toBeNull()
    // And for a schedule with no cadence (validation rejects it, but the helper
    // must not invent a time).
    expect(nextRunAfter(trig({ kind: "schedule" }), from)).toBeNull()
  })
})

describe("resolveTransition — what {{trigger.from|to}} mean", () => {
  const t = (o: Partial<AutomationTrigger> = {}) =>
    ({ kind: "record.changed", ...o }) as AutomationTrigger

  it("uses literal from/to when the event carries them", () => {
    // Band + task-status events do carry them.
    expect(
      resolveTransition({
        trigger: t({ kind: "record.band.changed" }),
        payload: { from: "warm", to: "cold" },
        prevState: null,
        nextState: null,
      }),
    ).toEqual({ from: "warm", to: "cold" })
  })

  it("derives them from the patch + pre-state for a record edit", () => {
    // The bug this fixes: a record edit carries NEITHER from nor to, so reading
    // payload.to rendered {{trigger.to}} empty on the most common trigger.
    expect(
      resolveTransition({
        trigger: t({ fieldId: "f-stage" }),
        payload: { patch: { "f-stage": "won" } },
        prevState: { "f-stage": "nego" },
        nextState: { "f-stage": "won" },
      }),
    ).toEqual({ from: "nego", to: "won" })
  })

  it("infers the field when the patch changed exactly one", () => {
    expect(
      resolveTransition({
        trigger: t(),
        payload: { patch: { "f-stage": "won" } },
        prevState: { "f-stage": "nego" },
        nextState: { "f-stage": "won" },
      }),
    ).toEqual({ from: "nego", to: "won" })
  })

  it("stays empty when a multi-field patch has no pinned field", () => {
    // No honest answer, so no guess.
    expect(
      resolveTransition({
        trigger: t(),
        payload: { patch: { a: 1, b: 2 } },
        prevState: { a: 0, b: 0 },
        nextState: { a: 1, b: 2 },
      }),
    ).toEqual({ from: undefined, to: undefined })
  })

  it("ignores engine markers when inferring the field", () => {
    // `__labels` rides the same patch; it must not count as "the changed field".
    expect(
      resolveTransition({
        trigger: t(),
        payload: { patch: { "f-stage": "won", __labels: ["l1"] } },
        prevState: { "f-stage": "nego" },
        nextState: { "f-stage": "won" },
      }),
    ).toEqual({ from: "nego", to: "won" })
  })

  it("falls back to the patch value when no folded state is available", () => {
    expect(
      resolveTransition({
        trigger: t({ fieldId: "f-stage" }),
        payload: { patch: { "f-stage": "won" } },
        prevState: null,
        nextState: null,
      }),
    ).toEqual({ from: undefined, to: "won" })
  })
})

describe("automations are governed actors (P4)", () => {
  /**
   * The behavioural contract of making an automation an actor:
   *   1. A fresh automation gets the full-access preset, so nothing breaks on rollout.
   *   2. A write outside its role fails with a note a human can act on — "forbidden",
   *      never the bare `InstanceNotFound` the engine reports to avoid an existence
   *      oracle (right for a user request, useless in a run log).
   */
  it("noteForFailure translates a policy block into prose, and passes other errors through", () => {
    // With a subject in hand, a missing record means THIS automation's access — the
    // runner resolved that record moments earlier, unrestricted.
    const subject = { instance: { id: "i1" } as never, conceptId: "c1" }
    expect(noteForFailure({ _tag: "InstanceNotFound" }, subject)).toContain("forbidden")
    expect(noteForFailure({ _tag: "ItemNotFound" }, subject)).toContain("forbidden")
    // Everything else keeps its tag — a validation failure must not read as a
    // permission problem.
    expect(noteForFailure({ _tag: "FieldValidationError" }, subject)).toBe("FieldValidationError")
    expect(noteForFailure({ _tag: "VersionConflict" }, subject)).toBe("VersionConflict")
    // With NO subject there was nothing to be forbidden from.
    expect(noteForFailure({ _tag: "InstanceNotFound" }, null)).toBe("InstanceNotFound")
  })
})
