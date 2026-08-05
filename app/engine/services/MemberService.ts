import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { RecordViewPrefs, RecordViewPrefsBody } from "../domain/types"
import { OrgContext } from "./OrgContext"
import {
  type MemberDeactivationRow,
  type RecordViewPrefsRow,
  toMemberDeactivation,
  toRecordViewPrefs,
} from "./rows"

/**
 * Per-member rows: record version-view layout prefs + deactivation markers.
 *
 * Deactivation is the member analogue of archive: a marker row that the server
 * tier uses to block org access and the client uses to hide the user from
 * pickers. Who may deactivate (admin), and what a member-purge entails beyond
 * `purgeMemberData` (removing the BetterAuth membership), are auth-tier
 * concerns enforced at the server boundary — the engine only owns the rows.
 */
export class MemberService extends Effect.Service<MemberService>()("engine/MemberService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    /** The CALLER's record version-view layout prefs; defaults if never saved. */
    const getViewPrefs = () =>
      Effect.gen(function* () {
        const { orgId, actor } = yield* OrgContext
        const rows = yield* sql<RecordViewPrefsRow>`
          SELECT * FROM record_view_prefs
          WHERE org_id = ${orgId} AND user_id = ${actor} LIMIT 1`
        return rows[0]
          ? toRecordViewPrefs(rows[0])
          : ({
              userId: actor,
              body: { defaultView: null, byConcept: {}, customByConcept: {} },
            } as RecordViewPrefs)
      })

    /** Upsert the CALLER's own view prefs (owner-only by construction). */
    const updateViewPrefs = (body: RecordViewPrefsBody) =>
      Effect.gen(function* () {
        const { orgId, actor } = yield* OrgContext
        const rows = yield* sql<RecordViewPrefsRow>`
          INSERT INTO record_view_prefs (org_id, user_id, body)
          VALUES (${orgId}, ${actor}, ${JSON.stringify(body)}::jsonb)
          ON CONFLICT (org_id, user_id)
          DO UPDATE SET body = EXCLUDED.body, updated_at = now()
          RETURNING *`
        return toRecordViewPrefs(rows[0]!)
      })

    /** All deactivation markers in the org (joined client-side with the member list). */
    const listDeactivations = () =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<MemberDeactivationRow>`
          SELECT * FROM member_deactivations
          WHERE org_id = ${orgId} ORDER BY deactivated_at ASC`
        return rows.map(toMemberDeactivation)
      })

    /** Mark a user deactivated; idempotent (re-deactivating keeps the original time). */
    const deactivate = (userId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        yield* sql`
          INSERT INTO member_deactivations (org_id, user_id)
          VALUES (${orgId}, ${userId})
          ON CONFLICT (org_id, user_id) DO NOTHING`
        const rows = yield* sql<MemberDeactivationRow>`
          SELECT * FROM member_deactivations
          WHERE org_id = ${orgId} AND user_id = ${userId} LIMIT 1`
        return toMemberDeactivation(rows[0]!)
      })

    /** Clear a user's deactivation marker; idempotent. */
    const reactivate = (userId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        yield* sql`
          DELETE FROM member_deactivations
          WHERE org_id = ${orgId} AND user_id = ${userId}`
      })

    /** Drop everything this org holds about a member (prefs + marker) — the
     *  engine half of a member purge; membership removal is the server's half. */
    const purgeMemberData = (userId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* sql`DELETE FROM record_view_prefs
            WHERE org_id = ${orgId} AND user_id = ${userId}`
          yield* sql`DELETE FROM member_deactivations
            WHERE org_id = ${orgId} AND user_id = ${userId}`
          // Their ACCESS, which nothing else clears: `access_role_actors` has no FK
          // to the auth tables and BetterAuth's own removeMember never knew about it.
          // Leaving these behind means a purged person still appears in "who holds
          // this role?", and — worse — silently gets their old access back if they
          // are ever re-added.
          yield* sql`DELETE FROM access_role_actors
            WHERE org_id = ${orgId} AND actor_id = ${userId}`
          // Shares are the same row shape with `actor_id` instead of `role_id`, so
          // they need the same treatment; a share outlives the role that granted it
          // by design, which is exactly why it has to be cleaned up explicitly.
          yield* sql`DELETE FROM access_rules
            WHERE org_id = ${orgId} AND actor_id = ${userId}`
        }),
      )

    return {
      getViewPrefs,
      updateViewPrefs,
      listDeactivations,
      deactivate,
      reactivate,
      purgeMemberData,
    } as const
  }),
  dependencies: [],
}) {}
