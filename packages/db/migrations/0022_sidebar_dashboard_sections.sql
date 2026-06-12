-- Data migration: sidebar view bodies move from sectioned content sources
-- ({kind: static|group|list|links}) to flat {id,title,icon,collapsed?,dashboardIds}
-- sections. The global nav items are hardcoded client-side now, so:
--   group  → dashboardIds = manual dashboard members (stored order) + (when a
--            {target:"dashboards"} rule exists) every dashboard visible to the
--            view (shared, plus the owner's personal ones for personal views;
--            hidden excluded; position/name order), deduped keeping the first
--            occurrence so a pinned dashboard keeps its drag position.
--   static/list/links sections, instance pins, and item rules are DROPPED.
-- Converted sections that end up empty AND untitled are dropped too.

-- Normalize garbage bodies first (defensive; mirrors rows.ts toViewBody).
UPDATE sidebar_views
SET body = '{"sections":[]}'::jsonb
WHERE jsonb_typeof(body->'sections') IS DISTINCT FROM 'array';
--> statement-breakpoint
UPDATE sidebar_views v
SET body = jsonb_build_object('sections', COALESCE((
  SELECT jsonb_agg(ns.sec ORDER BY ns.ord)
  FROM (
    SELECT
      t.ord,
      (jsonb_build_object(
         'id',    t.s->'id',
         'title', t.s->'title',
         'icon',  t.s->'icon',
         'dashboardIds', ids.ids)
       || CASE WHEN t.s ? 'collapsed'
               THEN jsonb_build_object('collapsed', t.s->'collapsed')
               ELSE '{}'::jsonb END) AS sec,
      ids.ids AS ids,
      NULLIF(t.s->>'title', '') AS title_text
    FROM jsonb_array_elements(v.body->'sections') WITH ORDINALITY AS t(s, ord)
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(to_jsonb(u.did) ORDER BY u.rnk), '[]'::jsonb) AS ids
      FROM (
        SELECT raw.did, MIN(raw.rnk) AS rnk
        FROM (
          -- manual dashboard members, in stored order
          SELECT m.elem->>'dashboardId' AS did, m.ord AS rnk
          FROM jsonb_array_elements(COALESCE(t.s->'source'->'members', '[]'::jsonb))
               WITH ORDINALITY AS m(elem, ord)
          WHERE m.elem->>'kind' = 'dashboard'
          UNION ALL
          -- a {target:"dashboards"} rule expands to every dashboard this view sees
          SELECT d.id::text, 1000000 + row_number() OVER (ORDER BY d.position, d.name)
          FROM dashboards d
          WHERE d.org_id = v.org_id
            AND (d.owner_id IS NULL OR d.owner_id = v.owner_id)
            AND NOT d.hidden
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(COALESCE(t.s->'source'->'rules', '[]'::jsonb)) r
              WHERE r->>'target' = 'dashboards')
        ) raw
        WHERE raw.did IS NOT NULL
        GROUP BY raw.did
      ) u
    ) ids
    WHERE t.s->'source'->>'kind' = 'group'
  ) ns
  WHERE ns.ids <> '[]'::jsonb OR ns.title_text IS NOT NULL
), '[]'::jsonb));
