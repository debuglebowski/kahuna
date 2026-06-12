-- Rename each sidebar section's `dashboardIds` key to `entryIds`: sections now
-- hold generic placed entries — dashboard uuids plus `global:<key>` sentinels
-- for global nav items dragged into a section (0022 introduced the array as
-- dashboards-only).
UPDATE sidebar_views v
SET body = jsonb_build_object('sections', COALESCE((
  SELECT jsonb_agg(
    (t.s - 'dashboardIds')
      || jsonb_build_object('entryIds', COALESCE(t.s->'dashboardIds', t.s->'entryIds', '[]'::jsonb))
    ORDER BY t.ord)
  FROM jsonb_array_elements(v.body->'sections') WITH ORDINALITY AS t(s, ord)
), '[]'::jsonb))
WHERE jsonb_typeof(v.body->'sections') = 'array';
