import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { sessionScope, systemScope } from "./runtime"

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
    })
    expect(sessionScope("org", "user", "owner").role).toBe("owner")
    expect(systemScope("org", "runner").role).toBe("system")
  })

  // The two modules that turn a request into a scope. If either ever reaches for
  // systemScope, a member could read past the visibility filter.
  it("the session-resolving modules never construct a system scope", () => {
    for (const f of ["session.ts", "rpc.ts"]) {
      expect(read(f), `${f} must not reference systemScope`).not.toContain("systemScope")
    }
  })

  it('`role: "system"` is written in exactly one place', () => {
    // runtime.ts holds systemScope itself (plus the comment naming this rule).
    const src = read("runtime.ts")
    const hits = src.split("\n").filter((l) => l.includes('role: "system"') && !l.includes("*"))
    expect(hits).toHaveLength(1)
  })
})
