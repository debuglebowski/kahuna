import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { decide } from "../domain/access"
import type { SidebarViewBody } from "../domain/types"
import { SidebarViewNotFound, SidebarViewProtected } from "../errors"
import { OrgContext, type OrgScope } from "./OrgContext"
import { type SidebarViewRow, toSidebarView } from "./rows"

/**
 * CRUD for sidebar Views — configurable nav layouts. `owner_id` null = org-shared
 * (any member may read/edit), else personal to that user. The `body` document is
 * opaque here (never inspected); the web client resolves it. Per the product
 * rule "anyone can create/edit and toggle visibility", there is no admin gate —
 * the only scoping is that a user cannot touch ANOTHER user's personal view
 * (enforced by `owner_id IS NULL OR owner_id = actor` on every write).
 */
export class SidebarViewService extends Effect.Service<SidebarViewService>()(
  "engine/SidebarViewService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient

      /** Guarantee the org has at least one shared view by seeding the Default
       *  if none exists: an untitled section holding the global nav items, then
       *  a "Dashboards" section pre-populated with the org's shared, non-hidden
       *  dashboards. Atomic (INSERT … WHERE NOT EXISTS), so concurrent reads
       *  never double-seed; a no-op once the org has any shared view. */
      const ensureDefault = Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        yield* sql`
          INSERT INTO sidebar_views (org_id, owner_id, name, icon, position, body)
          SELECT ${orgId}, NULL, 'Default', 'lucide:LayoutGrid', 0,
            jsonb_build_object('sections', jsonb_build_array(
              jsonb_build_object(
                'id', 'globals', 'title', NULL, 'icon', NULL,
                'entryIds', '["global:overview","global:tasks","global:members","global:automations","global:settings"]'::jsonb),
              jsonb_build_object(
                'id', 'dashboards', 'title', 'Dashboards', 'icon', NULL,
                'entryIds', COALESCE((
                  SELECT jsonb_agg(to_jsonb(d.id::text) ORDER BY d.position, d.name)
                  FROM dashboards d
                  WHERE d.org_id = ${orgId} AND d.owner_id IS NULL AND NOT d.hidden
                ), '[]'::jsonb))))
          WHERE NOT EXISTS (
            SELECT 1 FROM sidebar_views WHERE org_id = ${orgId} AND owner_id IS NULL
          )`
      })

      /**
       * ── VIEW ACCESS: DEFAULT + EXCEPTIONS ───────────────────────────────────
       *
       * Same shape as DashboardService: `owner_id` IS the default layer (null =
       * org-shared, non-null = personal to that user), and access rules layer over it.
       * See the longer note there for why that means personal views needed no
       * migration.
       */
      const hasRules = (scope: OrgScope): boolean =>
        scope.policy?.rules.some((r) => r.resourceType === "view") ?? false

      /** The default, per row: shared, or mine. */
      const byDefaultFor = (scope: OrgScope, ownerId: string | null): boolean =>
        ownerId === null || ownerId === scope.actor

      /** Resolve one view for a write, honouring both layers. A rule granting `edit`
       *  on someone else's personal view must be reachable, so the default cannot stay
       *  a WHERE clause. Fails not-found either way — never a distinct 403. */
      const findForWrite = (id: string, action: "edit" | "delete") =>
        Effect.gen(function* () {
          const scope = yield* OrgContext
          const rows = yield* sql<SidebarViewRow>`
            SELECT * FROM sidebar_views WHERE org_id = ${scope.orgId} AND id = ${id} LIMIT 1`
          const row = rows[0]
          if (!row) return null
          const fallback = byDefaultFor(scope, row.owner_id)
          const allowed = scope.policy
            ? decide(scope.policy, action, { type: "view", id }, fallback, {
                unconditionalOnly: true,
              })
            : fallback
          return allowed ? row : null
        })

      /** Everything the caller can see: all org-shared views + their own personal. */
      const list = () =>
        Effect.gen(function* () {
          const scope = yield* OrgContext
          const { orgId, actor } = scope
          yield* ensureDefault
          // No LIMIT on this query, so applying the exception layer in memory cannot
          // skew a count or truncate a page (unlike record lists, where the filter
          // must be compiled into the SQL).
          const gate = hasRules(scope) ? sql`TRUE` : sql`(owner_id IS NULL OR owner_id = ${actor})`
          const rows = yield* sql<SidebarViewRow>`
            SELECT * FROM sidebar_views
            WHERE org_id = ${orgId} AND ${gate}
            ORDER BY position ASC, created_at ASC`
          const visible = hasRules(scope)
            ? rows.filter((r) =>
                decide(
                  scope.policy!,
                  "view",
                  { type: "view", id: r.id },
                  byDefaultFor(scope, r.owner_id),
                  { unconditionalOnly: true },
                ),
              )
            : rows
          return visible.map(toSidebarView)
        })

      const create = (input: {
        readonly name: string
        readonly icon?: string | null
        readonly scope: "personal" | "org"
        readonly body: SidebarViewBody
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const ownerId = input.scope === "personal" ? actor : null
          // Append to the end of the caller's visible pager.
          const max = yield* sql<{ readonly max: number | string | null }>`
            SELECT MAX(position) AS max FROM sidebar_views
            WHERE org_id = ${orgId} AND (owner_id IS NULL OR owner_id = ${actor})`
          const position = Number(max[0]?.max ?? -1) + 1
          const rows = yield* sql<SidebarViewRow>`
            INSERT INTO sidebar_views (org_id, owner_id, name, icon, position, body)
            VALUES (${orgId}, ${ownerId}, ${input.name}, ${input.icon ?? null}, ${position},
                    ${JSON.stringify(input.body)}::jsonb)
            RETURNING *`
          return toSidebarView(rows[0]!)
        })

      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly icon?: string | null
        readonly hidden?: boolean
        readonly scope?: "personal" | "org"
        readonly body?: SidebarViewBody
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const cur = yield* findForWrite(input.id, "edit")
          if (!cur) return yield* Effect.fail(new SidebarViewNotFound({ id: input.id }))
          // Name is optional — an explicit empty string clears it (icon-only view).
          const name = input.name === undefined ? cur.name : input.name.trim()
          const icon = input.icon === undefined ? cur.icon : input.icon
          const hidden = input.hidden === undefined ? cur.hidden : input.hidden
          const ownerId =
            input.scope === undefined ? cur.owner_id : input.scope === "personal" ? actor : null
          const body = input.body === undefined ? cur.body : input.body
          const rows = yield* sql<SidebarViewRow>`
            UPDATE sidebar_views
            SET name = ${name}, icon = ${icon}, hidden = ${hidden}, owner_id = ${ownerId},
                body = ${JSON.stringify(body)}::jsonb, updated_at = now()
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING *`
          return toSidebarView(rows[0]!)
        })

      const remove = (id: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            const row = yield* findForWrite(id, "delete")
            if (!row) return yield* Effect.fail(new SidebarViewNotFound({ id }))
            // The list must never empty for anyone — refuse to delete the last
            // shared view (every member sees the shared views).
            if (row.owner_id === null) {
              const cnt = yield* sql<{ readonly count: number | string }>`
                SELECT COUNT(*)::int AS count FROM sidebar_views
                WHERE org_id = ${orgId} AND owner_id IS NULL`
              if (Number(cnt[0]?.count ?? 0) <= 1) {
                return yield* Effect.fail(new SidebarViewProtected({ id }))
              }
            }
            yield* sql`DELETE FROM sidebar_views WHERE org_id = ${orgId} AND id = ${id}`
            return toSidebarView(row)
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
                sql`UPDATE sidebar_views SET position = ${o.position}, updated_at = now()
                  WHERE org_id = ${orgId} AND id = ${o.id}
                    AND (owner_id IS NULL OR owner_id = ${actor})`,
            )
            return yield* list()
          }),
        )

      return { list, create, update, remove, reorder } as const
    }),
    dependencies: [],
  },
) {}
