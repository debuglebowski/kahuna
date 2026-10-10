import { Duration, Effect, Schedule } from "effect"
import type { Pool } from "pg"
import { pool } from "./db"
import { AppRuntime } from "./runtime"

/**
 * Retention purge for integration audit logs and mirror data. Single in-process
 * scheduler modelled on `decay-tick.ts`: one replica, no locking — a second
 * replica would only repeat idempotent deletes.
 *
 * What it never touches: `events`, `records`, `record_versions`, `annotations`,
 * `automation_runs`. Those are the source of truth and history (and feed live
 * sync + automations). See docs/data-retention.md for the periods and why.
 *
 * Every period is in days; 0 disables that rule.
 */

export interface RetentionConfig {
  /** Integration audit logs, by `created_at`. */
  auditDays: number
  /** Gmail threads/messages with no `google_object_link`, by message date. */
  gmailUnlinkedDays: number
  /** Rows whose source deleted them (`deleted_at`). */
  deletedUpstreamDays: number
  /** Mirror data of connections disconnected this long ago. */
  disconnectedDays: number
  /** Inbound webhook / notification dedupe rows, by receipt. */
  dedupeDays: number
  /** Finished Clay jobs, by `pushed_at`. */
  clayJobDays: number
}

const DEFAULTS: RetentionConfig = {
  auditDays: 365,
  gmailUnlinkedDays: 30,
  deletedUpstreamDays: 30,
  disconnectedDays: 30,
  dedupeDays: 30,
  clayJobDays: 90,
}

const ENV_KEYS: Record<keyof RetentionConfig, string> = {
  auditDays: "RETENTION_AUDIT_DAYS",
  gmailUnlinkedDays: "RETENTION_GMAIL_UNLINKED_DAYS",
  deletedUpstreamDays: "RETENTION_DELETED_UPSTREAM_DAYS",
  disconnectedDays: "RETENTION_DISCONNECTED_DAYS",
  dedupeDays: "RETENTION_DEDUPE_DAYS",
  clayJobDays: "RETENTION_CLAY_JOB_DAYS",
}

/** Unset or unparseable → the default; `0` → disabled. */
export const retentionConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): RetentionConfig => {
  const out = { ...DEFAULTS }
  for (const key of Object.keys(ENV_KEYS) as (keyof RetentionConfig)[]) {
    const raw = env[ENV_KEYS[key]]?.trim()
    if (!raw) continue
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n)
  }
  return out
}

interface Rule {
  name: string
  days: number
  table: string
  /** WHERE over the table aliased `x`; `$1` is the cutoff timestamp. */
  where: string
}

const AUDIT_TABLES = [
  "google_audit_log",
  "posthog_audit_log",
  "linear_audit_log",
  "slack_audit_log",
  "apollo_audit_log",
  "clay_audit_log",
]

/** Mirror tables → the connection table that owns them. */
const MIRRORS: [table: string, connection: string][] = [
  ["google_calendar_event", "google_connection"],
  ["google_gmail_thread", "google_connection"],
  ["google_gmail_message", "google_connection"],
  // Sync cursors go with the rows they describe, so a reconnect does a full
  // sync instead of an incremental one against data that is no longer there.
  ["google_calendar_sync", "google_connection"],
  ["google_gmail_sync", "google_connection"],
  ["linear_issue", "linear_connection"],
  ["posthog_person_metric", "posthog_connection"],
  ["clay_job", "clay_connection"],
]

/** A Gmail thread is linked to a record by `google_object_link` (kind `gmail_thread`). */
const threadLinked = (orgCol: string, userCol: string, threadCol: string) =>
  `EXISTS (SELECT 1 FROM google_object_link l
     WHERE l.org_id = ${orgCol} AND l.user_id = ${userCol}
       AND l.provider_kind = 'gmail_thread' AND l.provider_id = ${threadCol})`

const buildRules = (cfg: RetentionConfig): Rule[] => [
  ...AUDIT_TABLES.map((table) => ({
    name: "audit",
    days: cfg.auditDays,
    table,
    where: "x.created_at < $1",
  })),
  // Messages first: they are kept while their thread is recent or linked.
  {
    name: "gmail-unlinked",
    days: cfg.gmailUnlinkedDays,
    table: "google_gmail_message",
    where: `coalesce(x.sent_at, x.synced_at) < $1
      AND NOT ${threadLinked("x.org_id", "x.user_id", "x.thread_id")}
      AND NOT EXISTS (SELECT 1 FROM google_gmail_thread t
        WHERE t.connection_id = x.connection_id AND t.thread_id = x.thread_id
          AND coalesce(t.last_message_at, t.synced_at) >= $1)`,
  },
  {
    name: "gmail-unlinked",
    days: cfg.gmailUnlinkedDays,
    table: "google_gmail_thread",
    where: `coalesce(x.last_message_at, x.synced_at) < $1
      AND NOT ${threadLinked("x.org_id", "x.user_id", "x.thread_id")}`,
  },
  ...["google_calendar_event", "google_gmail_thread", "google_gmail_message"].map((table) => ({
    name: "deleted-upstream",
    days: cfg.deletedUpstreamDays,
    table,
    where: "x.deleted_at < $1",
  })),
  ...MIRRORS.map(([table, connection]) => ({
    name: "disconnected",
    days: cfg.disconnectedDays,
    table,
    where: `x.connection_id IN (SELECT id FROM ${connection}
      WHERE status = 'disconnected' AND disconnected_at < $1)`,
  })),
  ...["posthog_webhook_event", "linear_webhook_event", "slack_event", "clay_notification"].map(
    (table) => ({
      name: "dedupe",
      days: cfg.dedupeDays,
      table,
      where: "x.received_at < $1",
    }),
  ),
  {
    name: "dedupe",
    days: cfg.dedupeDays,
    table: "google_notification",
    where: "x.created_at < $1 AND x.expires_at < now()",
  },
  {
    name: "clay-job",
    days: cfg.clayJobDays,
    table: "clay_job",
    where: "x.status <> 'pending' AND x.pushed_at < $1",
  },
]

const BATCH = 1000
const DAY_MS = 86_400_000

/** Delete expired rows in batches so a first run on a large table can't hold one huge lock. */
const purgeRule = async (db: Pool, rule: Rule, now: Date): Promise<number> => {
  const cutoff = new Date(now.getTime() - rule.days * DAY_MS)
  const sql = `DELETE FROM ${rule.table} WHERE ctid IN (
    SELECT x.ctid FROM ${rule.table} x WHERE ${rule.where} LIMIT $2)`
  let total = 0
  for (;;) {
    const res = await db.query(sql, [cutoff, BATCH])
    const n = res.rowCount ?? 0
    total += n
    if (n < BATCH) return total
  }
}

export interface RetentionResult {
  /** `<rule>:<table>` → rows deleted (only rules that ran). */
  deleted: Record<string, number>
  /** `<rule>:<table>` → error message. One failing rule doesn't stop the others. */
  errors: Record<string, string>
}

export const runRetention = async (
  db: Pool,
  cfg: RetentionConfig,
  now: Date = new Date(),
): Promise<RetentionResult> => {
  const result: RetentionResult = { deleted: {}, errors: {} }
  for (const rule of buildRules(cfg)) {
    if (rule.days <= 0) continue
    const key = `${rule.name}:${rule.table}`
    try {
      result.deleted[key] = (result.deleted[key] ?? 0) + (await purgeRule(db, rule, now))
    } catch (error) {
      result.errors[key] = error instanceof Error ? error.message : String(error)
    }
  }
  return result
}

const tickOnce = Effect.gen(function* () {
  const { deleted, errors } = yield* Effect.promise(() =>
    runRetention(pool, retentionConfigFromEnv()),
  )
  const purged = Object.fromEntries(Object.entries(deleted).filter(([, n]) => n > 0))
  if (Object.keys(purged).length > 0) yield* Effect.logInfo("retention purge", purged)
  if (Object.keys(errors).length > 0) yield* Effect.logError("retention purge errors", errors)
})

let started = false

/** Start the periodic retention purge (idempotent). Called from index.ts. */
export const startRetentionTick = (): void => {
  if (started) return
  started = true
  const intervalMs = Number(process.env.RETENTION_TICK_INTERVAL_MS ?? DAY_MS)
  AppRuntime.runFork(
    tickOnce.pipe(
      Effect.tapErrorCause((cause) => Effect.logError("retention tick error", cause)),
      Effect.catchAllCause(() => Effect.void),
      Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
    ),
  )
}
