import { getTableName } from "drizzle-orm"
import type { PgInsertValue, PgTable } from "drizzle-orm/pg-core"
import { db } from "../db"
import { securityEvent } from "../securityLog"

/**
 * The integration audit-log writer.
 *
 * Every connector (google, linear, slack, posthog, apollo, clay) had a private
 * `audit()` that was byte-identical to the other five apart from the table it
 * inserted into — and the six `<x>_audit_log` tables are themselves identical:
 * the same ten columns, the same single `(org_id, created_at)` index, and no FK
 * on `connection_id`. So the only real per-connector input is the table object.
 *
 * The tables stay separate on purpose (each connector owns its own log, and its
 * rows die with its own migration), so this takes the table as a parameter rather
 * than trying to unify them into one physical log.
 */
export type AuditEntry = {
  orgId: string
  userId: string
  connectionId?: string | null
  action: string
  status?: "ok" | "error"
  subjectKind?: string | null
  subjectId?: string | null
  detail?: unknown
}

/**
 * Audit actions that also go to the structured security log: credentials being
 * attached or removed, and writes pushed OUT to a third party under the org's or a
 * user's identity. Deliberately not every action — sync, webhook, event and enrich
 * rows are high-volume and routine, and stay in the audit table only.
 */
const SECURITY_ACTIONS = new Set([
  "connect",
  "disconnect",
  "user.connect",
  "user.disconnect",
  "gmail.send",
  "post_message",
  "post_message.user",
  "writeback.update",
  "writeback.close",
])

/** Emitted BEFORE the insert so a failing DB write cannot swallow the event. Ids and
 *  the action name only — `entry.detail` can hold provider text and is never logged. */
const logIntegrationSecurityEvent = (table: PgTable, entry: AuditEntry): void => {
  if (!SECURITY_ACTIONS.has(entry.action)) return
  securityEvent({
    event: `integration.${entry.action}`,
    outcome: entry.status === "error" ? "failure" : "success",
    actor: entry.userId,
    orgId: entry.orgId,
    targetKind: "integration",
    targetId: getTableName(table).replace(/_audit_log$/, ""),
  })
}

/**
 * Insert one audit row. The `<x>AuditLog` tables share a column set, but each is
 * a distinct drizzle type, so the values object is cast to the target table's
 * insert type — the shape is checked against `AuditEntry` above, and a column
 * drifting on one table would surface as a migration/schema-drift failure in
 * `server/migrations.test.ts` rather than here.
 */
export const writeAuditLog = async (table: PgTable, entry: AuditEntry): Promise<void> => {
  logIntegrationSecurityEvent(table, entry)
  await db.insert(table).values({
    orgId: entry.orgId,
    userId: entry.userId,
    connectionId: entry.connectionId ?? null,
    action: entry.action,
    status: entry.status ?? "ok",
    subjectKind: entry.subjectKind ?? null,
    subjectId: entry.subjectId ?? null,
    detail: entry.detail ?? {},
  } as PgInsertValue<PgTable>)
}
