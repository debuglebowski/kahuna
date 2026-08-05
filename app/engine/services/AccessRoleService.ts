import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { AccessAction, AccessCondition, AccessResourceType } from "../domain/access"
import { ACTION_ALL } from "../domain/access"
import { isAutomationActor } from "../domain/types"
import { BlanketRuleRefused, RoleKindMismatch } from "../errors"
import { TEMPLATED_TYPES } from "./AccessDefaultsService"
import { EventStore } from "./EventStore"
import { OrgContext } from "./OrgContext"
import { PolicyService } from "./PolicyService"

/** Which category a role belongs to, and therefore who may hold it. */
export type AccessRoleKind = "user" | "automation"

/** A role as the app sees it. `key` is non-null only for the seeded managed ones. */
export interface AccessRole {
  readonly id: string
  readonly key: string | null
  readonly name: string
  readonly description: string | null
  /** Seeded, so deletion is refused. Everything else about it stays editable. */
  readonly managed: boolean
  /** People or automations. Assignment refuses a mismatch. */
  readonly kind: AccessRoleKind
  /** New actors of this kind receive it. Any number of roles may carry this. */
  readonly autoAssign: boolean
  /** False ⇒ grants nothing and is not auto-assigned; assignments are kept. */
  readonly active: boolean
  /** Holds a blanket `*`; exempt from per-resource values. See `access_roles`. */
  readonly fullAccess: boolean
  readonly position: number
}

interface AccessRoleRow {
  readonly id: string
  readonly key: string | null
  readonly name: string
  readonly description: string | null
  readonly managed: boolean
  readonly kind: string
  readonly auto_assign: boolean
  readonly active: boolean
  readonly full_access: boolean
  readonly position: number
}

/** Every SELECT reads the same shape — one place to change when a column lands. */
const ROLE_COLUMNS =
  "id, key, name, description, managed, kind, auto_assign, active, full_access, position"

const toRole = (r: AccessRoleRow): AccessRole => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  managed: r.managed,
  // Fail toward the narrower category: an unrecognised value must not let an
  // automation role land on a person.
  kind: r.kind === "automation" ? "automation" : "user",
  autoAssign: r.auto_assign,
  active: r.active,
  fullAccess: r.full_access,
  position: r.position,
})

/** A rule to seed with a managed role. */
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
  readonly kind: AccessRoleKind
  /** Seeded with auto-assign on: new actors of this kind land here. */
  readonly autoAssign: boolean
  readonly rules: ReadonlyArray<RuleSpec>
}

/**
 * ── THE MANAGED ROLES ────────────────────────────────────────────────────────
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
 * behaviour: record version archive/restore is any member.
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
 * They are ordinary rows and fully editable. `managed` only means "seeded", which
 * buys them exactly one thing: deletion is refused, because the seed would put them
 * back. `active = false` is how one is turned off for good.
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

/**
 * There is deliberately NO `owner` role. Owner is a membership flag carrying an
 * unconditional bypass (`server/runtime.ts:sessionScope`) — a role of the same name
 * would be a second, EDITABLE source of truth for the one thing that must not be
 * editable, which is how an org locks itself out of itself.
 */
export const BUILTIN_ROLES: ReadonlyArray<RoleSpec> = [
  {
    key: "admin",
    name: "Admin",
    description: "Full access, including org configuration.",
    position: 1,
    kind: "user",
    autoAssign: false,
    rules: everything([ACTION_ALL]),
  },
  {
    key: "member",
    name: "Member",
    // No `view`: reading is governed by each resource's own default. See the
    // comment above — granting it here would override concept/field visibility.
    description: "Creates and edits; cannot configure or delete. Reads what is visible.",
    position: 2,
    kind: "user",
    // WHERE A NEW MEMBER LANDS. Not a hardcoded key anywhere — the flag is what the
    // join path reads, so an org can move it to a role of its own making.
    autoAssign: true,
    rules: everything(["create", "edit", "archive", "share"]),
  },
  {
    // The `automation` category exists so a bot role never sits among people roles
    // and can never be handed to a person (`assign` refuses the mismatch). Every new
    // automation starts here; narrowing one means pointing it at another automation
    // role instead of hand-writing rules.
    key: "automation_full",
    name: "Full access",
    description: "What automations and syncs had before access control: everything.",
    position: 3,
    kind: "automation",
    autoAssign: true,
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
            SELECT ${sql.unsafe(ROLE_COLUMNS)} FROM access_roles
            WHERE org_id = ${orgId} ORDER BY position ASC, name ASC`
          return rows.map(toRole)
        }).pipe(Effect.orDie)

      /** A managed role by its stable key, or null. The seed pins by this. */
      const getByKey = (key: string): Effect.Effect<AccessRole | null, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT ${sql.unsafe(ROLE_COLUMNS)} FROM access_roles
            WHERE org_id = ${orgId} AND key = ${key} LIMIT 1`
          return rows[0] ? toRole(rows[0]) : null
        }).pipe(Effect.orDie)

      /**
       * The roles a new actor of this kind should receive.
       *
       * Inactive ones are excluded: an off role must not be handed out, or
       * reactivating it would silently widen access for everyone who joined while it
       * was off. Returning an empty list is legitimate — the caller warns, it does
       * not invent a fallback.
       */
      const autoAssignFor = (
        kind: AccessRoleKind,
      ): Effect.Effect<ReadonlyArray<AccessRole>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT ${sql.unsafe(ROLE_COLUMNS)} FROM access_roles
            WHERE org_id = ${orgId} AND kind = ${kind}
              AND auto_assign = true AND active = true
            ORDER BY position ASC`
          return rows.map(toRole)
        }).pipe(Effect.orDie)

      /**
       * Seed the presets for this org. Idempotent per role key, so it is safe on
       * every provision and as a backfill over existing orgs.
       *
       * Keyed on the ROLE existing, not on the org having any roles: a later
       * release adding a preset must be able to add just that one.
       */
      const ensureBuiltins = Effect.gen(function* () {
        const { orgId, actor } = yield* OrgContext
        let seeded = 0
        for (const spec of BUILTIN_ROLES) {
          const existing = yield* getByKey(spec.key)
          if (existing) continue
          // A preset holding `*` is FULL ACCESS: it keeps one blanket rule per type
          // and is exempt from per-resource values, because `*` means "every action,
          // present and future" and materializing it would freeze the role at
          // today's action list. See `access_roles.full_access`.
          const fullAccess = spec.rules.some((r) => r.actions.includes(ACTION_ALL))
          const inserted = yield* sql<{ readonly id: string }>`
            INSERT INTO access_roles
              (org_id, key, name, description, managed, kind, auto_assign, full_access,
               position)
            VALUES (${orgId}, ${spec.key}, ${spec.name}, ${spec.description}, true,
                    ${spec.kind}, ${spec.autoAssign}, ${fullAccess}, ${spec.position})
            RETURNING id`
          const roleId = inserted[0]!.id
          // THE CREATION TEMPLATE for this preset: what a newly created concept,
          // dashboard, view or automation grants it. Full-access roles get none —
          // their blanket `*` already covers everything, materialized or not.
          //
          // `view` IS ADDED HERE and is not in the preset's rules. That is not an
          // oversight being papered over — the presets deliberately withhold a blanket
          // `view` (it used to outrank the `visibility` column, which is what THE
          // BLANKET-VIEW GUARD pinned). With the column gone, read access IS the rule,
          // so a template without `view` means every concept created from then on is
          // invisible to members, forever, with nothing on screen to explain it.
          if (!fullAccess) {
            for (const rule of spec.rules) {
              if (rule.effect !== "allow" || !TEMPLATED_TYPES.includes(rule.resourceType)) continue
              const actions = [...new Set<string>([...rule.actions, "view"])]
              yield* sql`
                INSERT INTO access_defaults
                  (org_id, role_id, resource_type, effect, actions, created_by)
                VALUES (${orgId}, ${roleId}, ${rule.resourceType}, 'allow',
                        ${actions}, ${actor})
                ON CONFLICT (role_id, resource_type, effect) DO NOTHING`
            }
          }
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

      /**
       * Give an actor a role. Idempotent (the pk is (role, actor)).
       *
       * ── THE KIND GUARD ───────────────────────────────────────────────────────
       *
       * An `automation` role may only land on an automation actor, and a `user` role
       * never may. Without this the category is decoration: a "Slack sync — Tickets
       * only" role could be handed to a person, and the Full access automation role —
       * which holds a blanket `*` — could be handed to anyone, from a dropdown, as a
       * privilege escalation with no rule written anywhere.
       *
       * An actor may hold ANY NUMBER of roles; this refuses the wrong category, not a
       * second role.
       */
      const assign = (roleId: string, actorId: string) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const rows = yield* sql<{ readonly kind: string; readonly name: string }>`
            SELECT kind, name FROM access_roles
            WHERE org_id = ${orgId} AND id = ${roleId} LIMIT 1`.pipe(Effect.orDie)
          const role = rows[0]
          if (role) {
            const wantsAutomation = role.kind === "automation"
            if (wantsAutomation !== isAutomationActor(actorId)) {
              return yield* Effect.fail(
                new RoleKindMismatch({
                  roleKind: wantsAutomation ? "automation" : "user",
                  message: wantsAutomation
                    ? `"${role.name}" is an automation role and can only be given to an automation.`
                    : `"${role.name}" is a people role and can't be given to an automation.`,
                }),
              )
            }
          }
          yield* sql`
            INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
            VALUES (${orgId}, ${roleId}, ${actorId}, ${actor})
            ON CONFLICT (role_id, actor_id) DO NOTHING`.pipe(Effect.orDie)
          yield* policies.bump(orgId).pipe(Effect.orDie)
        })

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
            SELECT r.id, r.key, r.name, r.description, r.managed, r.kind, r.auto_assign,
                   r.active, r.full_access, r.position
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

      /**
       * Give every holder of one role another role.
       *
       * What "turn this role off" needs to not be destructive: the holders are about
       * to lose its rules, and walking them one at a time from the client is N
       * round-trips with no atomicity — a half-moved set is a permissions bug.
       *
       * Both roles must be the same KIND, for the same reason `assign` checks it:
       * otherwise "replace this automation role with a people role" would hand a
       * blanket `*` to every automation, or land a bot role on a person.
       *
       * Additive and idempotent — someone who already holds the target keeps one row.
       */
      const reassignHolders = (fromId: string, toId: string) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string; readonly kind: string }>`
            SELECT id, kind FROM access_roles
            WHERE org_id = ${orgId} AND id IN (${fromId}, ${toId})`.pipe(Effect.orDie)
          const from = rows.find((r) => r.id === fromId)
          const to = rows.find((r) => r.id === toId)
          if (!from || !to) return 0
          if (from.kind !== to.kind) {
            return yield* Effect.fail(
              new RoleKindMismatch({
                roleKind: to.kind,
                message: "Those two roles are in different categories.",
              }),
            )
          }
          const moved = yield* sql<{ readonly actor_id: string }>`
            INSERT INTO access_role_actors (org_id, role_id, actor_id, created_by)
            SELECT ${orgId}, ${toId}, a.actor_id, ${actor}
              FROM access_role_actors a
             WHERE a.org_id = ${orgId} AND a.role_id = ${fromId}
            ON CONFLICT (role_id, actor_id) DO NOTHING
            RETURNING actor_id`.pipe(Effect.orDie)
          yield* policies.bump(orgId).pipe(Effect.orDie)
          return moved.length
        })

      // ── role CRUD ────────────────────────────────────────────────────────────

      /**
       * Create a role, optionally STARTING FROM another one.
       *
       * `key` stays null — only the seeded managed roles are pinned by key, so a
       * user-created role can be renamed and deleted freely.
       *
       * A brand-new role holds nothing, and with access fail-closed that means its
       * holders see nothing at all — which is safe but useless, and walking a grid of
       * every concept × every action before the role does anything is real work. So
       * the create flow offers a starting point.
       *
       * It is a SNAPSHOT, not a link: later changes to Member do not propagate to a
       * role started from it. The UI has to say so, or that is a guaranteed bug
       * report.
       *
       * `kind` is fixed at creation and never changes: flipping a people role to an
       * automation role would strand every person already holding it on the wrong side
       * of THE KIND GUARD.
       */
      const create = (input: {
        readonly name: string
        readonly description?: string | null
        readonly kind?: AccessRoleKind
        /** Copy this role's per-resource rules and creation templates. */
        readonly startFrom?: string | null
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          const max = yield* sql<{ readonly max: number | string | null }>`
            SELECT MAX(position) AS max FROM access_roles WHERE org_id = ${orgId}`
          const position = Number(max[0]?.max ?? -1) + 1
          const rows = yield* sql<AccessRoleRow>`
            INSERT INTO access_roles (org_id, key, name, description, managed, kind, position)
            VALUES (${orgId}, NULL, ${input.name.trim()}, ${input.description ?? null}, false,
                    ${input.kind ?? "user"}, ${position})
            RETURNING ${sql.unsafe(ROLE_COLUMNS)}`
          const role = toRole(rows[0]!)
          if (input.startFrom) {
            // Rules first, then templates: the new role sees what the source sees
            // today AND starts new resources the same way. Conditional rules copy
            // too — they are as much a part of "what this role is" as the rest.
            //
            // A full-access source is NOT copied wholesale: `full_access` is a
            // property of the role, and silently minting a second one from a name in
            // a dropdown is not something a create form should be able to do.
            yield* sql`
              INSERT INTO access_rules
                (org_id, role_id, effect, actions, resource_type, resource_id, concept_id,
                 condition, created_by)
              SELECT org_id, ${role.id}, effect, actions, resource_type, resource_id,
                     concept_id, condition, ${actor}
                FROM access_rules
               WHERE org_id = ${orgId} AND role_id = ${input.startFrom}`
            yield* sql`
              INSERT INTO access_defaults
                (org_id, role_id, resource_type, effect, actions, created_by)
              SELECT org_id, ${role.id}, resource_type, effect, actions, ${actor}
                FROM access_defaults
               WHERE org_id = ${orgId} AND role_id = ${input.startFrom}
              ON CONFLICT (role_id, resource_type, effect) DO NOTHING`
          }
          yield* events.append({
            subjectKind: "accessRole",
            subjectId: role.id,
            eventType: "AccessRoleCreated",
            payload: { _tag: "AccessRoleCreated", name: role.name } as never,
          })
          yield* policies.bump(orgId)
          return role
        }).pipe(Effect.orDie)

      /**
       * Rename / re-describe a role, and set its two switches.
       *
       * Managed roles are editable here too — they are ordinary rows, and `key` (not
       * the name) is what the seed pins by. `kind` is deliberately absent: see
       * `create`.
       */
      const update = (input: {
        readonly id: string
        readonly name?: string
        readonly description?: string | null
        readonly autoAssign?: boolean
        readonly active?: boolean
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            UPDATE access_roles
            SET name = COALESCE(${input.name?.trim() ?? null}, name),
                description = ${input.description === undefined ? sql`description` : input.description},
                auto_assign = COALESCE(${input.autoAssign ?? null}, auto_assign),
                active = COALESCE(${input.active ?? null}, active),
                updated_at = now()
            WHERE org_id = ${orgId} AND id = ${input.id}
            RETURNING ${sql.unsafe(ROLE_COLUMNS)}`
          const row = rows[0]
          if (!row) return null
          yield* events.append({
            subjectKind: "accessRole",
            subjectId: input.id,
            eventType: "AccessRoleRenamed",
            payload: { _tag: "AccessRoleRenamed", name: row.name } as never,
          })
          // `active` and `auto_assign` both change what a resolved policy contains, so
          // the generation has to move or the change lands only after the cache ages
          // out — which it never does, since it is keyed on the version.
          yield* policies.bump(orgId)
          return toRole(row)
        }).pipe(Effect.orDie)

      /**
       * Delete a role. Its rules and assignments go with it (ON DELETE CASCADE), so
       * every holder loses that access immediately; the history stays on the log.
       *
       * A MANAGED role is refused: the seed pins by `key`, so removing one would make
       * `ensureBuiltins` silently re-create it on the next provision and quietly
       * restore access someone deliberately removed. Turning one off is
       * `update({active: false})`, which is reversible and keeps its assignments.
       */
      const remove = (id: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<AccessRoleRow>`
            SELECT ${sql.unsafe(ROLE_COLUMNS)} FROM access_roles
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
      /**
       * ── THE BLANKET GUARD ────────────────────────────────────────────────────
       *
       * Refuse an untargeted ALLOW on a type that carries per-resource values.
       *
       * This replaces THE BLANKET-VIEW GUARD, which used to be a test asserting the
       * Member preset grants no blanket `view`. That test protected a real property —
       * read access is never granted wholesale by accident — and the property still
       * matters, but its old subject is gone: read access IS rules now, so a blanket
       * allow is no longer "outranking the visibility column", it is silently
       * granting every present AND FUTURE resource of that type, invisibly, in a way
       * no grid cell can show.
       *
       * The template (`access_defaults`) is how "new ones start allowed" is said, and
       * it is applied at creation where it can be seen. Full-access roles are exempt:
       * a blanket `*` is exactly what they are.
       *
       * Deny is unaffected — a blanket deny is a legitimate, and legible, hard block.
       */
      const assertNotBlanketAllow = (input: {
        readonly roleId: string
        readonly effect: "allow" | "deny"
        readonly resourceType: AccessResourceType
        readonly resourceId?: string | null
        readonly conceptId?: string | null
      }) =>
        Effect.gen(function* () {
          if (input.effect !== "allow") return
          if (input.resourceId || input.conceptId) return
          if (!TEMPLATED_TYPES.includes(input.resourceType)) return
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly full_access: boolean }>`
            SELECT full_access FROM access_roles
            WHERE org_id = ${orgId} AND id = ${input.roleId} LIMIT 1`
          if (rows[0]?.full_access) return
          return yield* Effect.fail(
            new BlanketRuleRefused({
              resourceType: input.resourceType,
              message:
                `A rule covering every ${input.resourceType} at once can't be shown in the ` +
                `grid. Set the default for new ones instead, or name a specific one.`,
            }),
          )
        })

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
          yield* assertNotBlanketAllow(input)
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
        })

      /**
       * Replace a rule in place.
       *
       * In place, NOT remove-then-add: the rule KEEPS ITS ID, so the audit trail stays
       * one subject with a history rather than a delete and an unrelated create, and a
       * concurrent reader never sees the moment where the rule doesn't exist.
       *
       * Every field is replaced, not merged — the editor always sends a complete rule,
       * and a partial update would make "clear the target" indistinguishable from
       * "leave the target alone".
       */
      const updateRule = (input: {
        readonly ruleId: string
        readonly effect: "allow" | "deny"
        readonly actions: ReadonlyArray<AccessAction>
        readonly resourceType: AccessResourceType
        readonly resourceId?: string | null
        readonly conceptId?: string | null
        readonly condition?: AccessCondition | null
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{ readonly id: string; readonly role_id: string | null }>`
            UPDATE access_rules
            SET effect = ${input.effect},
                actions = ${[...input.actions]},
                resource_type = ${input.resourceType},
                resource_id = ${input.resourceId ?? null},
                concept_id = ${input.conceptId ?? null},
                condition = ${input.condition ? JSON.stringify(input.condition) : null}::jsonb
            WHERE org_id = ${orgId} AND id = ${input.ruleId}
            RETURNING id, role_id`
          if (!rows[0]) return false
          yield* events.append({
            subjectKind: "accessRule",
            subjectId: input.ruleId,
            eventType: "AccessRuleUpdated",
            payload: {
              _tag: "AccessRuleUpdated",
              roleId: rows[0].role_id,
              effect: input.effect,
              actions: [...input.actions],
              resourceType: input.resourceType,
            } as never,
          })
          yield* policies.bump(orgId)
          return true
        }).pipe(Effect.orDie)

      /** One rule by id — the update path needs its BEFORE state for the floor check. */
      const getRule = (ruleId: string) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<{
            readonly id: string
            readonly role_id: string | null
            readonly effect: string
            readonly actions: ReadonlyArray<string>
            readonly resource_type: string
            readonly resource_id: string | null
          }>`
            SELECT id, role_id, effect, actions, resource_type, resource_id
            FROM access_rules WHERE org_id = ${orgId} AND id = ${ruleId} LIMIT 1`
          const r = rows[0]
          return r
            ? {
                id: r.id,
                roleId: r.role_id,
                effect: (r.effect === "allow" ? "allow" : "deny") as "allow" | "deny",
                actions: r.actions,
                resourceType: r.resource_type as AccessResourceType,
                resourceId: r.resource_id,
              }
            : null
        }).pipe(Effect.orDie)

      /**
       * Replace every TARGETED rule of one resource type on a role, in one transaction.
       *
       * This is what the permissions matrix writes. Setting a whole column means
       * touching every row, and doing that as N add/update/remove round-trips would be
       * both chatty and non-atomic — a half-applied column is a permissions bug, not a
       * cosmetic one. So the client sends the desired state and this reconciles.
       *
       * ONLY rules with a `resource_id` are replaced. Blanket rules (`resource_id IS
       * NULL`) are left alone: they are not represented in the grid, so treating their
       * absence from the payload as "delete them" would silently drop access the matrix
       * never showed. The UI surfaces them separately.
       *
       * `org` is refused outright — org-level configure is what the irreducible floor
       * protects, and it has no place in a per-record grid.
       */
      const setScopedRules = (input: {
        readonly roleId: string
        readonly resourceType: AccessResourceType
        /**
         * Which column the entry id lands in.
         *
         * "resource" — the record itself (a concept, a dashboard).
         * "concept"  — the CONTAINER. Used by the Records grid, whose rows are
         *              concepts but whose rules mean "records IN this concept", which
         *              the model expresses as `concept_id` with a null `resource_id`.
         *              The two are different grants over the same id and must not be
         *              written to the same column.
         */
        readonly scopeBy?: "resource" | "concept"
        readonly entries: ReadonlyArray<{
          readonly resourceId: string
          readonly allow: ReadonlyArray<AccessAction>
          readonly deny: ReadonlyArray<AccessAction>
        }>
      }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const { orgId, actor } = yield* OrgContext
              const byConcept = input.scopeBy === "concept"
              // Delete only the column this grid owns, so the concept-scoped and
              // resource-scoped grids over the same type never clobber each other.
              yield* byConcept
                ? sql`
                    DELETE FROM access_rules
                    WHERE org_id = ${orgId} AND role_id = ${input.roleId}
                      AND resource_type = ${input.resourceType}
                      AND concept_id IS NOT NULL AND resource_id IS NULL`
                : sql`
                    DELETE FROM access_rules
                    WHERE org_id = ${orgId} AND role_id = ${input.roleId}
                      AND resource_type = ${input.resourceType}
                      AND resource_id IS NOT NULL`
              for (const e of input.entries) {
                // One row per (record, effect), holding that effect's action set —
                // the shape the grid reads back cell by cell.
                for (const [effect, actions] of [
                  ["allow", e.allow],
                  ["deny", e.deny],
                ] as const) {
                  if (actions.length === 0) continue
                  yield* sql`
                    INSERT INTO access_rules
                      (org_id, role_id, effect, actions, resource_type, resource_id,
                       concept_id, created_by)
                    VALUES (${orgId}, ${input.roleId}, ${effect}, ${[...actions]},
                            ${input.resourceType},
                            ${byConcept ? null : e.resourceId},
                            ${byConcept ? e.resourceId : null},
                            ${actor})`
                }
              }
              yield* events.append({
                subjectKind: "accessRole",
                subjectId: input.roleId,
                eventType: "AccessRulesReplaced",
                payload: {
                  _tag: "AccessRulesReplaced",
                  resourceType: input.resourceType,
                  records: input.entries.length,
                } as never,
              })
              yield* policies.bump(orgId)
            }),
          )
          .pipe(Effect.orDie)

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
            JOIN access_roles ro ON ro.id = a.role_id AND ro.org_id = a.org_id
            JOIN access_rules r ON r.role_id = a.role_id AND r.org_id = a.org_id
            WHERE a.org_id = ${orgId}
              -- An inactive role grants nothing, so its holders are not holders.
              AND ro.active = true
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
        autoAssignFor,
        ensureBuiltins,
        assign,
        unassign,
        rolesOf,
        actorsOf,
        reassignHolders,
        create,
        update,
        remove,
        rulesOf: rulesOf,
        addRule,
        updateRule,
        setScopedRules,
        getRule,
        removeRule,
        configureHolders,
      } as const
    }),
    dependencies: [PolicyService.Default, EventStore.Default],
  },
) {}
