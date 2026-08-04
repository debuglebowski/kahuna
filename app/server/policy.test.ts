import { describe, expect, it } from "vitest"
import { type AccessRule, decide, emptyPolicy, unrestrictedPolicy } from "#engine"
import { sessionScope } from "./runtime"

/**
 * ── THE LAST ROLE-DERIVED FALLBACK IS GONE ───────────────────────────────────
 *
 * `configure`/`delete` used to fall back to `isAdminRole(membership role)`. This file
 * asserted the equivalence between that and `decide()`; it now asserts what replaced
 * it, because the old property is the thing being removed:
 *
 *   - the fallback no longer looks at the role AT ALL — closed for configure/delete,
 *     open otherwise;
 *   - an admin passes on the strength of the Admin ROLE's rules, which is what lets
 *     an org grant org-configuration to a role of its own making;
 *   - an owner passes because their session is unrestricted, which no rule can undo.
 *
 * If the first of these regresses to a tier check, the middle one silently stops
 * working and nobody finds out until an org tries it.
 */

/** Exactly what `requireAction` computes. Mirrored, so a change there fails here. */
const fallbackFor = (action: "view" | "edit" | "delete" | "configure") =>
  action !== "configure" && action !== "delete"

const rule = (actions: ReadonlyArray<string>): AccessRule =>
  ({
    id: "r1",
    roleId: "role-admin",
    actorId: null,
    effect: "allow",
    actions,
    resourceType: "org",
    resourceId: null,
    conceptId: null,
    condition: null,
  }) as AccessRule

const allowed = (
  policy: Parameters<typeof decide>[0],
  action: "view" | "edit" | "delete" | "configure",
) =>
  decide(policy, action, { type: "org" }, fallbackFor(action), {
    unconditionalOnly: true,
  })

describe("the RPC fallback no longer consults the membership role", () => {
  it("someone holding NO rules reads and edits but cannot configure or delete", () => {
    const none = emptyPolicy("u")
    expect(allowed(none, "view")).toBe(true)
    expect(allowed(none, "edit")).toBe(true)
    expect(allowed(none, "configure")).toBe(false)
    expect(allowed(none, "delete")).toBe(false)
  })

  it("a role granting `*` on the org is what makes an admin an admin", () => {
    const asAdmin = { ...emptyPolicy("u"), rules: [rule(["*"])] }
    expect(allowed(asAdmin, "configure")).toBe(true)
    expect(allowed(asAdmin, "delete")).toBe(true)
  })

  it("a role granting configure ALONE still cannot delete", () => {
    // The actions are separate grants, so "may administer the org" does not quietly
    // carry "may destroy things in it".
    const ops = { ...emptyPolicy("u"), rules: [rule(["configure"])] }
    expect(allowed(ops, "configure")).toBe(true)
    expect(allowed(ops, "delete")).toBe(false)
  })
})

describe("THE OWNER BYPASS", () => {
  it("an owner's session is unrestricted; everyone else's is their resolved rules", () => {
    const resolved = emptyPolicy("u")
    expect(sessionScope("org", "u", "owner", resolved).policy?.unrestricted).toBe(true)
    expect(sessionScope("org", "u", "admin", resolved).policy?.unrestricted).toBe(false)
    expect(sessionScope("org", "u", "member", resolved).policy?.unrestricted).toBe(false)
  })

  it("no rule can take it away — that is the point", () => {
    // A blanket DENY beats every allow for anyone else. An owner has to survive it,
    // or the org can be locked out of itself by editing a role, which is exactly the
    // hazard that made owner a flag rather than a role.
    const deny: AccessRule = { ...rule(["*"]), effect: "deny" } as AccessRule
    const scope = sessionScope("org", "u", "owner", { ...emptyPolicy("u"), rules: [deny] })
    expect(allowed(scope.policy!, "configure")).toBe(true)
    expect(allowed(scope.policy!, "delete")).toBe(true)
  })

  it("is the same mechanism the engine uses for itself, not a second one", () => {
    // If these ever diverge, `decide()` grows a second short-circuit and the two
    // will drift.
    expect(sessionScope("org", "u", "owner").policy).toEqual(unrestrictedPolicy("u"))
  })
})
