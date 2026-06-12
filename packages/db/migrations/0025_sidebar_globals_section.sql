-- Globals become ordinary section entries (no more derived top-of-sidebar
-- pool): prepend an untitled section holding every global nav item that isn't
-- already placed in one of the view's sections. Views that placed all globals
-- are left untouched.
UPDATE sidebar_views v
SET body = jsonb_build_object('sections',
  (SELECT CASE
            WHEN miss.arr = '[]'::jsonb THEN secs.s
            ELSE jsonb_build_array(jsonb_build_object(
                   'id', 'globals', 'title', NULL, 'icon', NULL, 'entryIds', miss.arr))
                 || secs.s
          END
   FROM (SELECT COALESCE(v.body->'sections', '[]'::jsonb) AS s) secs,
        (SELECT COALESCE(jsonb_agg(to_jsonb('global:' || k.key) ORDER BY k.ord), '[]'::jsonb) AS arr
         FROM (VALUES ('overview', 1), ('tasks', 2), ('members', 3),
                      ('automations', 4), ('settings', 5)) AS k(key, ord)
         WHERE NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(v.body->'sections', '[]'::jsonb)) sec,
                jsonb_array_elements_text(COALESCE(sec.value->'entryIds', '[]'::jsonb)) e(id)
           WHERE e.id = 'global:' || k.key)) miss))
WHERE jsonb_typeof(v.body->'sections') = 'array';
