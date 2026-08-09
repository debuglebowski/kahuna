-- THE CREATION TEMPLATE IS RETIRED. `access_defaults` said what a NEWLY created
-- concept/record/dashboard/view/automation would grant each role, and was copied
-- into real `access_rules` rows at the moment that resource was created.
--
-- It existed to answer a question untargeted rules could not: "what about the ones
-- that don't exist yet?" An untargeted rule answers it directly and always did —
-- `coversResource` matches a null `resource_id` against every resource of the type,
-- present and future. What was missing was a way to SHOW one, so the editor refused
-- to write them (`assertNotBlanketAllow`) and pointed people at a template instead.
--
-- The permissions pane's "All" row is that rule, and says so. With somewhere to draw
-- it, the template is a second mechanism for the same idea — one that reaches only
-- the future, silently leaving existing resources to a rule nobody wrote.
--
-- ── ORDER MATTERS ────────────────────────────────────────────────────────────
--
-- Convert BEFORE dropping. For most orgs the conversion is a no-op at request time:
-- materialization already stamped a per-resource rule onto everything created since
-- the template existed, so those grants are already real rules. What it preserves is
-- the half materialization was doing — the future-resource half — which after this
-- has no other home.
--
-- Member is the case that makes this load-bearing rather than tidy. Its preset
-- deliberately withheld a blanket `view`, and `ensureBuiltins` injected `view` into
-- the TEMPLATE instead. So on an existing org, "members can read concepts" lives in
-- this table and nowhere else. Dropping it first would leave every member of every
-- deployment able to see nothing, with no error to explain it.

-- One blanket rule per (role, type, effect). `NOT EXISTS` keeps it idempotent and
-- avoids a duplicate where a role already carries the equivalent rule — which is the
-- common case for everything except `view`.
INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT d.org_id, d.role_id, d.effect, d.actions, d.resource_type, 'system:migration-0020'
FROM access_defaults d
JOIN access_roles r ON r.id = d.role_id
WHERE r.full_access = false
  AND array_length(d.actions, 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.role_id = d.role_id
      AND x.resource_type = d.resource_type
      AND x.effect = d.effect
      AND x.resource_id IS NULL
      AND x.concept_id IS NULL
      AND x.condition IS NULL
      -- Only skip when the existing blanket rule already covers everything the
      -- template granted; a narrower one must still be widened.
      AND d.actions <@ x.actions
  );--> statement-breakpoint

-- Where a blanket rule exists but is NARROWER than the template it replaces, widen
-- it rather than adding a second row. This is the Member path: `allow ["create"]` on
-- concept becomes `allow ["create","view"]`, because the template carried the `view`
-- that made concepts readable at all.
UPDATE access_rules x
SET actions = (
  SELECT array_agg(DISTINCT a) FROM unnest(x.actions || d.actions) AS a
)
FROM access_defaults d
JOIN access_roles r ON r.id = d.role_id
WHERE x.role_id = d.role_id
  AND x.resource_type = d.resource_type
  AND x.effect = d.effect
  AND x.resource_id IS NULL
  AND x.concept_id IS NULL
  AND x.condition IS NULL
  AND r.full_access = false
  AND NOT (d.actions <@ x.actions);--> statement-breakpoint

-- Rules changed, so every org's memoized policy is stale.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();--> statement-breakpoint

DROP TABLE "access_defaults" CASCADE;
