import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AccessDefaultsService } from "../services/AccessDefaultsService"
import { AccessRoleService } from "../services/AccessRoleService"
import { ConceptService } from "../services/ConceptService"
import { PolicyService } from "../services/PolicyService"
import { newOrgId, testLayer } from "./harness"

/**
 * ── THE CREATION TEMPLATE ────────────────────────────────────────────────────
 *
 * `access_defaults` says what a NEWLY created resource grants each role. It is
 * copied into real rules at create time and is never consulted afterwards.
 *
 * The tests below exist because the tempting shortcut — "just read the template
 * when no rule matches" — silently restores the two-layer model this replaced, and
 * with it the "Inherit" state the permissions grid had to show. Nothing about the
 * app would look broken; the grid would just start lying again.
 */
describe("access defaults — the creation template", () => {
  const ACTOR = "user-tpl"

  /**
   * THE NOT-A-RULE GUARD. A resolved policy must be byte-identical before and
   * after a template is written. If this fails, someone has made `PolicyService`
   * read `access_defaults` and the second layer is back.
   */
  it.effect("a template row never reaches a resolved policy", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const defaults = yield* AccessDefaultsService
      const policies = yield* PolicyService

      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")
      yield* roles.assign(member!.id, ACTOR)

      const before = yield* policies.resolve(org, ACTOR)
      yield* defaults.set({
        roleId: member!.id,
        resourceType: "concept",
        actions: ["view", "edit", "delete"],
      })
      const after = yield* policies.resolve(org, ACTOR)

      expect(after.rules.length).toBe(before.rules.length)
      expect(JSON.stringify(after.rules)).toBe(JSON.stringify(before.rules))
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("creating a concept copies the template into real per-resource rules", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const defaults = yield* AccessDefaultsService
      const concepts = yield* ConceptService
      const sql = yield* PgClient.PgClient

      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")
      yield* defaults.set({
        roleId: member!.id,
        resourceType: "concept",
        actions: ["view", "edit"],
      })

      const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })

      const rows = yield* sql<{ readonly actions: ReadonlyArray<string> }>`
        SELECT actions FROM access_rules
        WHERE org_id = ${org} AND role_id = ${member!.id}
          AND resource_type = 'concept' AND resource_id = ${concept.id}`
      expect(rows.length).toBe(1)
      expect([...rows[0]!.actions].sort()).toEqual(["edit", "view"])
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  /**
   * A record rule is scoped by CONTAINER — `concept_id` set, `resource_id` null,
   * meaning "records in this concept". Writing it to the wrong column would make it
   * a rule about a single record whose id happens to equal a concept id.
   */
  it.effect("the record template is scoped by concept, not by resource id", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const defaults = yield* AccessDefaultsService
      const concepts = yield* ConceptService
      const sql = yield* PgClient.PgClient

      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")
      yield* defaults.set({ roleId: member!.id, resourceType: "record", actions: ["view"] })

      const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })

      const rows = yield* sql<{
        readonly resource_id: string | null
        readonly concept_id: string | null
      }>`
        SELECT resource_id, concept_id FROM access_rules
        WHERE org_id = ${org} AND role_id = ${member!.id} AND resource_type = 'record'
          AND concept_id = ${concept.id}`
      expect(rows.length).toBe(1)
      expect(rows[0]!.resource_id).toBeNull()
      expect(rows[0]!.concept_id).toBe(concept.id)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  /**
   * THE FULL-ACCESS EXEMPTION. Owner/admin/automation_full hold `*`, which means
   * "every action, present and future". Materializing them into explicit rows would
   * freeze them at today's action list — so `materialize` must skip them.
   */
  it.effect("full-access roles are never materialized", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const concepts = yield* ConceptService
      const sql = yield* PgClient.PgClient

      yield* roles.ensureBuiltins
      const admin = yield* roles.getByKey("admin")
      const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })

      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*)::int AS n FROM access_rules
        WHERE org_id = ${org} AND role_id = ${admin!.id} AND resource_id = ${concept.id}`
      expect(rows[0]!.n).toBe(0)
      // …and the blanket `*` it relies on is still there, untouched.
      const blanket = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*)::int AS n FROM access_rules
        WHERE org_id = ${org} AND role_id = ${admin!.id}
          AND resource_type = 'concept' AND resource_id IS NULL AND '*' = ANY(actions)`
      expect(blanket[0]!.n).toBe(1)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  /**
   * Orphan cleanup. `access_rules.resource_id` has no foreign key — it points at any
   * of five tables — so nothing but this reclaims rows for a deleted resource, and
   * once every resource carries one per role they would load into every resolved
   * policy forever.
   */
  it.effect("deleting a concept takes its per-resource rules with it", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const defaults = yield* AccessDefaultsService
      const concepts = yield* ConceptService
      const sql = yield* PgClient.PgClient

      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")
      yield* defaults.set({ roleId: member!.id, resourceType: "concept", actions: ["view"] })
      yield* defaults.set({ roleId: member!.id, resourceType: "record", actions: ["view"] })

      const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })
      yield* concepts.purge(concept.id)

      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*)::int AS n FROM access_rules
        WHERE org_id = ${org}
          AND (resource_id = ${concept.id} OR concept_id = ${concept.id})`
      expect(rows[0]!.n).toBe(0)
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  /**
   * ── THE INVISIBLE-BY-DEFAULT GUARD ─────────────────────────────────────────
   *
   * A seeded template MUST grant `view`, or every concept created from then on is
   * unreadable by that role — forever, with nothing on screen to explain it.
   *
   * This is not hypothetical. The presets deliberately withhold a BLANKET `view`
   * (back when read access came from the `visibility` column, a blanket view rule
   * would outrank it — that is what THE BLANKET-VIEW GUARD pinned). Deriving the
   * template from those rules therefore produced a template with no `view` at all:
   * every EXISTING concept read Yes and every FUTURE one would have read No. The
   * permissions grid is what caught it, because the two rows disagreed on screen.
   */
  it.effect("the seeded template grants view, so new resources are not born invisible", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const defaults = yield* AccessDefaultsService
      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")

      const mine = (yield* defaults.list()).filter((d) => d.roleId === member!.id)
      for (const resourceType of ["concept", "record"] as const) {
        const t = mine.find((d) => d.resourceType === resourceType)
        expect(t, `no ${resourceType} template`).toBeDefined()
        expect(t!.actions, `${resourceType} template must grant view`).toContain("view")
      }
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })

  it.effect("so a concept created after seeding IS readable by that role", () => {
    const org = newOrgId()
    return Effect.gen(function* () {
      const roles = yield* AccessRoleService
      const concepts = yield* ConceptService
      const sql = yield* PgClient.PgClient
      yield* roles.ensureBuiltins
      const member = yield* roles.getByKey("member")

      const concept = yield* concepts.create({ name: `Deal ${randomUUID().slice(0, 8)}` })

      const rows = yield* sql<{ readonly actions: ReadonlyArray<string> }>`
        SELECT actions FROM access_rules
        WHERE org_id = ${org} AND role_id = ${member!.id}
          AND resource_type = 'concept' AND resource_id = ${concept.id}`
      expect(rows.length).toBe(1)
      expect(rows[0]!.actions).toContain("view")
    }).pipe(Effect.provide(testLayer(org, ACTOR)))
  })
})
