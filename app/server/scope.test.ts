import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { actorScope, sessionScope, systemScope } from "./runtime"

/**
 * `OrgScope.role` drives READ visibility inside the engine, so "could a user
 * request ever act as `system`?" is a security question, not a style one. Three
 * guards, in order of strength:
 *
 *  1. TYPES — `sessionScope` takes the server's `Role`, which does not include
 *     `"system"`, so the compiler rejects it. Not assertable at runtime; it is
 *     enforced every `bun run typecheck`.
 *  2. SOURCE — the session-resolving modules must not even reference
 *     `systemScope`.
 *  3. SOURCE — `role: "system"` must appear in exactly one place.
 */
const read = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8")

describe("org scope roles", () => {
  it("sessionScope carries the membership role; systemScope is engine-level", () => {
    expect(sessionScope("org", "user", "member")).toEqual({
      orgId: "org",
      actor: "user",
      role: "member",
      policy: undefined,
    })
    expect(sessionScope("org", "user", "owner").role).toBe("owner")
    expect(systemScope("org", "runner").role).toBe("system")
  })

  it("ONLY an owner session is unrestricted", () => {
    // This used to read "sessionScope is never unrestricted", and the change is
    // deliberate: owner is a membership flag with an unconditional bypass, because a
    // role is an editable bag of rules and an org must not be able to lock itself
    // out by editing one. Everyone else is exactly their resolved rules.
    expect(systemScope("org", "runner").policy?.unrestricted).toBe(true)
    expect(sessionScope("org", "user", "owner").policy?.unrestricted).toBe(true)
    expect(sessionScope("org", "user", "admin").policy).toBeUndefined()
    expect(sessionScope("org", "user", "member").policy).toBeUndefined()
  })

  /**
   * An owner bypasses RULES. They do not become the engine, and they do not become
   * every other user: `role` stays `"owner"`, so the `role === "system"` branches
   * (which let the engine read anything) are not reachable, and ownership of a
   * personal dashboard still wins — see `DashboardService.maySee`, which requires
   * `owner_id IS NULL` before it ever consults a policy.
   */
  it("the owner bypass does not smuggle in engine privilege", () => {
    expect(sessionScope("org", "user", "owner").role).not.toBe("system")
  })

  it("an actorScope is GOVERNED, not exempt — that is the whole point", async () => {
    // An automation must be an actor with a role, not a passthrough for engine
    // privilege: that is what lets it be scoped, and what makes it behave the same
    // whoever tripped it. If this ever returns `unrestricted`, P4 has been undone.
    const scope = await actorScope("org-none", "system:automation:none")
    expect(scope.policy?.unrestricted).toBe(false)
    expect(scope.role).not.toBe("system")
  })

  // The two modules that turn a request into a scope. If either ever reaches for
  // systemScope, a member could read past the visibility filter.
  it("the session-resolving modules never construct a system scope", () => {
    for (const f of ["session.ts", "rpc.ts"]) {
      expect(read(f), `${f} must not reference systemScope`).not.toContain("systemScope")
    }
  })

  it("the automation runner's PER-RUN scopes are actor scopes, not system scopes", () => {
    // The runner still holds one systemScope for its OUTER pass (it resolves the
    // triggering record before it knows which automations match, so it cannot use any
    // one automation's policy — see the comment there). But every scope a RUN executes
    // under must be an actorScope, or automations are ungoverned again.
    const src = read("automations.ts")
    const systemUses = src
      .split("\n")
      .filter((l) => l.includes("systemScope(") && !l.trimStart().startsWith("//"))
    expect(systemUses).toHaveLength(1)
    expect(src).toContain("actorScope(")
    // Both per-run attribution sites (event-triggered and scheduled).
    expect(src.split("actorScope(").length - 1).toBeGreaterThanOrEqual(2)
  })

  it('`role: "system"` is written in exactly one place', () => {
    // runtime.ts holds systemScope itself (plus the comment naming this rule).
    const src = read("runtime.ts")
    const hits = src.split("\n").filter((l) => l.includes('role: "system"') && !l.includes("*"))
    expect(hits).toHaveLength(1)
  })

  /**
   * THE RESOLVED-POLICY GUARD.
   *
   * Access is one layer now: absent a policy, nothing on a concept, record,
   * dashboard, view or automation is granted. So a request path that builds a
   * session scope WITHOUT resolving one does not fail loudly — it 404s every record
   * it touches, which reads as "the data is gone". Two connectors shipped exactly
   * that bug the day the fallback flipped.
   *
   * Every `sessionScope(` in a request path must therefore pass a fourth argument.
   * `runtime.ts` is where it is defined and `rpc.ts`/`session.ts` resolve it at the
   * boundary; the rest are checked here.
   */
  it("every request path resolves a policy before building a session scope", () => {
    const files = ["apollo.ts", "clay.ts", "session.ts", "rpc.ts"]
    for (const file of files) {
      const src = read(`./${file}`)
      for (const m of src.matchAll(/sessionScope\(([^)]*)\)/g)) {
        const args = m[1]!.split(",").length
        expect(args, `${file}: sessionScope(${m[1]}) resolves no policy`).toBeGreaterThanOrEqual(4)
      }
    }
  })
})
