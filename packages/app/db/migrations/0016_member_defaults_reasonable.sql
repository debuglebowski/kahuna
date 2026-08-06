-- Rewrites the stock MEMBER role's stored rules (blanket `access_rules`) and
-- creation templates (`access_defaults`) across every existing org to match the
-- new curated `AccessRoleService.BUILTIN_ROLES` shape. `ensureBuiltins` only
-- seeds a role that doesn't exist yet by key, so it never re-syncs one that
-- already exists — this is the equivalent of the 0015 backfill, for a rewrite
-- instead of an addition.
--
-- Two problems in the old shape:
--   1. Most of it was dead weight — `create/edit/archive/share` granted uniformly
--      on all 12 resource types, when nothing anywhere decides most of those
--      combinations (org/role/member/automation ever, field for anything but
--      `view`). Harmless but misleading: the Roles page showed grants that did
--      nothing.
--   2. One of those dead-looking grants was dead for the wrong reason and is a
--      live bug: a blanket `view` rule on `field` (resource_id/concept_id both
--      null) matches every field unconditionally and outranks the per-field
--      fallback `scopeHiddenFieldIds` computes — silently defeating every
--      `admin`-visibility field for every ordinary member, org-wide.
--
-- Scoped to `access_roles.key = 'member'` specifically — the preset, not any
-- custom role an org built with a similar shape (including one cloned FROM
-- Member via "start from", which is now independently owned).
--
-- Only the BLANKET spec-level rows are touched (resource_id/concept_id/
-- condition all null) — never a per-resource rule materialized when an actual
-- concept/record/dashboard/etc. was created. Deleting those would make every
-- EXISTING resource invisible to Member; they are untouched here. Pure data —
-- `access_rules`/`access_defaults` columns are `text`/`text[]`, not enums, so
-- there is no DDL.

-- 1. Drop Member's old blanket access_rules rows.
DELETE FROM access_rules
 WHERE role_id IN (SELECT id FROM access_roles WHERE key = 'member')
   AND resource_id IS NULL AND concept_id IS NULL AND condition IS NULL;--> statement-breakpoint

-- 2. Re-insert the new blanket rows, one per (org, resource_type) that needs one.
INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type)
SELECT r.org_id, r.id, 'allow', v.actions, v.resource_type
  FROM access_roles r
  CROSS JOIN (
    VALUES
      ('concept',   ARRAY['create']),
      ('record',    ARRAY['create']),
      ('dashboard', ARRAY['edit']),
      ('view',      ARRAY['edit']),
      ('bucket',    ARRAY['create', 'view']),
      ('task',      ARRAY['create', 'view']),
      ('note',      ARRAY['create'])
  ) AS v(resource_type, actions)
 WHERE r.key = 'member';--> statement-breakpoint

-- 3. Drop Member's old creation templates (access_defaults) — concept/record/
--    dashboard/view/automation, the five TEMPLATED_TYPES.
DELETE FROM access_defaults
 WHERE role_id IN (SELECT id FROM access_roles WHERE key = 'member');--> statement-breakpoint

-- 4. Re-insert the new templates. Each already carries `view` unioned in —
--    the same union `AccessRoleService.ensureBuiltins` performs for a freshly
--    seeded org (`TEMPLATED_TYPES`'s injection) — so a concept/record/dashboard/
--    view created from now on stays visible to Member exactly as before.
--    `automation` gets none: Member could never reach it anyway (every
--    automation WRITE is admin-gated at the RPC boundary regardless of any
--    rule, and reads default OPEN — `AutomationService.allowed`'s
--    `fallback: true`), so a template there was always inert.
INSERT INTO access_defaults (org_id, role_id, resource_type, effect, actions, created_by)
SELECT r.org_id, r.id, v.resource_type, 'allow', v.actions, 'migration-0016'
  FROM access_roles r
  CROSS JOIN (
    VALUES
      ('concept',   ARRAY['create', 'view']),
      ('record',    ARRAY['create', 'view']),
      ('dashboard', ARRAY['edit', 'view']),
      ('view',      ARRAY['edit', 'view'])
  ) AS v(resource_type, actions)
 WHERE r.key = 'member';--> statement-breakpoint

-- Bump every affected org's policy generation so a running process picks this up
-- immediately rather than serving a cached (and now wrong) resolved policy.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles WHERE key = 'member'
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
