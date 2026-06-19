import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { DashboardBody } from "../domain/types"
import {
  ConceptNotFound,
  DashboardConflict,
  DashboardNotFound,
  DashboardProtected,
} from "../errors"
import { OrgContext } from "./OrgContext"
import { type DashboardRow, toDashboard } from "./rows"

/**
 * The built-in Default dashboard's content. Seeded empty (no widgets) so the
 * org's home (`/`) is never blank but stays a clean canvas; the user fills it
 * via the editor.
 */
const DEFAULT_DASHBOARD_BODY: DashboardBody = { widgets: [] }

/**
 * CRUD for Dashboards — configurable widget canvases. Mirrors SidebarViewService
 * exactly: `owner_id` null = org-shared (any member may read/edit), else personal
 * to that user. The `body` document is opaque here (never inspected); the web
 * client resolves it. No admin gate — the only scoping is that a user cannot
 * touch ANOTHER user's personal dashboard (enforced by `owner_id IS NULL OR
 * owner_id = actor` on every write).
 */
export class DashboardService extends Effect.Service<DashboardService>()(
  "engine/DashboardService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient

      /** Guarantee the org has at least one shared dashboard by seeding the
       *  Default if none exists. Atomic (INSERT … WHERE NOT EXISTS), so
       *  concurrent reads never double-seed; a no-op once any shared one exists. */
      const ensureDefault = Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        // Only PAGE dashboards count as the org home — record dashboards
        // (concept_id set) are templates and must never satisfy the seed guard.
        yield* sql`
          INSERT INTO dashboards (org_id, owner_id, name, icon, position, body)
          SELECT ${orgId}, NULL, 'Home', 'lucide:LayoutDashboard', 0,
                 ${JSON.stringify(DEFAULT_DASHBOARD_BODY)}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM dashboards
            WHERE org_id = ${orgId} AND owner_id IS NULL AND concept_id IS NULL
          )`
      })

      /** The switcher: PAGE dashboards the caller can see (org-shared + own personal).
       *  Record dashboards are per-concept templates — see `listRecordDashboards`. */
      const list = () =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          yield* ensureDefault
          const rows = yield* sql<DashboardRow>`
            SELECT * FROM dashboards
            WHERE org_id = ${orgId} AND kind = 'page'
              AND (owner_id IS NULL OR owner_id = ${actor})
            ORDER BY position ASC, created_at ASC`
          return rows.map(toDashboard)
        })

      /** A concept's record dashboards the caller can see — org-shared + their own
       *  personal — in `position` order (the FIRST is what a bare reference opens). */
      const listRecordDashboards = (conceptId: string) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const rows = yield* sql<DashboardRow>`
            SELECT * FROM dashboards
            WHERE org_id = ${orgId} AND kind = 'record' AND concept_id = ${conceptId}
              AND (owner_id IS NULL OR owner_id = ${actor})
            ORDER BY position ASC, created_at ASC`
          return rows.map(toDashboard)
        })

      /** EVERY dashboard the caller can see — page + record — for the settings
       *  management list (which groups across both kinds). One query, vs fetching
       *  record dashboards per concept. */
      const listAll = () =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          yield* ensureDefault
          const rows = yield* sql<DashboardRow>`
            SELECT * FROM dashboards
            WHERE org_id = ${orgId} AND (owner_id IS NULL OR owner_id = ${actor})
            ORDER BY position ASC, created_at ASC`
          return rows.map(toDashboard)
        })

      const create = (input: {
        readonly name: string
        readonly icon?: string | null
        readonly scope: "personal" | "org"
        readonly body: DashboardBody
        /** "record" = a per-concept template (conceptId required; appended last in
         *  the concept's view order). Like page dashboards, may be org or personal. */
        readonly kind?: "page" | "record"
        readonly conceptId?: string | null
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            const isRecord = input.kind === "record"
            if (isRecord && !input.conceptId) {
              return yield* Effect.fail(new ConceptNotFound({ concept: input.conceptId ?? "" }))
            }
            const conceptId = isRecord ? input.conceptId! : null
            // Both kinds honour scope: personal = owned by the creator, org = shared.
            const ownerId = input.scope === "personal" ? actor : null
            // Position scope: a concept's record templates (append last), else the
            // caller's switcher. A bare reference opens the FIRST by position.
            const max = isRecord
              ? yield* sql<{ readonly max: number | string | null }>`
                  SELECT MAX(position) AS max FROM dashboards
                  WHERE org_id = ${orgId} AND kind = 'record' AND concept_id = ${conceptId}`
              : yield* sql<{ readonly max: number | string | null }>`
                  SELECT MAX(position) AS max FROM dashboards
                  WHERE org_id = ${orgId} AND kind = 'page'
                    AND (owner_id IS NULL OR owner_id = ${actor})`
            const position = Number(max[0]?.max ?? -1) + 1
            const rows = yield* sql<DashboardRow>`
              INSERT INTO dashboards
                (org_id, owner_id, name, icon, position, kind, concept_id, body)
              VALUES (${orgId}, ${ownerId}, ${input.name}, ${input.icon ?? null}, ${position},
                      ${isRecord ? "record" : "page"}, ${conceptId},
                      ${JSON.stringify(input.body)}::jsonb)
              RETURNING *`
            return toDashboard(rows[0]!)
          }),
        )

      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly icon?: string | null
        readonly hidden?: boolean
        readonly scope?: "personal" | "org"
        readonly body?: DashboardBody
        /** Optimistic-concurrency etag: if set and the row's `updated_at` has since
         *  moved, the write is rejected so a concurrent editor isn't clobbered. */
        readonly expectedUpdatedAt?: Date
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            const found = yield* sql<DashboardRow>`
              SELECT * FROM dashboards
              WHERE org_id = ${orgId} AND id = ${input.id}
                AND (owner_id IS NULL OR owner_id = ${actor}) LIMIT 1`
            const cur = found[0]
            if (!cur) return yield* Effect.fail(new DashboardNotFound({ id: input.id }))
            if (
              input.expectedUpdatedAt !== undefined &&
              new Date(cur.updated_at).getTime() !== input.expectedUpdatedAt.getTime()
            ) {
              return yield* Effect.fail(new DashboardConflict({ id: input.id }))
            }
            const name = input.name === undefined ? cur.name : input.name.trim()
            const icon = input.icon === undefined ? cur.icon : input.icon
            const hidden = input.hidden === undefined ? cur.hidden : input.hidden
            // Both kinds honour scope: personal = owner is the actor, org = shared.
            const ownerId =
              input.scope === undefined ? cur.owner_id : input.scope === "personal" ? actor : null
            const body = input.body === undefined ? cur.body : input.body
            const rows = yield* sql<DashboardRow>`
              UPDATE dashboards
              SET name = ${name}, icon = ${icon}, hidden = ${hidden}, owner_id = ${ownerId},
                  body = ${JSON.stringify(body)}::jsonb, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${input.id}
              RETURNING *`
            return toDashboard(rows[0]!)
          }),
        )

      const remove = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            const found = yield* sql<DashboardRow>`
              SELECT * FROM dashboards
              WHERE org_id = ${orgId} AND id = ${id}
                AND (owner_id IS NULL OR owner_id = ${actor}) LIMIT 1`
            const row = found[0]
            if (!row) return yield* Effect.fail(new DashboardNotFound({ id }))
            // The home must never empty — refuse to delete the last shared PAGE
            // dashboard. Record templates (concept_id set) are exempt from the guard.
            if (row.owner_id === null && row.concept_id === null) {
              const cnt = yield* sql<{ readonly count: number | string }>`
                SELECT COUNT(*)::int AS count FROM dashboards
                WHERE org_id = ${orgId} AND owner_id IS NULL AND concept_id IS NULL`
              if (Number(cnt[0]?.count ?? 0) <= 1) {
                return yield* Effect.fail(new DashboardProtected({ id }))
              }
            }
            yield* sql`DELETE FROM dashboards WHERE org_id = ${orgId} AND id = ${id}`
            return toDashboard(row)
          }),
        )

      /** Batch-set positions (drag reorder); returns the caller's refreshed list. */
      const reorder = (orders: ReadonlyArray<{ readonly id: string; readonly position: number }>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId, actor } = yield* OrgContext
            yield* Effect.forEach(
              orders,
              (o) =>
                sql`UPDATE dashboards SET position = ${o.position}, updated_at = now()
                  WHERE org_id = ${orgId} AND id = ${o.id}
                    AND (owner_id IS NULL OR owner_id = ${actor})`,
            )
            return yield* list()
          }),
        )

      return { list, listAll, listRecordDashboards, create, update, remove, reorder } as const
    }),
    dependencies: [],
  },
) {}
