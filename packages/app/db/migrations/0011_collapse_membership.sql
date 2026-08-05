-- Membership collapses to `owner | member`; Admin becomes an ordinary access role.
--
-- Hand-written: `bauth_member.role` is BetterAuth's column and free text, so drizzle
-- has nothing to diff — but the DATA has to move or every admin silently loses the
-- access their tier used to grant.
--
-- Order matters. Assign the Admin access role FIRST, then demote: the reverse would
-- leave a window (and, if the second statement failed, a permanent state) in which
-- an administrator holds neither.
INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
SELECT m.organization_id, ro.id, m.user_id, 'system:migration-0011'
  FROM bauth_member m
  JOIN access_roles ro ON ro.org_id = m.organization_id AND ro.key = 'admin'
 WHERE m.role = 'admin'
ON CONFLICT (role_id, actor_id) DO NOTHING;--> statement-breakpoint

UPDATE bauth_member SET role = 'member' WHERE role = 'admin';--> statement-breakpoint

-- The Owner ACCESS role goes: owner is a membership flag with an unconditional
-- bypass (`sessionScope`), so a role carrying the same name is a second, editable
-- source of truth for the one thing that must not be editable.
--
-- Its assignments cascade. Nobody loses anything: an owner keeps the bypass, and a
-- non-owner who somehow held the role was holding a blanket `*` they should not have.
DELETE FROM access_roles WHERE key = 'owner';--> statement-breakpoint

-- Bump every org's policy generation — assignments changed, and the resolved-policy
-- cache is keyed on this. Without it a running process serves the old answer forever.
INSERT INTO access_policy_versions (org_id, version, updated_at)
SELECT DISTINCT org_id, 1, now() FROM access_roles
ON CONFLICT (org_id)
DO UPDATE SET version = access_policy_versions.version + 1, updated_at = now();
