-- Field and bucket are no longer access-rule resource types at all (not just
-- removed from the Roles page's picker — `AccessResourceType` in
-- engine/domain/access.ts dropped both members outright). This backfills every
-- existing org to match:
--
--   `field` rules: already zero in dev (0017 cleaned up Admin/automation_full's
--   dead-weight blanket, and Member never held one after the member-defaults
--   pass) — included here anyway so a NON-dev database that skipped straight to
--   this migration still ends up clean, not just new ones going forward.
--
--   `bucket` rules: NOT dead weight before this — Member's `create`/`view` grant
--   was real (assertAllowed in use-cases.ts), and Admin/automation_full's
--   blanket `*` was the only thing giving them that same access. Both checks are
--   gone now: `uploadAttachment`/`listFiles` no longer consult a `bucket` rule at
--   all (P8's gate is removed, matching `DashboardService`'s existing "no admin
--   gate" precedent for create) — so every org's bucket rows are genuinely inert
--   the moment this migration and its matching code ship together, not before.
--
-- Every org is affected (bucket touched all three managed roles, not just the
-- two presets 0017 scoped to), so every org's policy generation is bumped —
-- unlike 0017's `WHERE key IN (...)` scoping, this DELETE has no shape filter:
-- a `field`/`bucket` rule of ANY shape (custom target, condition, deny) is
-- equally impossible to act on once the engine stops asking about that type.
DELETE FROM access_rules WHERE resource_type IN ('field', 'bucket');--> statement-breakpoint

INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();--> statement-breakpoint

-- The field-visibility flag has no per-role override left to defer to (the
-- DELETE above), no enforcement left to read it (scopeHiddenFieldIds/
-- hiddenFieldIds are gone from domain/visibility.ts), and no UI left to set it
-- (ConceptEditor's "Admins only" toggle is gone) — so the column goes too,
-- rather than surviving as an unread, unsettable ghost. This is genuine data
-- loss for the 12 dev fields it was set on (all seed/test "Salary" fields —
-- confirmed before this migration was written, none were real customer config).
ALTER TABLE "fields" DROP COLUMN "visibility";
