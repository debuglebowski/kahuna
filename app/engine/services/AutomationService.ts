import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type {
  Automation,
  AutomationAction,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunStatus,
  AutomationTrigger,
  ConditionMatch,
  SidebarCondition,
} from "../domain/types"
import { AutomationInvalid, AutomationNotFound } from "../errors"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { type AutomationRow, type AutomationRunRow, toAutomation, toAutomationRun } from "./rows"

/** Trigger kinds this build accepts. Append-only — a stored row with an unknown
 *  kind still loads (see `toAutomation`), it just never matches. */
const TRIGGER_KINDS = new Set([
  "record.created",
  "record.changed",
  "record.archived",
  "version.published",
  "record.band.changed",
  "task.created",
  "task.status.changed",
  "schedule",
])

const ACTION_KINDS = new Set([
  "setField",
  "addLabel",
  "removeLabel",
  "createTask",
  "createRecord",
  "archiveRecord",
  "notifySlack",
  "webhook",
])

/**
 * How many runs per minute one automation may make before it pauses ITSELF.
 * A runaway then costs a bounded number of writes plus one visible row, instead
 * of a table and an afternoon. Deliberately generous — a legitimate bulk import
 * can trip it, and re-enabling is one click.
 */
export const RATE_CAP_PER_MIN = 20

/**
 * Why a webhook URL is unacceptable, or null if it looks fine. Rejects at SAVE
 * time so an obviously-internal target never persists.
 *
 * This is a fast textual screen, NOT the security boundary — it cannot resolve
 * DNS (the engine is sync/pure here) and the URL may contain `{{tokens}}` that
 * only resolve at run time. `server/integrations/url-guard.ts` re-checks and
 * resolves at SEND time; that is what actually stops SSRF. Kept in sync
 * deliberately: catching `http://127.0.0.1` in the editor is much better UX than
 * a rule that saves cleanly and then fails on every run.
 *
 * A URL containing a template token skips the host checks — the host isn't known
 * until render, and the send-time guard covers it.
 */
const webhookUrlProblem = (raw: string): string | null => {
  const url = raw.trim()
  if (!/^https?:\/\/.+/i.test(url)) return "webhook needs an http(s) URL"
  if (url.includes("{{")) return null // host resolved at run time; guarded there
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "webhook needs an http(s) URL"
  }
  if (parsed.username || parsed.password) return "webhook URL must not embed credentials"
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "webhook URL must be publicly reachable, not localhost"
  }
  // Literal non-routable IPv4/IPv6 — the metadata service (169.254.169.254) and
  // anything on the container's own network.
  //
  // `new URL()` rewrites an IPv4-mapped v6 literal into HEX
  // (`::ffff:169.254.169.254` → `::ffff:a9fe:a9fe`), so decode that back before
  // the v4 rules or the mapped spelling sails past every check below.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  const asV4 = mappedHex
    ? (() => {
        const hi = Number.parseInt(mappedHex[1]!, 16)
        const lo = Number.parseInt(mappedHex[2]!, 16)
        return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".")
      })()
    : (mappedDotted?.[1] ?? host)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(asV4)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    if (blocked) return "webhook URL must be a public address"
  }
  if (host === "::" || host === "::1" || /^(fe[89ab]|f[cd]|ff)/.test(host)) {
    return "webhook URL must be a public address"
  }
  return null
}

/** Validate a trigger document at the write boundary, so a rule that could never
 *  fire (or could fire on garbage) is never persisted. */
const validateTrigger = (t: AutomationTrigger) =>
  Effect.gen(function* () {
    if (!TRIGGER_KINDS.has(t.kind)) {
      return yield* Effect.fail(new AutomationInvalid({ reason: `unknown trigger "${t.kind}"` }))
    }
    if (t.kind === "schedule") {
      if (t.every !== "day" && t.every !== "week" && t.every !== "month") {
        return yield* Effect.fail(
          new AutomationInvalid({ reason: "a schedule needs every = day | week | month" }),
        )
      }
      const hour = t.hour ?? 9
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return yield* Effect.fail(new AutomationInvalid({ reason: "hour must be 0-23" }))
      }
      if (t.every === "week") {
        const wd = t.weekday ?? 1
        if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
          return yield* Effect.fail(new AutomationInvalid({ reason: "weekday must be 0-6" }))
        }
      }
      if (t.every === "month") {
        const d = t.day ?? 1
        // Capped at 28 so every month actually contains the day — no "the 31st
        // silently never runs in February".
        if (!Number.isInteger(d) || d < 1 || d > 28) {
          return yield* Effect.fail(new AutomationInvalid({ reason: "day must be 1-28" }))
        }
      }
    }
    if (t.kind === "record.band.changed" && !t.fieldId) {
      return yield* Effect.fail(
        new AutomationInvalid({ reason: "a band trigger needs a computed field" }),
      )
    }
  })

/** Validate the action list. Each check is the one that would otherwise surface
 *  as a confusing mid-run failure. */
const validateActions = (actions: ReadonlyArray<AutomationAction>) =>
  Effect.gen(function* () {
    if (actions.length === 0) {
      return yield* Effect.fail(new AutomationInvalid({ reason: "add at least one action" }))
    }
    for (const a of actions) {
      if (!ACTION_KINDS.has(a.kind)) {
        return yield* Effect.fail(new AutomationInvalid({ reason: `unknown action "${a.kind}"` }))
      }
      if (a.kind === "setField" && !a.fieldId) {
        return yield* Effect.fail(new AutomationInvalid({ reason: "setField needs a field" }))
      }
      if ((a.kind === "addLabel" || a.kind === "removeLabel") && !a.labelId) {
        return yield* Effect.fail(new AutomationInvalid({ reason: `${a.kind} needs a label` }))
      }
      if (a.kind === "createTask" && !a.title.trim()) {
        return yield* Effect.fail(new AutomationInvalid({ reason: "createTask needs a title" }))
      }
      if (a.kind === "createRecord" && !a.conceptId) {
        return yield* Effect.fail(new AutomationInvalid({ reason: "createRecord needs a concept" }))
      }
      if (a.kind === "notifySlack" && !a.channel.trim()) {
        return yield* Effect.fail(new AutomationInvalid({ reason: "notifySlack needs a channel" }))
      }
      if (a.kind === "webhook") {
        const reason = webhookUrlProblem(a.url ?? "")
        if (reason) return yield* Effect.fail(new AutomationInvalid({ reason }))
      }
    }
  })

/**
 * Compute the next due timestamp for a schedule trigger, strictly AFTER `from`.
 *
 * Deliberately plain UTC arithmetic on the hour/weekday/day fields rather than a
 * cron parser: the vocabulary is only day/week/month, and a dependency-free
 * implementation is one that can be unit-tested against a fixed clock. "Strictly
 * after" is what stops a run from re-claiming itself within the same tick.
 */
export const nextRunAfter = (t: AutomationTrigger, from: Date): Date | null => {
  if (t.kind !== "schedule") return null
  const hour = t.hour ?? 9
  const next = new Date(from)
  next.setUTCHours(hour, 0, 0, 0)
  if (t.every === "day") {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1)
    return next
  }
  if (t.every === "week") {
    const target = t.weekday ?? 1
    // Days until the target weekday; 0 means "today", which we then push a week
    // if the hour has already passed.
    const delta = (target - next.getUTCDay() + 7) % 7
    next.setUTCDate(next.getUTCDate() + delta)
    if (next <= from) next.setUTCDate(next.getUTCDate() + 7)
    return next
  }
  if (t.every === "month") {
    const day = t.day ?? 1
    next.setUTCDate(day)
    if (next <= from) {
      next.setUTCMonth(next.getUTCMonth() + 1)
      // Re-set the day: rolling the month over a shorter one can shift it.
      next.setUTCDate(day)
    }
    return next
  }
  return null
}

/**
 * CRUD for automations, plus the two primitives the runner needs: an atomic
 * `claimRun` (the idempotency guard) and `finishRun`.
 *
 * The service owns validation and the event trail; the RUNNER (server/
 * automations.ts) owns matching and execution. That split keeps the engine free
 * of any knowledge of Slack, HTTP or scheduling.
 */
export class AutomationService extends Effect.Service<AutomationService>()(
  "engine/AutomationService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const events = yield* EventStore

      const list = (opts: { readonly includeArchived?: boolean } = {}) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const liveOnly = opts.includeArchived ? sql`` : sql` AND archived_at IS NULL`
          const rows = yield* sql<AutomationRow>`
            SELECT * FROM automations WHERE org_id = ${orgId}${liveOnly}
            ORDER BY created_at DESC`
          return rows.map(toAutomation)
        }).pipe(Effect.orDie)

      const getById = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AutomationRow>`
            SELECT * FROM automations WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
          const row = rows[0]
          if (!row) return yield* Effect.fail(new AutomationNotFound({ automationId: id }))
          return toAutomation(row)
        })

      const create = (input: {
        readonly name: string
        readonly trigger: AutomationTrigger
        readonly conditions?: ReadonlyArray<SidebarCondition>
        readonly match?: ConditionMatch
        readonly actions: ReadonlyArray<AutomationAction>
        readonly enabled?: boolean
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            yield* validateTrigger(input.trigger)
            yield* validateActions(input.actions)
            const name = input.name.trim() || "Untitled automation"
            // A schedule automation must know when it is next due the moment it
            // becomes enabled, or the tick would never pick it up.
            const nextRunAt =
              input.trigger.kind === "schedule" && input.enabled
                ? nextRunAfter(input.trigger, new Date())
                : null
            const rows = yield* sql<AutomationRow>`
              INSERT INTO automations
                (org_id, name, enabled, trigger, conditions, match, actions, next_run_at, created_by)
              VALUES (
                ${orgId}, ${name}, ${input.enabled ?? false},
                ${sql.json(input.trigger)},
                -- conditions/actions are TOP-LEVEL arrays, which must be
                -- stringified: sql.json serializes a JS array as a Postgres
                -- array literal, not JSON (same trap as annotations.label_ids).
                ${JSON.stringify(input.conditions ?? [])},
                ${input.match ?? "all"}, ${JSON.stringify(input.actions)},
                ${nextRunAt}, ${actor})
              RETURNING *`
            const automation = toAutomation(rows[0]!)
            yield* events.append({
              subjectKind: "automation",
              subjectId: automation.id,
              eventType: "AutomationCreated",
              payload: {
                _tag: "AutomationCreated",
                name: automation.name,
                trigger: automation.trigger.kind,
              },
            })
            return automation
          }),
        )

      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly trigger?: AutomationTrigger
        readonly conditions?: ReadonlyArray<SidebarCondition>
        readonly match?: ConditionMatch
        readonly actions?: ReadonlyArray<AutomationAction>
        readonly enabled?: boolean
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const cur = yield* getById(input.id)
            const trigger = input.trigger ?? cur.trigger
            const actions = input.actions ?? cur.actions
            if (input.trigger !== undefined) yield* validateTrigger(trigger)
            if (input.actions !== undefined) yield* validateActions(actions)
            const name = input.name === undefined ? cur.name : input.name.trim() || cur.name
            const conditions = input.conditions ?? cur.conditions
            const match = input.match ?? cur.match
            const enabled = input.enabled ?? cur.enabled
            // Re-arm the schedule when it starts, when its cadence changes, or
            // when it has no due time yet; clear it when the automation stops or
            // stops being a schedule. Re-enabling also clears a self-pause —
            // otherwise the rate cap would latch it off forever.
            const scheduleChanged =
              input.trigger !== undefined && JSON.stringify(cur.trigger) !== JSON.stringify(trigger)
            const nextRunAt =
              trigger.kind === "schedule" && enabled
                ? scheduleChanged || cur.nextRunAt === null
                  ? nextRunAfter(trigger, new Date())
                  : cur.nextRunAt
                : null
            const pausedReason = enabled && !cur.enabled ? null : cur.pausedReason
            const rows = yield* sql<AutomationRow>`
              UPDATE automations SET
                name = ${name}, enabled = ${enabled},
                trigger = ${sql.json(trigger)},
                -- Top-level arrays: stringify (see the INSERT above).
                conditions = ${JSON.stringify(conditions)},
                match = ${match}, actions = ${JSON.stringify(actions)},
                next_run_at = ${nextRunAt}, paused_reason = ${pausedReason},
                updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id}
              RETURNING *`
            const automation = toAutomation(rows[0]!)
            // An enable/disable is worth its own event — it's the change people
            // actually audit ("who turned this on?").
            if (input.enabled !== undefined && input.enabled !== cur.enabled) {
              yield* events.append({
                subjectKind: "automation",
                subjectId: automation.id,
                eventType: input.enabled ? "AutomationEnabled" : "AutomationDisabled",
                payload: input.enabled
                  ? { _tag: "AutomationEnabled", name: automation.name }
                  : { _tag: "AutomationDisabled", name: automation.name, reason: null },
              })
            } else {
              yield* events.append({
                subjectKind: "automation",
                subjectId: automation.id,
                eventType: "AutomationUpdated",
                payload: {
                  _tag: "AutomationUpdated",
                  name: automation.name,
                  trigger: automation.trigger.kind,
                },
              })
            }
            return automation
          }),
        )

      /** Pause an automation from the RUNNER (rate cap tripped). Distinct from
       *  `update` so it needs no full document and records the reason. */
      const pause = (id: string, reason: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const rows = yield* sql<AutomationRow>`
              UPDATE automations
              SET enabled = false, paused_reason = ${reason}, next_run_at = NULL, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${id}
              RETURNING *`
            const row = rows[0]
            if (!row) return yield* Effect.fail(new AutomationNotFound({ automationId: id }))
            const automation = toAutomation(row)
            yield* events.append({
              subjectKind: "automation",
              subjectId: id,
              eventType: "AutomationDisabled",
              payload: { _tag: "AutomationDisabled", name: automation.name, reason },
            })
            return automation
          }),
        )

      const archive = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* getById(id)
            // Archiving also stops it: a paused-but-armed schedule would keep
            // claiming rows that no list shows.
            const rows = yield* sql<AutomationRow>`
              UPDATE automations
              SET archived_at = COALESCE(archived_at, now()), enabled = false, next_run_at = NULL
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "automation",
              subjectId: id,
              eventType: "AutomationArchived",
              payload: { _tag: "AutomationArchived" },
            })
            return toAutomation(rows[0]!)
          }),
        )

      const restore = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* getById(id)
            // Restores DISABLED (enabled stays false): silently resuming writes
            // on restore is exactly the surprise this feature must avoid.
            const rows = yield* sql<AutomationRow>`
              UPDATE automations SET archived_at = NULL
              WHERE org_id = ${orgId} AND id = ${id} RETURNING *`
            yield* events.append({
              subjectKind: "automation",
              subjectId: id,
              eventType: "AutomationRestored",
              payload: { _tag: "AutomationRestored" },
            })
            return toAutomation(rows[0]!)
          }),
        )

      /** Hard delete (runs cascade). The archive/delete convention's `purge`. */
      const remove = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const automation = yield* getById(id)
            // Append BEFORE the delete: the tombstone must outlive the row, and
            // the runs cascade away with it.
            yield* events.append({
              subjectKind: "automation",
              subjectId: id,
              eventType: "AutomationDeleted",
              payload: { _tag: "AutomationDeleted" },
            })
            yield* sql`DELETE FROM automations WHERE org_id = ${orgId} AND id = ${id}`
            return automation
          }),
        )

      // ── runs ─────────────────────────────────────────────────────────────────

      const listRuns = (automationId: string, opts: { readonly limit?: number } = {}) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const limit = Math.min(opts.limit ?? 20, 200)
          const rows = yield* sql<AutomationRunRow>`
            SELECT * FROM automation_runs
            WHERE org_id = ${orgId} AND automation_id = ${automationId}
            ORDER BY started_at DESC LIMIT ${limit}`
          return rows.map(toAutomationRun)
        }).pipe(Effect.orDie)

      /**
       * THE idempotency guard. Insert the run row *before* acting; a duplicate
       * delivery (two server instances, an SSE reconnect replay) loses the
       * `unique (automation_id, event_id)` race and gets `null` back, meaning
       * "someone else owns this event — stop".
       *
       * `ON CONFLICT DO NOTHING` makes losing the race a no-op rather than an
       * error, so the caller's control flow is a null check. Correctness does not
       * depend on there being exactly one process.
       */
      const claimRun = (input: {
        readonly automationId: string
        readonly eventId: number | null
        readonly subjectId: string | null
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          // The claim lands as `skipped` + reason "running": the row must exist
          // before any action runs (that IS the guard), but it has no outcome yet.
          // `finishRun` overwrites both. Naming the placeholder means a row left
          // behind by a hard kill reads as "started, never finished" instead of
          // masquerading as a deliberate skip with no reason.
          const rows = yield* sql<AutomationRunRow>`
            INSERT INTO automation_runs (org_id, automation_id, event_id, subject_id, status, detail)
            VALUES (${orgId}, ${input.automationId}, ${input.eventId}, ${input.subjectId}, 'skipped',
                    ${sql.json({ reason: "running" })})
            ON CONFLICT (automation_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
            RETURNING *`
          const row = rows[0]
          return row ? toAutomationRun(row) : null
        }).pipe(Effect.orDie)

      /** Close out a claimed run and bump the automation's counters. */
      const finishRun = (input: {
        readonly runId: string
        readonly automationId: string
        readonly status: AutomationRunStatus
        readonly detail: AutomationRunDetail
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* sql`
            UPDATE automation_runs
            SET status = ${input.status}, detail = ${sql.json(input.detail)}, finished_at = now()
            WHERE org_id = ${orgId} AND id = ${input.runId}`
          // A skip is not a run: counting it would make the rate cap fire on
          // events the automation deliberately ignored.
          if (input.status !== "skipped") {
            yield* sql`
              UPDATE automations SET run_count = run_count + 1, last_run_at = now()
              WHERE org_id = ${orgId} AND id = ${input.automationId}`
          }
        }).pipe(Effect.orDie)

      /** Runs started in the last minute (the rate-cap window). Counts real runs
       *  only — skips are excluded, matching `finishRun`. */
      const recentRunCount = (automationId: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly count: number | string }>`
            SELECT COUNT(*)::int AS count FROM automation_runs
            WHERE org_id = ${orgId} AND automation_id = ${automationId}
              AND status <> 'skipped' AND started_at > now() - interval '1 minute'`
          return Number(rows[0]?.count ?? 0)
        }).pipe(Effect.orDie)

      /** Append the `AutomationRan` marker onto the acted-on record's stream, so
       *  the record's own activity feed explains what happened to it. Rides the
       *  instance stream WITHOUT bumping `version` (like `ComputedBandChanged`). */
      const appendRanEvent = (input: {
        readonly automationId: string
        readonly name: string
        readonly subjectId: string | null
        readonly conceptId?: string | null
        readonly status: AutomationRunStatus
        readonly actions: ReadonlyArray<string>
      }) =>
        events.append({
          // With no record, the marker rides the automation's own stream.
          subjectKind: input.subjectId ? "instance" : "automation",
          subjectId: input.subjectId ?? input.automationId,
          eventType: "AutomationRan",
          payload: {
            _tag: "AutomationRan",
            automationId: input.automationId,
            name: input.name,
            status: input.status,
            actions: input.actions,
          },
          ...(input.conceptId ? { conceptId: input.conceptId } : {}),
        })

      /** Re-arm a schedule automation after a run (or clear it when it stopped). */
      const setNextRun = (id: string, next: Date | null) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* sql`
            UPDATE automations SET next_run_at = ${next}
            WHERE org_id = ${orgId} AND id = ${id}`
        }).pipe(Effect.orDie)

      return {
        list,
        getById,
        create,
        update,
        pause,
        archive,
        restore,
        remove,
        listRuns,
        claimRun,
        finishRun,
        recentRunCount,
        appendRanEvent,
        setNextRun,
      } as const
    }),
    dependencies: [EventStore.Default],
  },
) {}

export type { Automation, AutomationRun }
