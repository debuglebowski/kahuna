-- Data migration: surface the "tasks" global item in EXISTING sidebar views.
-- New orgs get it via the SidebarViewService seed; views persisted before the
-- global Tasks page carry a static items list without it (same gap the members
-- rollout patched in 0014). For every static section missing "tasks", insert
-- it right after "overview" (or append at the end when there is none).
UPDATE sidebar_views v
SET body = jsonb_set(
  v.body,
  '{sections}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN t.s->'source'->>'kind' = 'static'
         AND jsonb_typeof(t.s->'source'->'items') = 'array'
         AND NOT (t.s->'source'->'items' @> '"tasks"'::jsonb)
        THEN jsonb_set(
          t.s,
          '{source,items}',
          CASE
            WHEN t.s->'source'->'items' @> '"overview"'::jsonb THEN (
              SELECT jsonb_agg(u.x ORDER BY u.ord, u.sub)
              FROM (
                SELECT e.elem AS x, e.ord, 0 AS sub
                FROM jsonb_array_elements(t.s->'source'->'items') WITH ORDINALITY AS e(elem, ord)
                UNION ALL
                SELECT '"tasks"'::jsonb, e2.ord, 1
                FROM jsonb_array_elements(t.s->'source'->'items') WITH ORDINALITY AS e2(elem, ord)
                WHERE e2.elem = '"overview"'::jsonb
              ) u
            )
            ELSE t.s->'source'->'items' || '"tasks"'::jsonb
          END
        )
        ELSE t.s
      END
      ORDER BY t.ord
    )
    FROM jsonb_array_elements(v.body->'sections') WITH ORDINALITY AS t(s, ord)
  )
)
WHERE jsonb_typeof(v.body->'sections') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v.body->'sections') s2
    WHERE s2->'source'->>'kind' = 'static'
      AND jsonb_typeof(s2->'source'->'items') = 'array'
      AND NOT (s2->'source'->'items' @> '"tasks"'::jsonb)
  );
