-- ── RETIRE THE WILDCARD, AND CLOSE THE LAST OPEN FALLBACK ───────────────────
--
-- Two behaviour changes and four column drops. The ORDER of the statements matters:
-- every grant is written BEFORE the thing that made it unnecessary is taken away, so
-- there is no instant at which a role holds less than it did.
--
-- 1. `*` is gone from the model. It was held by exactly two seeded roles (Admin,
--    `automation_full`) and it was the only thing in the system that was not simply
--    a list of permissions — which meant the permissions editor could not represent
--    those two roles and disabled every control on them instead. Each `*` rule below
--    is expanded into the actions that resource type actually enforces (the same list
--    `ENFORCED_ACTIONS` seeds new orgs with), and then deleted.
--
-- 2. `AutomationService.allowed` stopped falling back to `true`. It was the last gate
--    where SILENCE GRANTED, so the same Inherit cell meant the opposite on that tab
--    from every other one. Reads were open to every member and writes were gated on
--    org-`configure` at the request boundary, so that is exactly what is granted here
--    — `view` to every role, and the three write actions to roles that hold
--    org-`configure`. Nobody loses an automation they could reach yesterday.
--
-- 3. Then the dead columns: `access_roles.full_access` (nothing can hold the wildcard
--    any more, so it has no meaning), `access_rules.actor_id` (a per-person share,
--    unread since sharing was removed), and `concepts.visibility` (not consulted at
--    request time since concept reads became rule-only).

-- ── 1. EXPAND EVERY WILDCARD ────────────────────────────────────────────────
-- One INSERT per resource type, each carrying that type's enforced actions and
-- preserving the rule's target and condition. `NOT EXISTS` keeps it idempotent and
-- avoids duplicating a grant the role already holds in the same shape.

INSERT INTO access_rules
  (org_id, role_id, actor_id, effect, actions, resource_type, resource_id, concept_id,
   condition, created_by)
SELECT w.org_id, w.role_id, w.actor_id, w.effect, e.actions, w.resource_type,
       w.resource_id, w.concept_id, w.condition, 'system:migration-0022'
FROM access_rules w
JOIN (VALUES
  ('org',        ARRAY['configure']),
  ('concept',    ARRAY['view','create','archive','delete','configure']),
  ('record',     ARRAY['view','create','edit']),
  ('dashboard',  ARRAY['view','create','edit','delete']),
  ('view',       ARRAY['view','create','edit','delete']),
  ('automation', ARRAY['view','edit','archive','delete']),
  ('task',       ARRAY['view','create']),
  ('note',       ARRAY['create']),
  ('member',     ARRAY['configure']),
  ('role',       ARRAY['configure'])
) AS e(resource_type, actions) ON e.resource_type = w.resource_type
WHERE '*' = ANY(w.actions)
  AND NOT EXISTS (
    SELECT 1 FROM access_rules x
    WHERE x.org_id = w.org_id
      AND x.role_id IS NOT DISTINCT FROM w.role_id
      AND x.resource_type = w.resource_type
      AND x.resource_id IS NOT DISTINCT FROM w.resource_id
      AND x.concept_id IS NOT DISTINCT FROM w.concept_id
      AND x.condition IS NOT DISTINCT FROM w.condition
      AND x.effect = w.effect
      AND x.actions = e.actions
  );--> statement-breakpoint

-- A wildcard on a resource type NOT in the list above covered nothing any gate reads,
-- so it is simply dropped with the rest.
DELETE FROM access_rules WHERE '*' = ANY(actions);--> statement-breakpoint

-- ── 2. GRANT WHAT THE AUTOMATION FALLBACK WAS PROVIDING ─────────────────────
-- Reads were open to everyone. Every role gets blanket automation `view`.

INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['view'], 'automation', 'system:migration-0022'
FROM access_roles r
WHERE NOT EXISTS (
  SELECT 1 FROM access_rules x
  WHERE x.role_id = r.id AND x.resource_type = 'automation'
    AND x.effect = 'allow' AND x.condition IS NULL
    AND x.resource_id IS NULL AND x.concept_id IS NULL
    AND 'view' = ANY(x.actions)
);--> statement-breakpoint

-- Writes were reachable by anyone holding org-`configure` (the RPC boundary gate,
-- which is unchanged). Those roles keep the write actions; nobody else gains them.
INSERT INTO access_rules (org_id, role_id, effect, actions, resource_type, created_by)
SELECT r.org_id, r.id, 'allow', ARRAY['edit','archive','delete'], 'automation',
       'system:migration-0022'
FROM access_roles r
WHERE EXISTS (
  SELECT 1 FROM access_rules g
  WHERE g.role_id = r.id AND g.resource_type = 'org'
    AND g.effect = 'allow' AND g.condition IS NULL
    AND g.resource_id IS NULL AND g.concept_id IS NULL
    AND 'configure' = ANY(g.actions)
) AND NOT EXISTS (
  SELECT 1 FROM access_rules x
  WHERE x.role_id = r.id AND x.resource_type = 'automation'
    AND x.effect = 'allow' AND x.condition IS NULL
    AND x.resource_id IS NULL AND x.concept_id IS NULL
    AND 'edit' = ANY(x.actions)
);--> statement-breakpoint

-- ── 3. STRIP THE DEAD ACTION ────────────────────────────────────────────────
-- `share` was a real action that not one call site anywhere decided. Rules left
-- holding nothing else are deleted rather than kept as empty grants.

UPDATE access_rules SET actions = array_remove(actions, 'share')
WHERE 'share' = ANY(actions);--> statement-breakpoint

DELETE FROM access_rules WHERE cardinality(actions) = 0;--> statement-breakpoint

-- ── 4. DROP THE DEAD COLUMNS ────────────────────────────────────────────────
-- Generated by drizzle-kit from the schema change; not hand-written.

ALTER TABLE "access_rules" DROP CONSTRAINT "access_rules_one_subject";--> statement-breakpoint
DROP INDEX "access_rules_actor_idx";--> statement-breakpoint
ALTER TABLE "access_roles" DROP COLUMN "full_access";--> statement-breakpoint
ALTER TABLE "access_rules" DROP COLUMN "actor_id";--> statement-breakpoint
ALTER TABLE "concepts" DROP COLUMN "visibility";--> statement-breakpoint

-- Every resolved policy in memory is now wrong. Bump so the very next request
-- rebuilds from these rows rather than a cached set built before them.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
