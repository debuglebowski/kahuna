-- Data migration: surface the "members" global item in EXISTING sidebar views.
-- New orgs get it via the SidebarViewService seed; views persisted before the
-- member-pages feature carry a static items list without it (the same gap the
-- dashboards rollout left). For every static section missing "members", insert
-- it right after "dashboards" (or append at the end when there is none).
UPDATE sidebar_views v
SET body = jsonb_set(
  v.body,
  '{sections}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN t.s->'source'->>'kind' = 'static'
         AND jsonb_typeof(t.s->'source'->'items') = 'array'
         AND NOT (t.s->'source'->'items' @> '"members"'::jsonb)
        THEN jsonb_set(
          t.s,
          '{source,items}',
          CASE
            WHEN t.s->'source'->'items' @> '"dashboards"'::jsonb THEN (
              SELECT jsonb_agg(u.x ORDER BY u.ord, u.sub)
              FROM (
                SELECT e.elem AS x, e.ord, 0 AS sub
                FROM jsonb_array_elements(t.s->'source'->'items') WITH ORDINALITY AS e(elem, ord)
                UNION ALL
                SELECT '"members"'::jsonb, e2.ord, 1
                FROM jsonb_array_elements(t.s->'source'->'items') WITH ORDINALITY AS e2(elem, ord)
                WHERE e2.elem = '"dashboards"'::jsonb
              ) u
            )
            ELSE t.s->'source'->'items' || '"members"'::jsonb
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
      AND NOT (s2->'source'->'items' @> '"members"'::jsonb)
  );
