import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import type { ACTION_ALL, AccessAction, AccessResourceType } from "../domain/access"
import { OrgContext } from "./OrgContext"
import { PolicyService } from "./PolicyService"

/**
 * ── THE CREATION TEMPLATE ────────────────────────────────────────────────────
 *
 * What a NEWLY created resource grants each role, and the machinery that copies it
 * into real rules the moment a concept, dashboard, view or automation is created.
 *
 * WHY THIS EXISTS. Access used to have two layers: a `visibility` column answering
 * "who sees this normally?", and `access_rules` as exceptions over it. That is why
 * every cell in the permissions grid had to carry an "Inherit" state — "no rule
 * here, something else decides". Collapsing to one layer means every (resource,
 * role) pair holds its own value, which in turn means something has to decide what
 * a brand-new resource starts with. That is this table.
 *
 * IT IS NOT A RULE. Nothing in `decide()` reads `access_defaults`, and nothing may
 * start: the instant it is consulted at request time it has become the second layer
 * again, and the grid goes back to needing "Inherit". `access-defaults.test.ts` pins
 * this by asserting a resolved `PolicySet` is unchanged by writing a template row.
 *
 * ── WHY DENY IS A REAL TEMPLATE, NOT JUST ABSENCE ────────────────────────────
 *
 * "Not allowed" is usually the ABSENCE of an allow — a role with no view template
 * for `concept` simply gets no rule on a newly created one, and the bottom-of-cascade
 * deny (P8) covers it. That is enough when the role has nothing else to say.
 *
 * It stops being enough once a role inherits (`based_on`) or is held alongside
 * another role that WOULD allow it: absence can't subtract from a tier at lower
 * precedence, only a deny in the role's OWN tier can (see `decide()`'s "the role's
 * own value always beats what it inherits"). A deny template materializes into a
 * targeted deny rule for that one role on that one new resource — the SAME shape an
 * admin could write by hand the moment after creation, just without the gap where
 * the resource sat allowed. Now that shares are gone (P0), there is no absolute-deny
 * hazard to guard against: this deny only ever competes within the tier it belongs
 * to, exactly like any other rule.
 */

/** The resource types that carry per-resource values (and so have a grid). The rest
 *  — task, note, member, role, org — keep their existing defaults and are edited
 *  as ordinary rules under "Other". */
export const TEMPLATED_TYPES: ReadonlyArray<AccessResourceType> = [
  "concept",
  "record",
  "dashboard",
  "view",
  "automation",
]

const isTemplated = (t: AccessResourceType): boolean => TEMPLATED_TYPES.includes(t)

/** One role's template for one resource type, ONE effect — a role may hold both an
 *  allow row and a deny row for the same type (different actions on each). */
export interface AccessDefault {
  readonly roleId: string
  readonly resourceType: AccessResourceType
  readonly effect: "allow" | "deny"
  readonly actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>
}

interface DefaultRow {
  readonly role_id: string
  readonly resource_type: string
  readonly effect: string
  readonly actions: ReadonlyArray<string>
}

export class AccessDefaultsService extends Effect.Service<AccessDefaultsService>()(
  "engine/AccessDefaultsService",
  {
    effect: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const policies = yield* PolicyService

      /** Every template row for the org, both effects (see the header). */
      const list = (): Effect.Effect<ReadonlyArray<AccessDefault>, never, OrgContext> =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<DefaultRow>`
            SELECT role_id, resource_type, effect, actions FROM access_defaults
            WHERE org_id = ${orgId}`
          return rows.map((r) => ({
            roleId: r.role_id,
            resourceType: r.resource_type as AccessResourceType,
            effect: r.effect as "allow" | "deny",
            actions: r.actions as ReadonlyArray<AccessAction>,
          }))
        }).pipe(Effect.orDie)

      /** Upsert-or-clear one (role, type, effect) template row. Empty `actions`
       *  deletes it — a delete rather than an empty array so the absent-means-nothing
       *  rule holds everywhere. */
      const setOne = (
        orgId: string,
        actor: string,
        roleId: string,
        resourceType: AccessResourceType,
        effect: "allow" | "deny",
        actions: ReadonlyArray<AccessAction | typeof ACTION_ALL>,
      ) =>
        actions.length === 0
          ? sql`
              DELETE FROM access_defaults
              WHERE org_id = ${orgId} AND role_id = ${roleId}
                AND resource_type = ${resourceType} AND effect = ${effect}`
          : sql`
              INSERT INTO access_defaults
                (org_id, role_id, resource_type, effect, actions, created_by)
              VALUES (${orgId}, ${roleId}, ${resourceType}, ${effect},
                      ${[...actions]}, ${actor})
              ON CONFLICT (role_id, resource_type, effect)
              DO UPDATE SET actions = EXCLUDED.actions, updated_at = now()`

      /**
       * Set one role's template for one type — allow and deny together, as the tri-
       * state default row edits them. Empty `allow` clears the allow side; empty
       * `deny` clears the deny side; either, both, or neither may be non-empty.
       */
      const set = (input: {
        readonly roleId: string
        readonly resourceType: AccessResourceType
        readonly allow: ReadonlyArray<AccessAction | typeof ACTION_ALL>
        readonly deny: ReadonlyArray<AccessAction | typeof ACTION_ALL>
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          yield* setOne(orgId, actor, input.roleId, input.resourceType, "allow", input.allow)
          yield* setOne(orgId, actor, input.roleId, input.resourceType, "deny", input.deny)
          // No policy bump: templates are not rules and no resolved PolicySet
          // contains them. Bumping here would invalidate every cached policy in the
          // org for a change that cannot affect a single decision.
        }).pipe(Effect.orDie)

      /**
       * THE HOOK. Copy the template into real rules for one just-created resource.
       *
       * MUST run inside the creating transaction. A crash between the INSERT and this
       * call leaves a resource with no rules at all — and once the fallback is
       * fail-closed, that resource is invisible to everyone except full-access roles,
       * including to the admin who created it and sees it working fine.
       *
       * `conceptId` is passed for `record`, whose rules are scoped by container
       * rather than by id — "records in this concept", `concept_id` set and
       * `resource_id` null.
       *
       * Full-access roles are skipped: they hold one blanket `allow ['*']` and are
       * exempt by design (see `access_roles.full_access`).
       */
      const materialize = (input: {
        readonly resourceType: AccessResourceType
        readonly resourceId?: string
        readonly conceptId?: string
        /**
         * Per-role overrides of the template's `view`, from a create form.
         *
         * Only `view` — that is the decision worth making while naming a thing, and a
         * create dialog listing every action for every role is a settings screen
         * wearing a disguise. Everything else comes from the template, so a role's
         * write access stays consistent with what it has elsewhere.
         */
        readonly viewFor?: ReadonlyArray<{ readonly roleId: string; readonly view: boolean }>
      }) =>
        Effect.gen(function* () {
          const { orgId, actor } = yield* OrgContext
          if (!isTemplated(input.resourceType)) return 0
          const rows = yield* sql<DefaultRow>`
            SELECT d.role_id, d.resource_type, d.effect, d.actions
            FROM access_defaults d
            JOIN access_roles r ON r.id = d.role_id
            WHERE d.org_id = ${orgId} AND d.resource_type = ${input.resourceType}
              AND r.full_access = false`
          const override = new Map((input.viewFor ?? []).map((v) => [v.roleId, v.view]))
          // Group by role: a role may hold both an allow row and a deny row for this
          // type, and the two must be resolved together — `want: true` from the
          // create form has to win over a deny template, not just add to an allow one
          // that may not exist.
          const byRole = new Map<
            string,
            { allow: ReadonlyArray<string>; deny: ReadonlyArray<string> }
          >()
          for (const r of rows) {
            const cur = byRole.get(r.role_id) ?? { allow: [], deny: [] }
            byRole.set(r.role_id, { ...cur, [r.effect]: r.actions })
          }
          // The override can name a role the template says nothing about at all —
          // still needs an entry, or "make this role able to view it" from the
          // create form would silently do nothing for a role with no template row.
          for (const roleId of override.keys()) {
            if (!byRole.has(roleId)) byRole.set(roleId, { allow: [], deny: [] })
          }
          let inserted = 0
          for (const [roleId, base] of byRole) {
            const want = override.get(roleId)
            // `want: true` overrides the deny side too — an explicit "this role may
            // view it" in the create form beats a deny template the same way it adds
            // to an allow one.
            const deny = want === true ? base.deny.filter((a) => a !== "view") : base.deny
            const allow =
              want === undefined
                ? base.allow
                : want
                  ? [...new Set([...base.allow, "view"])]
                  : base.allow.filter((a) => a !== "view")
            for (const [effect, actions] of [
              ["allow", allow],
              ["deny", deny],
            ] as const) {
              // A role left with nothing on this side gets no rule at all — absence
              // IS "no", on both sides.
              if (actions.length === 0) continue
              yield* sql`
                INSERT INTO access_rules
                  (org_id, role_id, effect, actions, resource_type, resource_id,
                   concept_id, created_by)
                VALUES (${orgId}, ${roleId}, ${effect}, ${[...actions]},
                        ${input.resourceType}, ${input.resourceId ?? null},
                        ${input.conceptId ?? null}, ${actor})`
              inserted++
            }
          }
          if (inserted > 0) yield* policies.bump(orgId)
          return inserted
        }).pipe(Effect.orDie)

      /**
       * Drop every per-resource rule naming a resource that is going away.
       *
       * `access_rules.resource_id` has no foreign key and cannot have one — it points
       * at any of five tables. So orphans are silent and permanent, and once every
       * resource carries a row per role they accumulate into every resolved policy
       * forever. Call this on every delete path.
       */
      const forget = (input: {
        readonly resourceType: AccessResourceType
        readonly resourceId?: string
        readonly conceptId?: string
      }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          if (input.resourceId) {
            yield* sql`
              DELETE FROM access_rules
              WHERE org_id = ${orgId} AND resource_type = ${input.resourceType}
                AND resource_id = ${input.resourceId}`
          }
          if (input.conceptId) {
            yield* sql`
              DELETE FROM access_rules
              WHERE org_id = ${orgId} AND resource_type = ${input.resourceType}
                AND concept_id = ${input.conceptId} AND resource_id IS NULL`
          }
          yield* policies.bump(orgId)
        }).pipe(Effect.orDie)

      return { list, set, materialize, forget } as const
    }),
    dependencies: [PolicyService.Default],
  },
) {}
