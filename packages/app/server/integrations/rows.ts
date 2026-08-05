import { eq } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import { db } from "../db"

/**
 * The org-scoped connection read, shared by the five connectors that keep ONE
 * connection per org (linear, posthog, slack, apollo, clay). Each had a private
 * `connectionForOrg` that was identical apart from the table.
 *
 * Google deliberately does NOT use this: `google_connection` is unique on
 * `(org_id, user_id)`, not `(org_id)`, so every google read needs a
 * two-predicate `where` and returns a per-user row. Slack keeps its own
 * `connectionForTeam`/`userConnectionFor` for the same reason (inbound routing by
 * team id, plus a per-user token table).
 *
 * Generic over the table so the caller keeps the connector's real row type —
 * `tokenFor`/`ctxFor` take `typeof <x>Connection.$inferSelect`, so a widened
 * return type here would push casts out into every caller.
 */
// Must extend `PgTable` itself, not a PgTableWithColumns<…> shape: drizzle's
// `.from()` gates on `TableLikeHasEmptySelection<T>`, which only resolves to
// `false` for a T that is assignable to PgTable.
type OrgScopedTable = PgTable & { orgId: PgColumn }

export const connectionForOrgIn = async <T extends OrgScopedTable>(
  table: T,
  orgId: string,
): Promise<T["$inferSelect"] | null> => {
  // `.from()` gates its parameter on `TableLikeHasEmptySelection<T>`, a
  // conditional type that TS cannot resolve while T is still an unresolved type
  // parameter — so it stays deferred and the argument is rejected even though
  // every real call site passes a plain table. Narrowed to PgTable for the call;
  // the row is re-typed from T on the way out, which is what keeps the
  // connector's real row shape (callers do `conn.token`, `conn.host`, …).
  const [row] = await db
    .select()
    .from(table as PgTable)
    .where(eq(table.orgId, orgId))
    .limit(1)
  return (row as T["$inferSelect"] | undefined) ?? null
}
