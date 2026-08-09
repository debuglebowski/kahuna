import { describe, expect, it } from "vitest"
import {
  type AccessRule,
  decide,
  emptyPolicy,
  LAYER_0_PRECEDENCE,
  unrestrictedPolicy,
} from "#engine"
import { decideConfigure } from "./policy"
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
 *   - an owner passes `role`/`member`-configure on the strength of Layer 0, which no
 *     rule can undo — but NOT `org`-configure, which is an ordinary decision for them
 *     too now (see "THE OWNER RECOVERY FLOOR" below).
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

  it("a role granting org configure+delete is what makes an admin an admin", () => {
    // Was `["*"]`. The wildcard is gone from the model, so "grants everything on the
    // org" is now spelled out — which is exactly the point of removing it.
    const asAdmin = { ...emptyPolicy("u"), rules: [rule(["configure", "delete"])] }
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

/**
 * ── THE OWNER RECOVERY FLOOR (LAYER 0) ────────────────────────────────────────
 *
 * This used to be "THE OWNER BYPASS": an owner's session resolved
 * `unrestrictedPolicy` outright, the same mechanism `systemScope` uses for the
 * engine itself. That is gone. An owner's session is now their ORDINARY resolved
 * rules with two extra rules prepended — `configure` on `role` and `member`,
 * nothing else — at a precedence below any role's. `unrestricted` is never true
 * for a session; it means only `systemScope` now.
 */
describe("THE OWNER RECOVERY FLOOR", () => {
  it("an owner's session is NEVER unrestricted — Layer 0 is added to their resolved rules, not swapped in for them", () => {
    const resolved = { ...emptyPolicy("u"), rules: [rule(["*"])] }
    const owner = sessionScope("org", "u", "owner", resolved)
    const member = sessionScope("org", "u", "member", resolved)
    expect(owner.policy?.unrestricted).toBe(false)
    expect(member.policy?.unrestricted).toBe(false)
    // The member's rules are untouched; the owner's carry the SAME rule PLUS
    // Layer 0 — the recovery floor adds to whatever roles already granted, it
    // doesn't replace it.
    expect(member.policy?.rules).toEqual(resolved.rules)
    expect(owner.policy?.rules).toEqual([...owner.policy!.rules.slice(0, 2), ...resolved.rules])
    expect(owner.policy?.rules.length).toBe(resolved.rules.length + 2)
  })

  it("the floor covers ONLY role and member configure — org-configure is an ordinary rule decision for an owner too", () => {
    // The property this replaces ("no rule can take configure away from an
    // owner") no longer holds for `org` — only for `role`/`member`. An owner
    // with no explicit role denied org-configure IS denied it; Layer 0 was never
    // meant to reproduce blanket admin, only to guarantee a way to fix the org.
    const scope = sessionScope("org", "u", "owner", emptyPolicy("u"))
    const has = (type: "org" | "role" | "member") =>
      decide(scope.policy!, "configure", { type }, false, { unconditionalOnly: true })
    expect(has("role")).toBe(true)
    expect(has("member")).toBe(true)
    expect(has("org")).toBe(false)
  })

  it("no rule can take the floor away — a blanket deny on role/member loses to Layer 0", () => {
    // A blanket DENY beats every allow for anyone else, at the SAME precedence.
    // Layer 0 sits BELOW every role's precedence (`LAYER_0_PRECEDENCE`), so a
    // role's deny is a lower-priority tier and is never even reached for these
    // two resource types — which is what makes it a genuine floor rather than
    // just another allow that a deny could still beat.
    const denyRole: AccessRule = { ...rule(["configure"]), resourceType: "role", effect: "deny" }
    const denyMember: AccessRule = {
      ...rule(["configure"]),
      resourceType: "member",
      effect: "deny",
    }
    const scope = sessionScope("org", "u", "owner", {
      ...emptyPolicy("u"),
      rules: [denyRole, denyMember],
    })
    const has = (type: "role" | "member") =>
      decide(scope.policy!, "configure", { type }, false, { unconditionalOnly: true })
    expect(has("role")).toBe(true)
    expect(has("member")).toBe(true)
  })

  it("is a DIFFERENT mechanism from systemScope's exemption, not the same one twice", () => {
    // The inverse of what this test used to assert: they must NOT be the same
    // object shape any more, or the owner has quietly become exempt from the
    // model again. `systemScope` alone still returns the real `unrestrictedPolicy`.
    const owner = sessionScope("org", "u", "owner")
    expect(owner.policy).not.toEqual(unrestrictedPolicy("u"))
    expect(owner.policy?.unrestricted).toBe(false)
    expect(owner.policy?.rules.every((r) => r.precedence === LAYER_0_PRECEDENCE)).toBe(true)
  })
})

/**
 * `decideConfigure` is the pure core of `canConfigure` — the auth-tier gate used by
 * `resolveAdmin`, the annotation/attachment/bucket mutate guards, and the shared
 * integration-settings `canEdit` check. It used to short-circuit `true` for
 * `role === "owner"` on ANY resource — the exact bypass P3 removed from
 * `sessionScope`. Left alone, that would have meant two contradictory answers for
 * the same owner: `requireAction`/`decide()` (fed by `sessionScope`) correctly
 * refusing `org`-configure with no admin role held, while these call sites kept
 * waving it through. Same floor, same function (`withLayer0`), one answer either way.
 */
describe("canConfigure's pure core no longer bypasses for org-configure", () => {
  it("an owner holding no other role is refused org-configure, same as sessionScope", () => {
    expect(decideConfigure(emptyPolicy("u"), "owner", { type: "org" })).toBe(false)
  })

  it("an owner still always gets role/member configure — the Layer 0 floor", () => {
    expect(decideConfigure(emptyPolicy("u"), "owner", { type: "role" })).toBe(true)
    expect(decideConfigure(emptyPolicy("u"), "owner", { type: "member" })).toBe(true)
  })

  it("an owner holding a role that grants org-configure IS allowed, same as anyone", () => {
    const withAdmin = { ...emptyPolicy("u"), rules: [rule(["configure"])] }
    expect(decideConfigure(withAdmin, "owner", { type: "org" })).toBe(true)
  })

  it("a plain member is decided purely by their rules — no floor at all", () => {
    expect(decideConfigure(emptyPolicy("u"), "member", { type: "role" })).toBe(false)
    expect(decideConfigure(emptyPolicy("u"), "member", { type: "member" })).toBe(false)
    const withAdmin = { ...emptyPolicy("u"), rules: [rule(["configure"])] }
    expect(decideConfigure(withAdmin, "member", { type: "org" })).toBe(true)
  })

  it("no role at all (not a member) is refused outright", () => {
    expect(decideConfigure(emptyPolicy("u"), null, { type: "org" })).toBe(false)
  })
})
