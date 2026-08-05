-- P8: the implicit "no rule = allowed" fallback for org/field/bucket/task/note/member
-- closes. `AccessRoleService.BUILTIN_ROLES`'s member preset now grants `view` on
-- these six explicitly (`UNTEMPLATED_VISIBLE`) for freshly-seeded orgs — but
-- `ensureBuiltins` only INSERTS a role that doesn't exist yet by key, it never
-- re-syncs an existing one. Pure data — `access_rules.resource_type` is `text`, not
-- a Postgres enum, so there is no DDL here.
--
-- Without this backfill, every EXISTING org's Member role (and any custom role
-- someone built with the same shape) loses the ability to see org settings, fields,
-- file buckets, the global task/note lists and the member roster the moment this
-- ships — silently, org-wide, with no rule anywhere to explain it. That is exactly
-- the hazard the phase plan warned about.
--
-- Targets any BLANKET (resource_id/concept_id/condition all null) allow rule on one
-- of the six types whose actions overlap create/edit/archive/share (or already hold
-- `*`, which already implies view — the NOT EXISTS below catches that case too, so
-- a full-access role is correctly left alone) and grants `view` alongside it, unless
-- that (org, role, resource_type) already has one. `WHERE NOT EXISTS` makes it safe
-- to re-run.
INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type)
SELECT DISTINCT r.org_id, r.role_id, 'allow', ARRAY['view'], r.resource_type
  FROM access_rules r
 WHERE r.resource_type IN ('org', 'field', 'bucket', 'task', 'note', 'member')
   AND r.effect = 'allow'
   AND r.resource_id IS NULL AND r.concept_id IS NULL AND r.condition IS NULL
   AND r.role_id IS NOT NULL
   AND (r.actions && ARRAY['create', 'edit', 'archive', 'share', '*'])
   AND NOT EXISTS (
     SELECT 1 FROM access_rules v
      WHERE v.org_id = r.org_id AND v.role_id = r.role_id
        AND v.resource_type = r.resource_type AND v.effect = 'allow'
        AND v.resource_id IS NULL AND v.concept_id IS NULL AND v.condition IS NULL
        AND (v.actions && ARRAY['view', '*'])
   );--> statement-breakpoint

-- Bump every affected org's policy generation so a running process picks this up
-- immediately rather than serving a cached (and now wrong) resolved policy.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
