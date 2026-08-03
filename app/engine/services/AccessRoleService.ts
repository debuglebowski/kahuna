import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { AccessAction, AccessCondition, AccessResourceType } from "../domain/access"
import { ACTION_ALL } from "../domain/access"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { PolicyService } from "./PolicyService"

/** A role as the app sees it. `key` is non-null only for the seeded presets. */
export interface AccessRole {
  readonly id: string
  readonly key: string | null
  readonly name: string
  readonly description: string | null
  readonly builtin: boolean
  readonly position: number
}

interface AccessRoleRow {
  readonly id: string
  readonly key: string | null
  readonly name: string
  readonly description: string | null
  readonly builtin: boolean
  readonly position: number
}

const toRole = (r: AccessRoleRow): AccessRole => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  builtin: r.builtin,
  position: r.position,
})

/** A rule to seed with a preset role. */
interface RuleSpec {
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>
  readonly resourceType: AccessResourceType
}

interface RoleSpec {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly position: number
  readonly rules: ReadonlyArray<RuleSpec>
}

/**
 * ── THE PRESETS ──────────────────────────────────────────────────────────────
 *
 * These reproduce today's behaviour EXACTLY, which is the whole point of seeding
 * them before anything consults them: `server/policy.ts:can()` currently says a
 * member reads and writes everything while owner/admin can additionally
 * administer. So:
 *
 *   owner / admin → everything, `configure` included
 *   member        → write actions, but not `configure` or `delete`
 *
 * `delete` is withheld from `member` because hard-delete is already admin-gated at
 * the RPC boundary today (see the `admin<>()` handlers) — granting it here would
 * be a widening, not a reproduction. `archive` IS granted, which is also today's
 * behaviour: instance archive/restore is any member.
 *
 * ── WHY `member` DOES NOT GRANT `view` ───────────────────────────────────────
 *
 * Read access is the DEFAULT LAYER's job — the `visibility` column. Rules are
 * exceptions layered over it, so a rule granting `view` on every concept
 * (`resource_id = null`) would OUTRANK the column and hand members every
 * `admin`-visibility concept, silently undoing concept and field visibility.
 *
 * So the presets grant write actions only, and `view` appears in a rule solely as
 * a deliberate exception: a share of one record, a role opening one restricted
 * concept, or a deny. `owner`/`admin` still hold `*`, which is correct — they can
 * read restricted material today.
 *
 * `access.test.ts` pins this ("the member preset must not grant blanket view").
 * Do not "complete" the member preset by adding `view` to it.
 *
 * They are ordinary rows and fully editable. `builtin` only means "seeded".
 */
const ALL_RESOURCES: ReadonlyArray<AccessResourceType> = [
  "org",
  "concept",
  "record",
  "field",
  "dashboard",
  "view",
  "automation",
  "bucket",
  "task",
  "note",
  "member",
]

const everything = (
  actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>,
): ReadonlyArray<RuleSpec> =>
  ALL_RESOURCES.map((resourceType) => ({ effect: "allow" as const, actions, resourceType }))

export const BUILTIN_ROLES: ReadonlyArray<RoleSpec> = [
  {
    key: "owner",
    name: "Owner",
    description: "Full access, including org configuration.",
    position: 0,
    rules: everything([ACTION_ALL]),
  },
  {
    key: "admin",
    name: "Admin",
    description: "Full access, including org configuration.",
    position: 1,
    rules: everything([ACTION_ALL]),
  },
  {
    key: "member",
    name: "Member",
    // No `view`: reading is governed by each resource's own default. See the
    // comment above — granting it here would override concept/field visibility.
    description: "Creates and edits; cannot configure or delete. Reads what is visible.",
    position: 2,
    rules: everything(["create", "edit", "archive", "share"]),
  },
  {
    // Existing automations migrate onto this, so nothing changes behaviour the day
    // access control ships. Scoping an automation down is then an opt-in per
    // automation — see the access-control artifact.
    key: "automation_full",
    name: "Automation (full access)",
    description: "What automations and syncs had before access control: everything.",
    position: 3,
    rules: everything([ACTION_ALL]),
  },
]

/**
 * Roles, their rules, and who holds them.
 *
 * Every write bumps the org's policy generation via `PolicyService.bump`, so a
 * change lands on the very next request without a TTL or a cache flush.
 */
export class AccessRoleService extends Effect.Service<AccessRoleService>()(
  "engine/AccessRoleService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const policies = yield* PolicyService
      const events = yield* EventStore

      const list = (): Effect.Effect<ReadonlyArray<AccessRole>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT id, key, name, description, builtin, position FROM access_roles
            WHERE org_id = ${orgId} ORDER BY position ASC, name ASC`
          return rows.map(toRole)
        }).pipe(Effect.orDie)

      /** A preset by its stable key, or null. The migration/backfill pins by this. */
      const getByKey = (key: string): Effect.Effect<AccessRole | null, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT id, key, name, description, builtin, position FROM access_roles
            WHERE org_id = ${orgId} AND key = ${key} LIMIT 1`
          return rows[0] ? toRole(rows[0]) : null
        }).pipe(Effect.orDie)

      /**
       * Seed the presets for this org. Idempotent per role key, so it is safe on
       * every provision and as a backfill over existing orgs.
       *
       * Keyed on the ROLE existing, not on the org having any roles: a later
       * release adding a preset must be able to add just that one.
       */
      const ensureBuiltins = Effect.gen(function* () {
        const { orgId } = yield* OrgContext
        let seeded = 0
        for (const spec of BUILTIN_ROLES) {
          const existing = yield* getByKey(spec.key)
          if (existing) continue
          const inserted = yield* sql<{ readonly id: string }>`
            INSERT INTO access_roles (org_id, key, name, description, builtin, position)
            VALUES (${orgId}, ${spec.key}, ${spec.name}, ${spec.description}, true, ${spec.position})
            RETURNING id`
          const roleId = inserted[0]!.id
          for (const rule of spec.rules) {
            // The array is passed RAW, not through `sql.json`: `actions` is a
            // `text[]` column, and the driver serializes a JS array as a Postgres
            // array literal — which is precisely what breaks jsonb writes and is
            // exactly right here.
            yield* sql`
              INSERT INTO access_rules
                (org_id, role_id, effect, actions, resource_type)
              VALUES (${orgId}, ${roleId}, ${rule.effect},
                      ${[...rule.actions]}, ${rule.resourceType})`
          }
          seeded++
        }
        if (seeded > 0) yield* policies.bump(orgId)
        return seeded
      }).pipe(Effect.orDie)

      /** Give an actor a role. Idempotent (the pk is (role, actor)). */
      const assign = (roleId: string, actorId: string) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          yield* sql`
            INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
            VALUES (${orgId}, ${roleId}, ${actorId}, ${actor})
            ON CONFLICT (role_id, actor_id) DO NOTHING`
          yield* policies.bump(orgId)
        }).pipe(Effect.orDie)

      const unassign = (roleId: string, actorId: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          yield* sql`
            DELETE FROM access_role_actors
            WHERE org_id = ${orgId} AND role_id = ${roleId} AND actor_id = ${actorId}`
          yield* policies.bump(orgId)
        }).pipe(Effect.orDie)

      /** Which roles an actor holds. */
      const rolesOf = (
        actorId: string,
      ): Effect.Effect<ReadonlyArray<AccessRole>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT r.id, r.key, r.name, r.description, r.builtin, r.position
            FROM access_roles r
            JOIN access_role_actors a ON a.role_id = r.id AND a.org_id = r.org_id
            WHERE r.org_id = ${orgId} AND a.actor_id = ${actorId}
            ORDER BY r.position ASC, r.name ASC`
          return rows.map(toRole)
        }).pipe(Effect.orDie)

      /** Who holds a role — for the members page and the last-owner floor check. */
      const actorsOf = (roleId: string): Effect.Effect<ReadonlyArray<string>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly actor_id: string }>`
            SELECT actor_id FROM access_role_actors
            WHERE org_id = ${orgId} AND role_id = ${roleId} ORDER BY created_at ASC`
          return rows.map((r) => r.actor_id)
        }).pipe(Effect.orDie)

      // ── role CRUD ────────────────────────────────────────────────────────────

      /**
       * Create a custom role. `key` stays null — only the seeded presets are pinned by
       * key, so a user-created role can be renamed freely.
       */
      const create = (input: { readonly name: string; readonly description?: string | null }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const max = yield* sql<{ readonly max: number | string | null }>`
            SELECT MAX(position) AS max FROM access_roles WHERE org_id = ${orgId}`
          const position = Number(max[0]?.max ?? -1) + 1
          const rows = yield* sql<AccessRoleRow>`
            INSERT INTO access_roles (org_id, key, name, description, builtin, position)
            VALUES (${orgId}, NULL, ${input.name.trim()}, ${input.description ?? null}, false, ${position})
            RETURNING id, key, name, description, builtin, position`
          const role = toRole(rows[0]!)
          yield* events.append({
            subjectKind: "accessRole",
            subjectId: role.id,
            eventType: "AccessRoleCreated",
            payload: { _tag: "AccessRoleCreated", name: role.name } as never,
          })
          yield* policies.bump(orgId)
          return role
        }).pipe(Effect.orDie)

      /** Rename / re-describe a role. Presets are renameable too — they are ordinary
       *  rows, and `key` (not the name) is what code pins by. */
      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly description?: string | null
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            UPDATE access_roles
            SET name = COALESCE(${input.name?.trim() ?? null}, name),
                description = ${input.description === undefined ? sql`description` : input.description},
                updated_at = now()
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING id, key, name, description, builtin, position`
          const row = rows[0]
          if (!row) return null
          yield* events.append({
            subjectKind: "accessRole",
            subjectId: input.id,
            eventType: "AccessRoleRenamed",
            payload: { _tag: "AccessRoleRenamed", name: row.name } as never,
          })
          yield* policies.bump(orgId)
          return toRole(row)
        }).pipe(Effect.orDie)

      /**
       * Delete a role. Its rules and assignments go with it (ON DELETE CASCADE), so
       * every holder loses that access immediately; the history stays on the log.
       *
       * A PRESET is refused: the seed and the backfill pin by `key`, so removing one
       * would make `ensureBuiltins` silently re-create it on the next provision and
       * quietly restore access someone deliberately removed.
       */
      const remove = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT id, key, name, description, builtin, position FROM access_roles
            WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`
          const row = rows[0]
          if (!row) return "not-found" as const
          if (row.key !== null) return "builtin" as const
          yield* sql`DELETE FROM access_roles WHERE org_id = ${orgId} AND id = ${id}`
          yield* events.append({
            subjectKind: "accessRole",
            subjectId: id,
            eventType: "AccessRoleDeleted",
            payload: { _tag: "AccessRoleDeleted", name: row.name } as never,
          })
          yield* policies.bump(orgId)
          return "deleted" as const
        }).pipe(Effect.orDie)

      // ── rules on a role ──────────────────────────────────────────────────────

      /** The rules a role carries — what the role editor lists. */
      const rulesOf = (roleId: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{
            readonly id: string
            readonly effect: string
            readonly actions: ReadonlyArray<string>
            readonly resource_type: string
            readonly resource_id: string | null
            readonly concept_id: string | null
            readonly condition: unknown
          }>`
            SELECT id, effect, actions, resource_type, resource_id, concept_id, condition
            FROM access_rules
            WHERE org_id = ${orgId} AND role_id = ${roleId}
            ORDER BY resource_type ASC, created_at ASC`
          return rows.map((r) => ({
            id: r.id,
            effect: (r.effect === "allow" ? "allow" : "deny") as "allow" | "deny",
            actions: r.actions,
            resourceType: r.resource_type as AccessResourceType,
            resourceId: r.resource_id,
            conceptId: r.concept_id,
            condition: r.condition as AccessCondition | null,
          }))
        }).pipe(Effect.orDie)

      /** Add a rule to a role. */
      const addRule = (input: {
        readonly roleId: string
        readonly effect: "allow" | "deny"
        readonly actions: ReadonlyArray<AccessAction>
        readonly resourceType: AccessResourceType
        readonly resourceId?: string | null
        readonly conceptId?: string | null
        readonly condition?: AccessCondition | null
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string }>`
            INSERT INTO access_rules
              (org_id, role_id, effect, actions, resource_type, resource_id, concept_id,
               condition, created_by)
            VALUES (${orgId}, ${input.roleId}, ${input.effect}, ${[...input.actions]},
                    ${input.resourceType}, ${input.resourceId ?? null},
                    ${input.conceptId ?? null},
                    ${input.condition ? JSON.stringify(input.condition) : null}::jsonb,
                    ${actor})
            RETURNING id`
          const id = rows[0]!.id
          yield* events.append({
            subjectKind: "accessRule",
            subjectId: id,
            eventType: "AccessRuleAdded",
            payload: {
              _tag: "AccessRuleAdded",
              roleId: input.roleId,
              effect: input.effect,
              actions: [...input.actions],
              resourceType: input.resourceType,
            } as never,
          })
          yield* policies.bump(orgId)
          return { id }
        }).pipe(Effect.orDie)

      /** Remove one rule from a role. Idempotent. */
      const removeRule = (ruleId: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly role_id: string | null }>`
            DELETE FROM access_rules WHERE org_id = ${orgId} AND id = ${ruleId}
            RETURNING role_id`
          if (!rows[0]) return false
          yield* events.append({
            subjectKind: "accessRule",
            subjectId: ruleId,
            eventType: "AccessRuleRemoved",
            payload: { _tag: "AccessRuleRemoved", roleId: rows[0].role_id } as never,
          })
          yield* policies.bump(orgId)
          return true
        }).pipe(Effect.orDie)

      /**
       * ── THE IRREDUCIBLE FLOOR ────────────────────────────────────────────────
       *
       * Would this change leave the org with NOBODY able to `configure` it?
       *
       * Presets are fully editable — that is the design — but an org that can no longer
       * be administered is bricked with no in-app recovery. So the one thing that
       * cannot be removed is the last holder of org `configure`. Mirrors the last-owner
       * lock that already guards member demotion and deactivation.
       *
       * Deliberately computed from the RULES rather than from membership roles: once
       * presets are editable, "is an owner" no longer implies "can configure".
       */
      const configureHolders = () =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly actor_id: string }>`
            SELECT DISTINCT a.actor_id
            FROM access_role_actors a
            JOIN access_rules r ON r.role_id = a.role_id AND r.org_id = a.org_id
            WHERE a.org_id = ${orgId}
              AND r.effect = 'allow'
              AND (r.resource_type = 'org' OR r.resource_id IS NULL)
              AND ('configure' = ANY(r.actions) OR '*' = ANY(r.actions))
              -- A human, not an automation or connector: a bot holding configure does
              -- not keep the org administrable by a person.
              AND a.actor_id NOT LIKE 'system:%'`
          return rows.map((r) => r.actor_id)
        }).pipe(Effect.orDie)

      return {
        list,
        getByKey,
        ensureBuiltins,
        assign,
        unassign,
        rolesOf,
        actorsOf,
        create,
        update,
        remove,
        rulesOf: rulesOf,
        addRule,
        removeRule,
        configureHolders,
      } as const
    }),
    dependencies: [PolicyService.Default, EventStore.Default],
  },
) {}
