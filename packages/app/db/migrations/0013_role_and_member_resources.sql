-- `role` and `member` become real resource types: role/rule editing and the member
-- roster are now gated on `configure` against their OWN resource, not blanket
-- org-`configure`. Pure data — `access_rules.resource_type` is `text`, not a
-- Postgres enum, so there is no DDL here.
--
-- Whoever held `allow *` on `org` held `configure` on org, which is what these
-- thirteen role/rule handlers and the two member-roster routes used to gate on.
-- Without this backfill, that grant stops reaching them the moment the code ships —
-- Admin (and any custom role someone built with the same blanket wildcard; nothing
-- stopped that, `org` is not a templated type) would silently lose the Roles page
-- and the ability to add or remove members.
--
-- Mirrors exactly what `AccessRoleService.ensureBuiltins` writes for a wildcard
-- role: org_id, role_id, effect, actions, resource_type only — no resource_id,
-- concept_id, condition or created_by, because this is a template grant, not
-- something a person did. `WHERE NOT EXISTS` makes it safe to re-run.
INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type)
SELECT DISTINCT r.org_id, r.role_id, 'allow', ARRAY['*'], 'role'
  FROM access_rules r
 WHERE r.resource_type = 'org' AND r.effect = 'allow' AND r.actions @> ARRAY['*']
   AND r.role_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM access_rules x
      WHERE x.org_id = r.org_id AND x.role_id = r.role_id
        AND x.resource_type = 'role' AND x.effect = 'allow' AND x.actions @> ARRAY['*']
   );--> statement-breakpoint

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type)
SELECT DISTINCT r.org_id, r.role_id, 'allow', ARRAY['*'], 'member'
  FROM access_rules r
 WHERE r.resource_type = 'org' AND r.effect = 'allow' AND r.actions @> ARRAY['*']
   AND r.role_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM access_rules x
      WHERE x.org_id = r.org_id AND x.role_id = r.role_id
        AND x.resource_type = 'member' AND x.effect = 'allow' AND x.actions @> ARRAY['*']
   );--> statement-breakpoint

-- Bump every affected org's policy generation so a running process picks this up
-- immediately rather than serving a cached (and now wrong) resolved policy.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
