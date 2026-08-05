import { PgClient } from "@effect/sql-pg"
import { Duration, Effect, Schedule } from "effect"
import {
  AnnotationService,
  AUTOMATION_ACTOR_PREFIX,
  type Automation,
  type AutomationAction,
  type AutomationActionOutcome,
  type AutomationRunDetail,
  type AutomationRunStatus,
  AutomationService,
  type AutomationTrigger,
  ConceptService,
  type EngineEvent,
  type EventEnvelope,
  FieldService,
  isAutomationActor,
  LABELS_KEY,
  nextRunAfter,
  OrgContext,
  QueryService,
  RATE_CAP_PER_MIN,
  RecordService,
  type RecordVersion,
} from "#engine"
import { matchRecordVersion } from "../src/lib/conditions"
import { publicConnectorError } from "./integrations/errors"
import { fetchGuardedJson, UnsafeUrlError } from "./integrations/url-guard"
import {
  closeLinearIssue,
  commentOnLinearIssue,
  createLinearIssue,
  linearConnectionForOrg,
  linearIssueIdForRecordVersion,
  linearUserIdForEmail,
  updateLinearIssue,
} from "./linear"
import { AppRuntime, actorScope, systemScope } from "./runtime"
import { addReactionForOrg, dmUserForOrg, postForOrg } from "./slack"
import { tap } from "./stream"

/**
 * The automation runner.
 *
 * An automation is a saved filter over the event log with a list of service calls
 * attached, so this file is deliberately thin: it MATCHES (which automations care
 * about this event), CLAIMS (the idempotency guard), EVALUATES (the shared
 * condition matcher), and then calls services that already exist. It owns no
 * validation (AutomationService) and no filter semantics (src/lib/conditions).
 *
 * Two entry points, both supervised and started from index.ts:
 *   - `startAutomationRunner` taps the same process-wide `LISTEN km_events`
 *     fan-out the SSE endpoint uses. Event triggers run here, AFTER the
 *     triggering transaction commits — so an automation can neither fail nor slow
 *     a user's save.
 *   - `startAutomationScheduleTick` claims due schedule rows atomically, modelled
 *     on `decay-tick.ts`.
 */

/** Which event types can start a run, per trigger kind. A trigger is a FILTER
 *  over the event log — this map is the whole of that filter's first stage. */
const TRIGGER_EVENTS: Record<string, ReadonlyArray<string>> = {
  "record.created": ["RecordVersionCreated"],
  // An amendment to a published version folds exactly like an update, so both
  // tags mean "the record changed" to an automation.
  "record.changed": ["RecordVersionUpdated", "VersionAmended"],
  "record.archived": ["RecordVersionArchived", "RecordVersionDeleted"],
  "version.published": ["VersionPublished"],
  "record.band.changed": ["ComputedBandChanged"],
  "task.created": ["TaskCreated"],
  "task.status.changed": ["TaskStatusChanged"],
}

/** Every event type any trigger can react to — the cheapest possible rejection,
 *  applied before touching the database at all. */
const ALL_TRIGGER_EVENTS = new Set(Object.values(TRIGGER_EVENTS).flat())

/** Actor for this automation's writes. Events carrying it never trigger another
 *  automation (the one-hop guard), so chains are impossible by construction. */
const actorFor = (automationId: string) => `${AUTOMATION_ACTOR_PREFIX}${automationId}`

// ── templates ──────────────────────────────────────────────────────────────────

export interface TemplateCtx {
  readonly record?: RecordVersion | null
  readonly title?: string | null
  readonly url?: string | null
  readonly actor?: string | null
  readonly now?: Date
  readonly from?: unknown
  readonly to?: unknown
  /** Field id → display value, for `{{field:<id>}}`. */
  readonly fields?: Record<string, unknown>
  /**
   * The last Slack message THIS run posted, for `{{slack.ts}}`/`{{slack.channel}}`.
   *
   * This is the only part of the context that changes as the run proceeds: it is
   * what lets "post a message, then reply in its thread / react to it" work with
   * no configuration. Empty until a Slack post succeeds, and an unresolved token
   * renders "" like every other — a reply with no preceding post degrades to a
   * top-level message rather than failing.
   */
  readonly slack?: { readonly ts?: string; readonly channel?: string }
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.:-]+)\s*\}\}/g

/**
 * Interpolate the closed token set. Substitution, NOT evaluation — there is no
 * expression language here, so there is nothing to sandbox.
 *
 * An unknown token renders empty rather than throwing: a typo in a Slack message
 * must not fail a run.
 */
export const renderTemplate = (input: string, ctx: TemplateCtx): string =>
  input.replace(TOKEN_RE, (_all, token: string) => {
    if (token.startsWith("field:")) {
      const id = token.slice("field:".length)
      const v = ctx.fields?.[id]
      return v == null ? "" : String(v)
    }
    switch (token) {
      case "record.title":
        return ctx.title ?? ""
      case "record.url":
        return ctx.url ?? ""
      case "actor":
        return ctx.actor ?? ""
      case "now":
        return (ctx.now ?? new Date()).toISOString()
      case "trigger.from":
        return ctx.from == null ? "" : String(ctx.from)
      case "trigger.to":
        return ctx.to == null ? "" : String(ctx.to)
      case "slack.ts":
        return ctx.slack?.ts ?? ""
      case "slack.channel":
        return ctx.slack?.channel ?? ""
      default:
        return ""
    }
  })

/** Interpolate every string in a value, recursively (action params are shallow
 *  JSON, so this covers `webhook.body` and `createRecord.fields`). */
const renderDeep = (v: unknown, ctx: TemplateCtx): unknown => {
  if (typeof v === "string") return renderTemplate(v, ctx)
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, ctx))
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, renderDeep(x, ctx)]),
    )
  }
  return v
}

// ── trigger matching ───────────────────────────────────────────────────────────

/**
 * Does this automation's trigger match this event? Pure, and exported for tests.
 *
 * Params narrow further than the event type: a `record.changed` may pin a field
 * id (only fires when that field is in the patch) and a `task.status.changed` may
 * pin a status. All by ID — never by name, so a rename can't break a rule.
 */
export const triggerMatches = (
  trigger: AutomationTrigger,
  event: {
    readonly type: string
    readonly conceptId?: string | null
    readonly payload?: Record<string, unknown>
  },
): boolean => {
  if (trigger.kind === "schedule") return false
  const types = TRIGGER_EVENTS[trigger.kind]
  if (!types?.includes(event.type)) return false
  if (trigger.conceptId && event.conceptId && trigger.conceptId !== event.conceptId) return false
  // A concept-scoped trigger must not fire on an event we couldn't attribute to a
  // concept — matching "any concept" there would be a silent over-fire.
  if (trigger.conceptId && !event.conceptId) return false
  const payload = event.payload ?? {}
  if (trigger.kind === "record.changed" && trigger.fieldId) {
    const patch = payload.patch
    if (!patch || typeof patch !== "object") return false
    if (!(trigger.fieldId in (patch as Record<string, unknown>))) return false
  }
  if (trigger.kind === "record.band.changed") {
    if (trigger.fieldId && payload.field !== trigger.fieldId) return false
    if (trigger.band && payload.to !== trigger.band) return false
  }
  if (trigger.kind === "task.status.changed" && trigger.statusId) {
    if (payload.to !== trigger.statusId) return false
  }
  return true
}

/**
 * What `{{trigger.from}}` / `{{trigger.to}}` resolve to for this event.
 *
 * Two shapes, because the event log has two. `ComputedBandChanged` and
 * `TaskStatusChanged` carry literal `from`/`to`. A record edit carries neither:
 * the new value sits in `patch` keyed by field id, and the old value exists only
 * in the replayed pre-state. Pure, and exported for tests.
 *
 * Which field the tokens describe: the trigger's pinned `fieldId` when it has
 * one, else the single changed key when the patch changed exactly one field
 * (unambiguous). With a multi-field patch and no pinned field there is no honest
 * answer, so both render empty rather than guessing.
 */
export const resolveTransition = (input: {
  readonly trigger: AutomationTrigger
  readonly payload: Record<string, unknown>
  readonly prevState: Record<string, unknown> | null
  readonly nextState: Record<string, unknown> | null
}): { readonly from: unknown; readonly to: unknown } => {
  const { trigger, payload, prevState, nextState } = input
  // Literal from/to (band + task-status events).
  if (payload.to !== undefined || payload.from !== undefined) {
    return { from: payload.from, to: payload.to }
  }
  const patch =
    payload.patch && typeof payload.patch === "object"
      ? (payload.patch as Record<string, unknown>)
      : null
  const keys = patch ? Object.keys(patch).filter((k) => !k.startsWith("__")) : []
  const fieldId = trigger.fieldId ?? (keys.length === 1 ? keys[0] : null)
  if (!fieldId) return { from: undefined, to: undefined }
  return {
    from: prevState?.[fieldId],
    // Prefer the folded state (it has been through field validation/coercion);
    // fall back to the raw patch value.
    to: nextState?.[fieldId] ?? patch?.[fieldId],
  }
}

// ── action execution ───────────────────────────────────────────────────────────

/** Which record version state a `setField`/label action should write to, plus the
 *  version to pass as the optimistic-concurrency check. */
interface ActOn {
  readonly recordVersion: RecordVersion
  readonly conceptId: string
}

/**
 * Turn an engine failure into a run-log note a human can act on.
 *
 * THE POINT: once an automation is a scoped actor, a write its role does not cover
 * fails as `RecordVersionNotFound` — the engine deliberately reports "not found" rather
 * than "forbidden" so a caller cannot probe for existence. That is right for a user
 * request and useless in a run log, where it is indistinguishable from "the record was
 * deleted mid-run".
 *
 * The subject was resolved moments earlier by the runner (which is unrestricted), so
 * if the record has gone missing BY THE TIME THIS AUTOMATION touches it, the cause is
 * this automation's own access. Saying so is what makes narrowing an automation's role
 * debuggable instead of mystifying — the artifact's "fails visibly in the run log".
 */
export const noteForFailure = (e: unknown, subject: ActOn | null): string => {
  const tag = (e as { _tag?: string })?._tag
  if (subject && (tag === "RecordVersionNotFound" || tag === "RecordNotFound"))
    return "forbidden: this automation's role does not cover that record"
  return String(tag ?? e)
}

/**
 * What one action hands back: the outcome that gets RECORDED, plus an optional
 * `chain` that does not.
 *
 * The split is deliberate. `AutomationActionOutcome` is persisted verbatim into
 * `automation_runs.detail` and rendered in the History tab, so it is an audit
 * record — a Slack message timestamp is transient plumbing for the next action in
 * the same run, not something worth storing forever. The loop strips `chain`
 * before pushing, which keeps the stored shape (and the RPC contract) unchanged.
 */
interface ActionRun extends AutomationActionOutcome {
  readonly chain?: { readonly ts?: string; readonly channel?: string }
}

/** One outcome shape every connector call converges on, so the cases below read
 *  the same whether they talked to Slack or Linear. */
interface CallResult {
  readonly ok: boolean
  readonly note: string
  readonly ts?: string
  readonly channel?: string
}

/**
 * Run a connector call, collapsing the error channel to `never` right here.
 *
 * Same shape as the `webhook` case rather than `notifySlack`'s: a rich
 * `{ok, note}` crosses the boundary instead of a bare boolean, so a failure can
 * say WHICH failure it was. The connector modules already map their own error
 * slugs, so anything reaching the `catchAll` is genuinely unexpected.
 */
const slackCall = (run: () => Promise<CallResult>) =>
  Effect.tryPromise({ try: run, catch: (e) => e }).pipe(
    Effect.catchAll(() => Effect.succeed({ ok: false, note: "Slack call failed" } as CallResult)),
  )

const chainOf = (r: CallResult) => (r.ts ? { ts: r.ts, channel: r.channel } : undefined)

/**
 * Resolve the Linear connection + the issue behind the triggering record.
 *
 * Every record-scoped Linear action starts here, and each `null` is a DIFFERENT
 * user-facing story: no connection, no record, or a record that simply isn't a
 * mirrored Linear ticket. Collapsing them would make the run log useless.
 */
const linearTarget = (orgId: string, subject: ActOn | null) =>
  Effect.tryPromise({
    try: async (): Promise<
      | {
          ok: true
          conn: NonNullable<Awaited<ReturnType<typeof linearConnectionForOrg>>>
          issueId: string
        }
      | { ok: false; note: string }
    > => {
      if (!subject) return { ok: false, note: "no record" }
      const conn = await linearConnectionForOrg(orgId)
      if (!conn) return { ok: false, note: "Linear not connected" }
      const issueId = await linearIssueIdForRecordVersion(conn, {
        conceptId: subject.conceptId,
        state: subject.recordVersion.state as Record<string, unknown>,
      })
      if (!issueId) return { ok: false, note: "not a Linear ticket" }
      return { ok: true, conn, issueId }
    },
    catch: (e) => e,
  }).pipe(
    Effect.catchAll(() => Effect.succeed({ ok: false as const, note: "Linear lookup failed" })),
  )

/** Map a thrown Linear error to a short note. A GraphQL error carries no HTTP
 *  status, so `publicConnectorError` would call every one of them "could not
 *  reach the provider" — which is never what actually happened. */
const linearNote = (e: unknown): string => {
  if ((e as { code?: string })?.code === "NO_COMPLETED_STATE") {
    return "that team has no completed state"
  }
  const raw = e instanceof Error ? e.message : String(e)
  const gql = /Linear GraphQL error: (.+)/.exec(raw)?.[1]
  if (gql) return gql.length > 80 ? `${gql.slice(0, 77)}…` : gql
  return publicConnectorError(e)
}

const linearCall = (run: () => Promise<CallResult>) =>
  Effect.tryPromise({ try: run, catch: (e) => e }).pipe(
    Effect.catchAll((e) => Effect.succeed({ ok: false, note: linearNote(e) } as CallResult)),
  )

const runAction = (
  action: AutomationAction,
  ctx: {
    readonly orgId: string
    readonly automationId: string
    readonly subject: ActOn | null
    readonly template: TemplateCtx
  },
): Effect.Effect<
  ActionRun,
  never,
  OrgContext | RecordService | AnnotationService | PgClient.PgClient
> =>
  Effect.gen(function* () {
    const recordVersions = yield* RecordService
    const annotations = yield* AnnotationService
    const subject = ctx.subject
    switch (action.kind) {
      case "setField": {
        if (!subject) return { kind: action.kind, ok: false, note: "no record" }
        const value = renderDeep(action.value, ctx.template)
        yield* recordVersions.update({
          recordVersionId: subject.recordVersion.id,
          expectedVersion: subject.recordVersion.version,
          patch: { [action.fieldId]: value },
        })
        return { kind: action.kind, ok: true, note: `set ${action.fieldId}` }
      }
      case "addLabel":
      case "removeLabel": {
        if (!subject) return { kind: action.kind, ok: false, note: "no record" }
        const current = Array.isArray(subject.recordVersion.state[LABELS_KEY])
          ? (subject.recordVersion.state[LABELS_KEY] as string[])
          : []
        const next =
          action.kind === "addLabel"
            ? current.includes(action.labelId)
              ? current
              : [...current, action.labelId]
            : current.filter((l) => l !== action.labelId)
        // Nothing to do — don't burn an event (or a version bump) on a no-op.
        if (next.length === current.length && action.kind === "addLabel") {
          return { kind: action.kind, ok: true, note: "already set" }
        }
        yield* recordVersions.update({
          recordVersionId: subject.recordVersion.id,
          expectedVersion: subject.recordVersion.version,
          patch: { [LABELS_KEY]: next },
        })
        return { kind: action.kind, ok: true }
      }
      case "createTask": {
        const title = renderTemplate(action.title, ctx.template)
        const dueAt =
          action.dueInDays == null
            ? null
            : new Date(Date.now() + action.dueInDays * 86_400_000).toISOString()
        // Tasks hang off the RECORD (they survive re-publishes), which is
        // why this is recordId and not the record version id.
        const onRecord = action.onRecord !== false
        const task = yield* annotations.createTask({
          subjectId: onRecord ? (subject?.recordVersion.recordId ?? null) : null,
          title: title || "Untitled task",
          statusId: action.statusId ?? null,
          priorityId: action.priorityId ?? null,
          labelIds: action.labelIds ?? [],
          assignee: action.assignee ?? null,
          dueAt,
        })
        return { kind: action.kind, ok: true, note: `task "${task.title}"` }
      }
      case "createRecord": {
        const fields = renderDeep(action.fields ?? {}, ctx.template) as Record<string, unknown>
        const created = yield* recordVersions.create({ conceptId: action.conceptId, fields })
        return { kind: action.kind, ok: true, note: `record ${created.id.slice(0, 8)}` }
      }
      case "archiveRecord": {
        if (!subject) return { kind: action.kind, ok: false, note: "no record" }
        yield* recordVersions.archive({
          recordVersionId: subject.recordVersion.id,
          expectedVersion: subject.recordVersion.version,
        })
        return { kind: action.kind, ok: true }
      }
      case "notifySlack": {
        const text = renderTemplate(action.text, ctx.template)
        const channel = renderTemplate(action.channel, ctx.template)
        // Slack lives outside Effect (plain async), and a missing connection is a
        // recorded outcome rather than a run failure. Goes through `postForOrg`
        // (not the older `postMessageForOrg`) for two reasons: it distinguishes
        // "not connected" from "post failed", and it returns the message ts that
        // a later thread-reply or reaction in this run chains off.
        const res = yield* slackCall(() => postForOrg(ctx.orgId, { channel, text }))
        return { kind: action.kind, ok: res.ok, note: res.note, chain: chainOf(res) }
      }
      case "webhook": {
        const url = renderTemplate(action.url, ctx.template)
        const extra = renderDeep(action.body ?? {}, ctx.template) as Record<string, unknown>
        const payload = {
          automationId: ctx.automationId,
          recordId: subject?.recordVersion.id ?? null,
          conceptId: subject?.conceptId ?? null,
          at: new Date().toISOString(),
          ...extra,
        }
        // SSRF guard at SEND time, not just at save time: `url` above is
        // template-interpolated, so record data can steer it, and DNS can change
        // between saving the rule and running it. `fetchGuardedJson` re-resolves
        // and refuses non-public addresses (and won't follow redirects into one).
        const outcome = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetchGuardedJson(url, payload)
            // A manual-redirect response is opaque (status 0) — treat any 3xx as
            // undelivered rather than silently "posted".
            if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
              return { ok: false, note: "endpoint redirected (not followed)" }
            }
            return { ok: res.ok, note: res.ok ? "posted" : `endpoint returned ${res.status}` }
          },
          catch: (e) => e,
        }).pipe(
          Effect.catchAll((e) =>
            Effect.succeed(
              e instanceof UnsafeUrlError
                ? { ok: false, note: `blocked: ${e.reason}` }
                : { ok: false, note: "request failed" },
            ),
          ),
        )
        return { kind: action.kind, ok: outcome.ok, note: outcome.note }
      }

      // ── Slack ────────────────────────────────────────────────────────────
      case "slack.postThreadReply": {
        const threadTs = renderTemplate(action.threadTs, ctx.template)
        // Blank channel falls back to the chained one, so the common rule
        // ("reply to what I just posted") needs no channel configured at all.
        const channel =
          renderTemplate(action.channel, ctx.template) || (ctx.template.slack?.channel ?? "")
        if (!threadTs) {
          return { kind: action.kind, ok: false, note: "no message to reply to" }
        }
        if (!channel) return { kind: action.kind, ok: false, note: "no channel" }
        const res = yield* slackCall(() =>
          postForOrg(ctx.orgId, {
            channel,
            text: renderTemplate(action.text, ctx.template),
            threadTs,
          }),
        )
        // Deliberately does NOT re-chain: the thread parent stays the anchor, so
        // two replies in a row both attach to the original post rather than
        // nesting off each other.
        return { kind: action.kind, ok: res.ok, note: res.note }
      }
      case "slack.postBlocks": {
        const channel = renderTemplate(action.channel, ctx.template)
        // Interpolate INSIDE the parsed JSON, not over the raw string: rendering
        // first would let a value containing a quote break the document.
        const parsed = ((): unknown[] | null => {
          try {
            const v = JSON.parse(action.blocks)
            return Array.isArray(v) ? v : null
          } catch {
            return null
          }
        })()
        if (!parsed) return { kind: action.kind, ok: false, note: "blocks are not valid JSON" }
        const blocks = renderDeep(parsed, ctx.template) as unknown[]
        const res = yield* slackCall(() =>
          postForOrg(ctx.orgId, {
            channel,
            text: renderTemplate(action.text, ctx.template),
            blocks,
          }),
        )
        return { kind: action.kind, ok: res.ok, note: res.note, chain: chainOf(res) }
      }
      case "slack.dmUser": {
        const res = yield* slackCall(() =>
          dmUserForOrg(ctx.orgId, {
            slackUserId: renderTemplate(action.slackUserId, ctx.template),
            text: renderTemplate(action.text, ctx.template),
          }),
        )
        return { kind: action.kind, ok: res.ok, note: res.note, chain: chainOf(res) }
      }
      case "slack.addReaction": {
        const ts = renderTemplate(action.ts, ctx.template)
        const channel =
          renderTemplate(action.channel, ctx.template) || (ctx.template.slack?.channel ?? "")
        if (!ts) return { kind: action.kind, ok: false, note: "no message to react to" }
        if (!channel) return { kind: action.kind, ok: false, note: "no channel" }
        const res = yield* slackCall(() =>
          addReactionForOrg(ctx.orgId, {
            channel,
            ts,
            name: renderTemplate(action.name, ctx.template),
          }),
        )
        return { kind: action.kind, ok: res.ok, note: res.note }
      }

      // ── Linear ───────────────────────────────────────────────────────────
      case "linear.updateIssue": {
        const target = yield* linearTarget(ctx.orgId, subject)
        if (!target.ok) return { kind: action.kind, ok: false, note: target.note }
        const input = renderDeep(action.input ?? {}, ctx.template) as Record<string, unknown>
        if (Object.keys(input).length === 0) {
          return { kind: action.kind, ok: false, note: "nothing to update" }
        }
        const res = yield* linearCall(async () => {
          const issue = await updateLinearIssue(target.conn, target.issueId, input)
          // `issueUpdate` reports success separately from the node; a null issue
          // means Linear declined the change rather than erroring.
          return issue
            ? { ok: true, note: `updated ${issue.identifier ?? target.issueId}` }
            : { ok: false, note: "Linear declined the update" }
        })
        return { kind: action.kind, ok: res.ok, note: res.note }
      }
      case "linear.closeIssue": {
        const target = yield* linearTarget(ctx.orgId, subject)
        if (!target.ok) return { kind: action.kind, ok: false, note: target.note }
        const res = yield* linearCall(async () => {
          const issue = await closeLinearIssue(target.conn, target.issueId)
          return issue
            ? { ok: true, note: `closed ${issue.identifier ?? target.issueId}` }
            : { ok: false, note: "Linear declined the close" }
        })
        return { kind: action.kind, ok: res.ok, note: res.note }
      }
      case "linear.comment": {
        const target = yield* linearTarget(ctx.orgId, subject)
        if (!target.ok) return { kind: action.kind, ok: false, note: target.note }
        const body = renderTemplate(action.body, ctx.template)
        if (!body.trim()) return { kind: action.kind, ok: false, note: "empty comment" }
        const res = yield* linearCall(async () => {
          const comment = await commentOnLinearIssue(target.conn, target.issueId, body)
          return comment
            ? { ok: true, note: "commented" }
            : { ok: false, note: "Linear declined the comment" }
        })
        return { kind: action.kind, ok: res.ok, note: res.note }
      }
      case "linear.assign": {
        const target = yield* linearTarget(ctx.orgId, subject)
        if (!target.ok) return { kind: action.kind, ok: false, note: target.note }
        const email = renderTemplate(action.email, ctx.template).trim()
        if (!email) return { kind: action.kind, ok: false, note: "no email to assign to" }
        const res = yield* linearCall(async () => {
          // Resolved per run, not from a mapping table — but KM and Linear
          // addresses genuinely differ for some people, so a miss is expected
          // and must name the address that failed.
          const assigneeId = await linearUserIdForEmail(target.conn, email)
          if (!assigneeId) return { ok: false, note: `no Linear user for ${email}` }
          const issue = await updateLinearIssue(target.conn, target.issueId, { assigneeId })
          return issue
            ? { ok: true, note: `assigned to ${email}` }
            : { ok: false, note: "Linear declined the assignment" }
        })
        return { kind: action.kind, ok: res.ok, note: res.note }
      }
      case "linear.createIssue": {
        // The one Linear action needing no subject — it creates rather than edits.
        const res = yield* linearCall(async () => {
          const conn = await linearConnectionForOrg(ctx.orgId)
          if (!conn) return { ok: false, note: "Linear not connected" }
          const title = renderTemplate(action.title, ctx.template)
          if (!title.trim()) return { ok: false, note: "empty title" }
          const issue = await createLinearIssue(conn, {
            teamId: action.teamId,
            title,
            ...(action.description
              ? { description: renderTemplate(action.description, ctx.template) }
              : {}),
          })
          return issue
            ? { ok: true, note: `created ${issue.identifier ?? "issue"}` }
            : { ok: false, note: "Linear declined the create" }
        })
        return { kind: action.kind, ok: res.ok, note: res.note }
      }
      default:
        // A kind this build doesn't know (a row written by a newer client).
        // Forward compatibility: skip it, don't fail the whole run.
        return {
          kind: (action as AutomationAction).kind,
          ok: false,
          note: "unsupported action",
        }
    }
  }).pipe(
    // A typed engine failure (validation, version conflict, managed-concept
    // guard) becomes this action's outcome — the run then stops at this step.
    Effect.catchAll((e) =>
      Effect.succeed({
        kind: action.kind,
        ok: false,
        note: noteForFailure(e, ctx.subject),
      } satisfies AutomationActionOutcome),
    ),
  )

// ── one run ────────────────────────────────────────────────────────────────────

/**
 * Execute one automation against one subject. Assumes the caller already claimed
 * the run (so this is the only worker on it) and already checked the trigger.
 *
 * Returns the run's status + detail; appends `AutomationRan` so the acted-on
 * record's own activity feed explains what happened to it.
 */
const executeRun = (input: {
  readonly automation: Automation
  readonly runId: string
  readonly subject: ActOn | null
  readonly prevState: Record<string, unknown> | null
  readonly triggerFrom?: unknown
  readonly triggerTo?: unknown
}) =>
  Effect.gen(function* () {
    const { automation, subject } = input
    const automations = yield* AutomationService
    const concepts = yield* ConceptService
    const fields = yield* FieldService

    // Conditions evaluate against the AFTER state, with the before-state supplied
    // for the transition ops. No subject (a schedule with no match, or an event we
    // couldn't resolve) and a non-empty condition set = skip.
    if (subject) {
      const matched = matchRecordVersion(subject.recordVersion, automation.conditions, {
        match: automation.match,
        prev: input.prevState,
      })
      if (!matched) {
        const detail: AutomationRunDetail = { reason: "conditions" }
        yield* automations.finishRun({
          runId: input.runId,
          automationId: automation.id,
          status: "skipped",
          detail,
        })
        return "skipped" as AutomationRunStatus
      }
    } else if (automation.conditions.length > 0) {
      const detail: AutomationRunDetail = { reason: "no-subject" }
      yield* automations.finishRun({
        runId: input.runId,
        automationId: automation.id,
        status: "skipped",
        detail,
      })
      return "skipped" as AutomationRunStatus
    }

    // Build the template context once. Field display values are keyed by field id
    // (names are decorative and renameable).
    let title: string | null = null
    const fieldValues: Record<string, unknown> = {}
    if (subject) {
      const concept = yield* concepts
        .getById(subject.conceptId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      const defs = yield* fields
        .listFields(subject.conceptId)
        .pipe(Effect.catchAll(() => Effect.succeed([])))
      for (const f of defs) {
        const v = subject.recordVersion.state[f.id]
        if (v != null) fieldValues[f.id] = v
      }
      const titleFieldId = concept?.titleFieldId ?? null
      if (titleFieldId) {
        const v = subject.recordVersion.state[titleFieldId]
        title = v == null ? null : String(v)
      }
      if (!title) {
        // Fall back to the first non-empty text-ish value, then the id — mirrors
        // the client's instanceLabel fallback closely enough for a message.
        const first = defs.find((f) => subject.recordVersion.state[f.id] != null)
        title = first
          ? String(subject.recordVersion.state[first.id])
          : subject.recordVersion.id.slice(0, 8)
      }
    }
    const template: TemplateCtx = {
      record: subject?.recordVersion ?? null,
      title,
      url: subject ? `/records/${subject.recordVersion.id}` : null,
      actor: actorFor(automation.id),
      now: new Date(),
      from: input.triggerFrom,
      to: input.triggerTo,
      fields: fieldValues,
    }

    // Run the actions in order. The first failure stops the run and records which
    // step failed — a later action may well depend on an earlier one.
    const outcomes: AutomationActionOutcome[] = []
    let failedAt: number | null = null
    // The one piece of context that accumulates DURING the run: the last Slack
    // message posted, so a later action can thread off it or react to it. Carried
    // beside the template rather than inside it because `TemplateCtx` is readonly
    // and shared — each iteration gets a fresh view instead of a mutated object.
    let slackChain: { ts?: string; channel?: string } | undefined
    for (const [i, action] of automation.actions.entries()) {
      const { chain, ...outcome } = yield* runAction(action, {
        orgId: automation.orgId,
        automationId: automation.id,
        subject,
        template: slackChain ? { ...template, slack: slackChain } : template,
      })
      // Only a SUCCESSFUL post updates the chain: reacting to the message that
      // just failed to send is worse than rendering an empty token.
      if (outcome.ok && chain?.ts) slackChain = { ts: chain.ts, channel: chain.channel }
      outcomes.push(outcome)
      if (!outcome.ok) {
        failedAt = i
        break
      }
    }

    const status: AutomationRunStatus = failedAt === null ? "ok" : "failed"
    const detail: AutomationRunDetail = {
      actions: outcomes,
      ...(failedAt === null
        ? {}
        : { failedAt, error: outcomes[failedAt]?.note ?? "action failed" }),
    }
    yield* automations.finishRun({
      runId: input.runId,
      automationId: automation.id,
      status,
      detail,
    })
    // The trace: the record's activity feed must explain itself.
    yield* automations
      .appendRanEvent({
        automationId: automation.id,
        name: automation.name,
        subjectId: subject?.recordVersion.id ?? null,
        conceptId: subject?.conceptId ?? null,
        status,
        actions: outcomes.map((o) => `${o.kind}${o.note ? `: ${o.note}` : ""}`),
      })
      .pipe(Effect.catchAllCause(() => Effect.void))
    return status
  })

/** Enforce the rate cap: past the threshold the automation pauses ITSELF, so a
 *  runaway costs a bounded number of writes plus one visible row. */
const overRateCap = (automation: Automation) =>
  Effect.gen(function* () {
    const automations = yield* AutomationService
    const recent = yield* automations.recentRunCount(automation.id)
    if (recent < RATE_CAP_PER_MIN) return false
    yield* automations.pause(automation.id, "rate-cap").pipe(Effect.catchAll(() => Effect.void))
    return true
  })

// ── event-triggered runs ───────────────────────────────────────────────────────

/**
 * Handle one delivered envelope. Ordered cheapest-check-first: event type, then
 * the one-hop guard, then a single indexed query for candidate automations.
 */
export const handleEnvelope = (env: EventEnvelope) =>
  Effect.gen(function* () {
    // 1. Could ANY trigger care about this event type? Pure set lookup.
    if (!ALL_TRIGGER_EVENTS.has(env.type)) return
    // 2. The one-hop guard: an automation's own writes never trigger another.
    //    This is why the envelope carries `actor`.
    if (isAutomationActor(env.actor)) return

    const sql = yield* PgClient.PgClient
    const automations = yield* AutomationService

    // 3. Enabled automations for this org (indexed), then match in memory — the
    //    trigger vocabulary is small and the JSON shape varies by kind.
    const candidates = (yield* automations.list()).filter((a) => a.enabled && !a.archivedAt)
    if (candidates.length === 0) return

    // The payload is only needed once a candidate exists, so it's fetched lazily.
    const rows = yield* sql<{
      readonly payload: Record<string, unknown>
      readonly actor: string | null
    }>`SELECT payload, actor FROM events WHERE id = ${env.id} AND org_id = ${env.org} LIMIT 1`
    const payload = rows[0]?.payload ?? {}

    const matching = candidates.filter((a) =>
      triggerMatches(a.trigger, { type: env.type, conceptId: env.conceptId, payload }),
    )
    if (matching.length === 0) return

    for (const automation of matching) {
      // 4. Claim the run BEFORE acting. A duplicate delivery loses this race.
      const run = yield* automations.claimRun({
        automationId: automation.id,
        eventId: env.id,
        subjectId: env.kind === "recordVersion" ? env.subjectId : null,
      })
      if (!run) continue

      if (yield* overRateCap(automation)) {
        yield* automations.finishRun({
          runId: run.id,
          automationId: automation.id,
          status: "skipped",
          detail: { reason: "rate-cap" },
        })
        continue
      }

      // 5. Resolve the subject + its BEFORE state. The previous state is not
      //    stored, but `getAsOf(id, eventId - 1)` replays the stream to just
      //    before this event — event ids are monotonic, so that is exactly
      //    "everything prior".
      const resolved = yield* resolveSubject(env).pipe(Effect.catchAll(() => Effect.succeed(null)))
      // `{{trigger.from}}` / `{{trigger.to}}` — where they come from depends on the
      // event. `ComputedBandChanged`/`TaskStatusChanged` carry literal from/to in
      // the payload. A record edit does NOT: the new value is in `patch` (keyed by
      // field id) and the old one only exists in the replayed pre-state. Resolving
      // that here is what makes the tokens mean the same thing on every trigger.
      const { from: triggerFrom, to: triggerTo } = resolveTransition({
        trigger: automation.trigger,
        payload,
        prevState: resolved?.prevState ?? null,
        nextState: resolved?.subject.recordVersion.state ?? null,
      })
      yield* executeRun({
        automation,
        runId: run.id,
        subject: resolved?.subject ?? null,
        prevState: resolved?.prevState ?? null,
        triggerFrom,
        triggerTo,
      }).pipe(
        // Every write this run makes is attributed to THIS automation, so the
        // one-hop guard fires and the activity trail names the culprit.
        //
        // `actorScope`, NOT `systemScope`: an automation is an actor with its own
        // role, so it is governed by the access model rather than exempt from it. It
        // behaves the same whoever tripped it, and can be scoped down per automation.
        Effect.provideServiceEffect(
          OrgContext,
          Effect.promise(() => actorScope(env.org, actorFor(automation.id))),
        ),
        Effect.catchAllCause((cause) =>
          // A crash mid-run must still close the row, or the automation would
          // look permanently "running" and the event could never be retried.
          Effect.gen(function* () {
            yield* Effect.logError("automation run crashed", cause)
            yield* automations
              .finishRun({
                runId: run.id,
                automationId: automation.id,
                status: "failed",
                detail: { error: "internal error" },
              })
              .pipe(Effect.catchAllCause(() => Effect.void))
          }),
        ),
      )
    }
  })

/** Load the acted-on record and its pre-event state (for the transition ops). */
const resolveSubject = (env: EventEnvelope) =>
  Effect.gen(function* () {
    if (env.kind !== "recordVersion") return null
    const recordVersions = yield* RecordService
    const recordVersion = yield* recordVersions.get(env.subjectId)
    const prev = yield* recordVersions
      .getAsOf(env.subjectId, env.id - 1)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    return {
      subject: { recordVersion, conceptId: recordVersion.conceptId } satisfies ActOn,
      prevState: prev?.state ?? null,
    }
  })

let runnerStarted = false

/**
 * Start the event-triggered runner (idempotent). Taps the in-process hub, so it
 * needs no second LISTEN — the same envelope that drives SSE drives automations.
 *
 * The tap handler must not block the hub (it fans out to SSE clients on the same
 * call), so each envelope is forked onto the runtime and handled independently.
 * A failure in one run never affects another envelope.
 */
export const startAutomationRunner = (): void => {
  if (runnerStarted) return
  runnerStarted = true
  tap((env) => {
    AppRuntime.runFork(
      handleEnvelope(env).pipe(
        // The runner acts as the automation itself; OrgContext's actor is
        // overridden per-automation inside the run, but the org must be the
        // event's own org — this is the isolation boundary for automations.
        //
        // DELIBERATELY still `systemScope`, unlike the per-run scopes below. This
        // outer pass resolves the triggering record and matches triggers BEFORE it
        // knows which automations apply, so it cannot use any one automation's policy.
        //
        // What that means, stated plainly: an automation's CONDITIONS are evaluated
        // against the full record, so scoping an automation limits what it WRITES, not
        // what it can branch on. That is not an escalation — creating or editing an
        // automation needs `configure`, and a caller with `configure` can read the
        // record anyway. Narrowing is about blast radius, not secrecy.
        Effect.provideService(OrgContext, systemScope(env.org, AUTOMATION_ACTOR_PREFIX)),
        Effect.tapErrorCause((cause) => Effect.logError("automation runner error", cause)),
        Effect.catchAllCause(() => Effect.void),
      ),
    )
  })
}

// ── schedule-triggered runs ────────────────────────────────────────────────────

/**
 * Claim every due schedule automation and run it. Modelled on `decay-tick.ts`.
 *
 * The claim is a single atomic `UPDATE … WHERE next_run_at <= now() RETURNING`,
 * so two server record versions can never both take the same row: whoever's UPDATE
 * lands first owns it, and the other sees no rows.
 */
const scheduleTickOnce = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  // Claim across all orgs in one statement, re-arming each row as we take it.
  const due = yield* sql<{
    readonly id: string
    readonly org_id: string
    readonly trigger: AutomationTrigger
  }>`
    UPDATE automations SET next_run_at = NULL
    WHERE id IN (
      SELECT id FROM automations
      WHERE enabled = true AND archived_at IS NULL
        AND next_run_at IS NOT NULL AND next_run_at <= now()
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, trigger`
  for (const row of due) {
    yield* runScheduled(row.org_id, row.id).pipe(
      Effect.catchAllCause((cause) => Effect.logError("scheduled automation failed", cause)),
    )
  }
})

/** Run one scheduled automation over every record matching its conditions —
 *  the schedule trigger IS the loop, which is why automations need no loop
 *  construct. Then re-arm it for its next occurrence. */
const runScheduled = (orgId: string, automationId: string) =>
  Effect.gen(function* () {
    const automations = yield* AutomationService
    const query = yield* QueryService
    const automation = yield* automations.getById(automationId)
    // Re-arm FIRST, from now, so a long run can't double-fire and a crash mid-run
    // still leaves the automation scheduled.
    const next = nextRunAfter(automation.trigger, new Date())
    yield* automations.setNextRun(automationId, next)

    if (yield* overRateCap(automation)) return

    const conceptId = automation.trigger.conceptId
    // With no concept the rule has no population to sweep; run it once with no
    // subject so a "notify me weekly" automation still works.
    const rows = conceptId
      ? yield* query.findRecords({ conceptId, limit: 1000 })
      : ([] as ReadonlyArray<RecordVersion>)

    if (!conceptId) {
      const run = yield* automations.claimRun({ automationId, eventId: null, subjectId: null })
      if (!run) return
      yield* executeRun({ automation, runId: run.id, subject: null, prevState: null })
      return
    }

    for (const recordVersion of rows) {
      // A scheduled run has no "before" state — transition ops can't hold, which
      // is correct: nothing changed, the clock merely advanced.
      const matched = matchRecordVersion(recordVersion, automation.conditions, {
        match: automation.match,
        prev: null,
      })
      if (!matched) continue
      const run = yield* automations.claimRun({
        automationId,
        eventId: null,
        subjectId: recordVersion.id,
      })
      if (!run) continue
      yield* executeRun({
        automation,
        runId: run.id,
        subject: { recordVersion, conceptId: recordVersion.conceptId },
        prevState: null,
      }).pipe(Effect.catchAllCause(() => Effect.void))
    }
  }).pipe(
    // Same attribution AND the same governance as the event path.
    Effect.provideServiceEffect(
      OrgContext,
      Effect.promise(() => actorScope(orgId, actorFor(automationId))),
    ),
  )

let tickStarted = false

/** Start the periodic schedule tick (idempotent). Called from index.ts. */
export const startAutomationScheduleTick = (): void => {
  if (tickStarted) return
  tickStarted = true
  const intervalMs = Number(process.env.AUTOMATION_TICK_INTERVAL_MS ?? 60_000)
  AppRuntime.runFork(
    scheduleTickOnce.pipe(
      Effect.tapErrorCause((cause) => Effect.logError("automation schedule tick error", cause)),
      Effect.catchAllCause(() => Effect.void),
      Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
    ),
  )
}

/** Exported for the "Test" button: evaluate an automation against recent records
 *  and report what WOULD happen, writing nothing. */
export const dryRun = (input: { readonly automation: Automation; readonly limit?: number }) =>
  Effect.gen(function* () {
    const query = yield* QueryService
    const { automation } = input
    const conceptId = automation.trigger.conceptId
    if (!conceptId) {
      return {
        matched: 0,
        scanned: 0,
        samples: [] as ReadonlyArray<{ readonly id: string; readonly label: string }>,
        note: "This automation is not scoped to a concept, so there is nothing to preview.",
      }
    }
    const rows = yield* query.findRecords({ conceptId, limit: input.limit ?? 100 })
    // Transition ops need a before-state that a dry run doesn't have, so they
    // can't hold here. Say so rather than silently reporting 0 matches.
    const hasTransitionOp = automation.conditions.some(
      (c) => c.op === "changedTo" || c.op === "changedFrom",
    )
    const matches = rows.filter((r) =>
      matchRecordVersion(r, automation.conditions, { match: automation.match, prev: null }),
    )
    return {
      matched: matches.length,
      scanned: rows.length,
      samples: matches.slice(0, 20).map((m) => ({
        id: m.id,
        label: String(
          Object.values(m.state).find((v) => typeof v === "string" && v) ?? m.id.slice(0, 8),
        ),
      })),
      note: hasTransitionOp
        ? "Conditions include a transition (changed to / from), which only holds on a real change — a preview can't evaluate it, so matches shown here ignore those conditions."
        : null,
    }
  })

export type { EngineEvent }
