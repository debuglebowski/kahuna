import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { DashboardBody, MemberPage } from "../domain/types"
import { OrgContext } from "./OrgContext"
import {
  type MemberDeactivationRow,
  type MemberPageRow,
  toMemberDeactivation,
  toMemberPage,
} from "./rows"

/**
 * Member pages + deactivation markers. A page is a widget canvas (same opaque
 * `DashboardBody` document as dashboards, resolved client-side) with a fixed
 * scope: one page per (org, user), only the owner writes (enforced by
 * construction — `updatePage` always targets the actor's own row), every org
 * member reads. A never-customised page reads as an empty body; the client
 * renders its own default ("assigned to you" widgets) without persisting it.
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

    /** A member's page; an empty canvas if they never customised it. */
    const getPage = (userId: string) =>
      Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        const rows = yield* sql<MemberPageRow>`
          SELECT * FROM member_pages
          WHERE org_id = ${orgId} AND user_id = ${userId} LIMIT 1`
        return rows[0] ? toMemberPage(rows[0]) : ({ userId, body: { widgets: [] } } as MemberPage)
      })

    /** Upsert the CALLER's own page (owner-only by construction). */
    const updatePage = (body: DashboardBody) =>
      Effect.gen(function* () {
        const { orgId, actor } = yield* OrgContext
        const rows = yield* sql<MemberPageRow>`
          INSERT INTO member_pages (org_id, user_id, body)
          VALUES (${orgId}, ${actor}, ${JSON.stringify(body)}::jsonb)
          ON CONFLICT (org_id, user_id)
          DO UPDATE SET body = EXCLUDED.body, updated_at = now()
          RETURNING *`
        return toMemberPage(rows[0]!)
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

    /** Drop everything this org holds about a member (page + marker) — the
     *  engine half of a member purge; membership removal is the server's half. */
    const purgeMemberData = (userId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* sql`DELETE FROM member_pages
            WHERE org_id = ${orgId} AND user_id = ${userId}`
          yield* sql`DELETE FROM member_deactivations
            WHERE org_id = ${orgId} AND user_id = ${userId}`
        }),
      )

    return {
      getPage,
      updatePage,
      listDeactivations,
      deactivate,
      reactivate,
      purgeMemberData,
    } as const
  }),
  dependencies: [],
}) {}
