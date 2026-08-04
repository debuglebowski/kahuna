import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { AUTOMATION_ACTOR_PREFIX, BUILTIN_ROLES, TEMPLATED_TYPES } from "#engine"

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

/** The phase-2 backfill: materializes today's effective access into explicit
 *  per-resource rules. Same drift hazard, different table. */
const valuesSource = readFileSync(
  path.join(import.meta.dirname, "..", "scripts", "backfill-access-values.ts"),
  "utf8",
)
const verifySource = readFileSync(
  path.join(import.meta.dirname, "..", "scripts", "verify-access-values.ts"),
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

/**
 * The phase-2 backfill and its proof script each restate the same two tables: which
 * actions a grid shows per resource type, and how a preset maps onto the membership
 * role whose default it reproduces. They must agree with each other and with the
 * engine, or the proof certifies a backfill that did something else.
 */
describe("the explicit-values backfill and its proof agree", () => {
  it("covers exactly the templated resource types, in both scripts", () => {
    for (const type of TEMPLATED_TYPES) {
      expect(valuesSource, `backfill missing type "${type}"`).toContain(`${type}: [`)
      expect(verifySource, `proof missing type "${type}"`).toContain(`${type}: [`)
    }
  })

  it("uses the same per-type action lists in both", () => {
    // Pull each ACTIONS_BY_TYPE literal out of both files and compare them. A proof
    // checking fewer actions than the backfill writes would pass while leaving real
    // drift unexamined — the exact failure this guards.
    const table = (src: string): Record<string, string> => {
      const body = src.slice(src.indexOf("ACTIONS_BY_TYPE"))
      const out: Record<string, string> = {}
      for (const m of body.matchAll(/^ {2}(\w+): \[([^\]]*)\],$/gm)) out[m[1]!] = m[2]!.trim()
      return out
    }
    expect(table(valuesSource)).toEqual(table(verifySource))
  })

  it("NEVER writes a deny — absence is what 'not allowed' means", () => {
    // A deny beats per-record shares, so materializing "no" as a deny row would
    // silently kill sharing. The backfill's only INSERT into access_rules is an
    // allow; if that ever changes, this is the tripwire.
    // Each INSERT runs to the end of its template literal.
    const inserts = [...valuesSource.matchAll(/INSERT INTO access_rules[\s\S]*?`/g)]
    expect(inserts.length).toBeGreaterThan(0)
    for (const m of inserts) expect(m[0]).toContain("'allow'")
    expect(valuesSource).not.toContain("'deny'")
  })

  it("skips full-access roles, which keep their wildcard", () => {
    expect(valuesSource).toContain("full_access")
    expect(verifySource).toContain("full_access")
  })
})
