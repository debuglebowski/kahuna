-- FIXES A HOLE IN 0019, which is fail-CLOSED and therefore worth a migration of
-- its own rather than a quiet amendment.
--
-- 0019 grants each pre-existing role the blanket rules for the four actions that
-- became enforced in the same release (record edit/create, dashboard create, view
-- create). It skipped any role that already held the action — but its guard was:
--
--     NOT EXISTS (... x.role_id = r.id AND x.resource_type = ... AND
--                     'create' = ANY(x.actions))
--
-- with no filter on `x.resource_id`. So a role holding a TARGETED rule — one naming
-- a single dashboard — counted as already having `create`, and the blanket rule was
-- never written.
--
-- A targeted rule cannot answer the question. `createDashboard` decides `create`
-- against `{type:"dashboard"}` with no id, and `coversResource` refuses a rule that
-- names one; `record`/`edit` is per-record, so a rule naming one record says nothing
-- about the rest. The affected roles therefore came out of 0019 unable to create a
-- dashboard or edit a record at all.
--
-- Real on this database, not hypothetical: 29 orgs had a Member holding
-- `{create,edit,archive,share,view}` on ONE dashboard, written years ago by the old
-- `reconcile-access` repair script, and every one of them lost dashboard creation.
--
-- The guard below is the same test with `resource_id IS NULL AND concept_id IS NULL`
-- added, which is what "does this role already say this about ALL of them?" actually
-- means. Idempotent, so it is a no-op for every role 0019 got right.

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['edit'], 'record', 'system:migration-0021'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'record'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND x.resource_id IS NULL AND x.concept_id IS NULL
      AND ('edit' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['create'], 'record', 'system:migration-0021'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'record'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND x.resource_id IS NULL AND x.concept_id IS NULL
      AND ('create' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['create'], 'dashboard', 'system:migration-0021'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'dashboard'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND x.resource_id IS NULL AND x.concept_id IS NULL
      AND ('create' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['create'], 'view', 'system:migration-0021'
FROM access_roles r
WHERE r.full_access = false
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = r.id AND x.resource_type = 'view'
      AND x.effect = 'allow' AND x.condition IS NULL
      AND x.resource_id IS NULL AND x.concept_id IS NULL
      AND ('create' = ANY(x.actions) OR '*' = ANY(x.actions))
  );--> statement-breakpoint

INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
