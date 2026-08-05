import type { PgInsertValue, PgTable } from "drizzle-orm/pg-core"
import { db } from "../db"

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
 * Insert one audit row. The `<x>AuditLog` tables share a column set, but each is
 * a distinct drizzle type, so the values object is cast to the target table's
 * insert type — the shape is checked against `AuditEntry` above, and a column
 * drifting on one table would surface as a migration/schema-drift failure in
 * `server/migrations.test.ts` rather than here.
 */
export const writeAuditLog = async (table: PgTable, entry: AuditEntry): Promise<void> => {
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
