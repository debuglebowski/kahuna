import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AUTOMATION_ACTOR_PREFIX, BUILTIN_ROLES } from "#engine"

/**
 * The backfill script (`scripts/backfill-access-roles.ts`) writes preset roles with
 * raw SQL across every org, because `AccessRoleService.ensureBuiltins` is scoped to
 * one OrgContext. Two implementations of the same seed, so they can drift — and a
 * drift means existing orgs get different access than new ones, which is the kind of
 * bug nobody finds until someone can't see their data.
 *
 * These assertions pin the script's tables to `BUILTIN_ROLES`. They read the source
 * text rather than importing it, because the script connects to a database and runs
 * on import.
 */

const source = readFileSync(
  path.join(import.meta.dirname, "..", "scripts", "backfill-access-roles.ts"),
  "utf8",
)

describe("access backfill matches the seed", () => {
  it("covers exactly the preset role keys, with the same actions", () => {
    for (const role of BUILTIN_ROLES) {
      expect(source, `preset "${role.key}" missing from the backfill`).toContain(
        `key: "${role.key}"`,
      )
      // Every rule in a preset carries the same action list (see `everything`), so
      // the first one is representative.
      const actions = role.rules[0]!.actions
      const rendered = actions.map((a) => `"${a}"`).join(", ")
      expect(source, `preset "${role.key}" actions differ from BUILTIN_ROLES`).toContain(rendered)
    }
  })

  it("seeds no role the presets don't define", () => {
    const keys = new Set(BUILTIN_ROLES.map((r) => r.key))
    for (const m of source.matchAll(/key: "([a-z_]+)"/g))
      expect(keys, `backfill seeds unknown role "${m[1]}"`).toContain(m[1])
  })

  it("uses the same automation actor prefix the runner mints", () => {
    // If these diverge, the runner resolves an empty policy and every automation
    // run starts failing — see `actorFor` in server/automations.ts, which builds its
    // actor from this same engine constant.
    expect(source).toContain(`AUTOMATION_ACTOR_PREFIX = "${AUTOMATION_ACTOR_PREFIX}"`)
  })

  it("grants over every resource type the presets do", () => {
    const fromPresets = new Set(BUILTIN_ROLES[0]!.rules.map((r) => r.resourceType))
    for (const type of fromPresets)
      expect(source, `backfill omits resource type "${type}"`).toContain(`"${type}"`)
  })
})
