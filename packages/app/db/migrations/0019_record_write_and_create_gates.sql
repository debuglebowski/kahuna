-- Four actions became REAL in this release. Each was offered by the model and
-- decided by nothing, so every role behaved as though it held them:
--
--   record  / edit    `RecordService.assertRecordWritable` was two READ checks and
--                     nothing more — anything you could open, you could change.
--                     It now also runs `assertRecordEditable`.
--   record  / create  `RecordService.create` gated on the concept's READ only. It
--                     now decides `create` against the concept.
--   dashboard/create  ungated at every layer. Now `use-cases.createDashboard`.
--   view    / create  ungated at every layer. Now `use-cases.createView`.
--
-- All four fall back CLOSED, like every other rule: silence grants nothing. So
-- shipping the gates alone would not narrow access, it would remove it — from
-- everyone at once, on deploy, with no way to tell from an admin account (a
-- `full_access` role short-circuits `decide` before any of this is consulted).
--
-- This is the other half of that change: grant, to every role that could already
-- do these things, the rule that now says so. Nobody can have been granted them
-- deliberately — there was nothing to grant — so there is no "did they mean it?"
-- case to preserve. The seed does the same for new orgs (`BUILTIN_ROLES`).
--
-- SHAPE. One blanket rule per (role, type), because that is what these roles
-- effectively held: unrestricted, covering resources that did not exist yet. That
-- shape is now first-class — the "All" row of a permissions pane is exactly this
-- rule — where before this release it was refused outright on these types.
--
-- SCOPE. Every non-`full_access` role in every org, including custom ones. Skipping
-- `full_access` because their `*` already covers every action present and future;
-- adding a narrower duplicate would be noise in the pane and nothing else.

-- record/edit and record/create. `array_agg`+`ON CONFLICT` is not available here
-- (no unique index on this shape), so each type is handled as its own INSERT …
-- WHERE NOT EXISTS, which is also what makes this migration idempotent.
INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['edit'], 'record', 'system:migration-0019'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'record'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND ('edit' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['create'], 'record', 'system:migration-0019'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'record'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND ('create' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['create'], 'dashboard', 'system:migration-0019'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'dashboard'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND ('create' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['create'], 'view', 'system:migration-0019'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'view'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND ('create' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

-- Rules changed, so every org's resolved policy is stale. `PolicyService` memoizes
-- on this generation, so without the bump a warm server keeps deciding from the
-- pre-migration rule set — i.e. keeps refusing the writes this migration exists to
-- restore, until something else happens to bump it.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
