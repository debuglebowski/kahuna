-- Custom SQL migration file, put your code below! --

-- Relation fields used to store their target concept by NAME in config.target;
-- the app now identifies concepts by id (so they can be renamed safely). Rewrite
-- each relation field's config.target from the concept name to the concept id.
-- Orphan targets (a name that no longer matches any concept) are left untouched.
UPDATE fields f
SET config = jsonb_set(config, '{target}', to_jsonb(c.id::text))
FROM concepts c
WHERE f.kind = 'relation'
  AND f.org_id = c.org_id
  AND f.config ->> 'target' = c.name;
