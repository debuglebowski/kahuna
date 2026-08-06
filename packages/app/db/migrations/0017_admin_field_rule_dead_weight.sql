-- Drops the seeded blanket `*` rule on `field` from every org's Admin and
-- automation_full roles. `AccessRoleService.ALL_RESOURCES` (the list
-- `everything()` stamps a wildcard rule across for these two presets) no
-- longer includes `field` — this backfills existing orgs the same way 0016
-- did for Member, since `ensureBuiltins` only ever INSERTS a role that
-- doesn't exist yet by key; it never re-syncs one that already exists.
--
-- Why the row was dead weight, not merely redundant: `scopeHiddenFieldIds`
-- (engine/domain/visibility.ts) hides a field by default unless the caller is
-- privileged (`canReadRestricted` — holds `configure` on `org`, which both
-- presets do via their OWN separate blanket `*` rule on `org`). A privileged
-- caller's default is an EMPTY hidden-set, so the per-field `decide()` call's
-- fallback is already `true` for every field before any `field`-typed rule is
-- even consulted. Removing this row changes nothing either preset can see.
--
-- Scoped narrowly, matching 0016's discipline:
--   - `key IN ('admin', 'automation_full')` — the two PRESETS by identity, not
--     "any role that happens to hold `full_access`" (283 orgs have these two
--     presets; only 200 currently have `full_access = true` set on them — a
--     separate, pre-existing data-quality gap unrelated to this change, not
--     addressed here).
--   - The row must still be BYTE-IDENTICAL to what the seed wrote (`effect =
--     'allow'`, `actions = ARRAY['*']`, blanket, no condition). `updateRule`
--     never touches `created_by`, so that column can't distinguish "never
--     touched" from "edited back to the same shape" — but a row an admin
--     deliberately changed to something ELSE (a deny, a narrower action list,
--     a target) no longer matches this shape and is left alone either way.
--
-- Pure data — `access_rules.resource_type` is `text`, not an enum, so there is
-- no DDL here.
DELETE FROM access_rules
 WHERE role_id IN (SELECT id FROM access_roles WHERE key IN ('admin', 'automation_full'))
   AND resource_type = 'field'
   AND effect = 'allow'
   AND actions = ARRAY['*']
   AND resource_id IS NULL AND concept_id IS NULL AND condition IS NULL;--> statement-breakpoint

-- Bump every affected org's policy generation so a running process picks this
-- up immediately rather than serving a cached (and now stale) resolved policy.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles WHERE key IN ('admin', 'automation_full')
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
