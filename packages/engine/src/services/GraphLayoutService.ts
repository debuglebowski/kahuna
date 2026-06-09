import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { OrgContext } from "./OrgContext"

/** Node id → canvas position, as stored in `concept_graph_layouts.positions`. */
export type GraphLayoutPositions = Readonly<
  Record<string, { readonly x: number; readonly y: number }>
>

interface LayoutRow {
  readonly positions: GraphLayoutPositions
}

/**
 * Saved node positions for the org's concept graph canvas. Like sidebar views
 * this is shared presentation state, opaque to the engine and not admin-gated:
 * any member may rearrange the shared canvas; last write wins. One row per org.
 */
export class GraphLayoutService extends Effect.Service<GraphLayoutService>()(
  "engine/GraphLayoutService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient

      /** The org's saved positions, or `{}` when nothing has been saved yet. */
      const get = () =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<LayoutRow>`
            SELECT positions FROM concept_graph_layouts WHERE org_id = ${orgId} LIMIT 1`
          return rows[0]?.positions ?? {}
        })

      /**
       * Merge a partial position patch into the org's saved layout (jsonb `||`,
       * so concurrent editors moving DIFFERENT nodes don't clobber each other —
       * last write wins only per node). After merging, entries whose concept no
       * longer exists are pruned, which doubles as id validation and keeps the
       * document bounded. Returns the resulting full map.
       */
      const save = (patch: GraphLayoutPositions) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const { orgId } = yield* OrgContext
            yield* sql`
              INSERT INTO concept_graph_layouts (org_id, positions, updated_at)
              VALUES (${orgId}, ${JSON.stringify(patch)}::jsonb, now())
              ON CONFLICT (org_id)
              DO UPDATE SET positions = concept_graph_layouts.positions || EXCLUDED.positions,
                            updated_at = now()`
            const rows = yield* sql<LayoutRow>`
              UPDATE concept_graph_layouts SET positions = (
                SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                FROM jsonb_each(positions) AS e
                WHERE e.key IN (SELECT id::text FROM concepts WHERE org_id = ${orgId})
              )
              WHERE org_id = ${orgId}
              RETURNING positions`
            return rows[0]?.positions ?? {}
          }),
        )

      return { get, save } as const
    }),
    dependencies: [],
  },
) {}
