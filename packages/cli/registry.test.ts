import { describe, expect, it } from "vitest"
import { registry } from "./index.ts"
import { Registry, VERBS } from "./registry.ts"

/**
 * The grammar is only unambiguous if every command obeys it, so this asserts
 * the rules rather than trusting the parser to cope. A command added in the
 * wrong shape fails here, not in someone's terminal.
 */
describe("the grammar", () => {
  const paths = registry.commands.map((c) => c.path)

  it("ends every path in a verb — never an id or a noun", () => {
    for (const path of paths) {
      const last = path.split(" ").at(-1) ?? ""
      expect(VERBS.has(last as never), `"${path}" does not end in a known verb`).toBe(true)
    }
  })

  it("never starts a path with a verb (the first token is always a noun)", () => {
    for (const path of paths) {
      const first = path.split(" ")[0] ?? ""
      expect(VERBS.has(first as never), `"${path}" starts with a verb`).toBe(false)
    }
  })

  it("keeps paths to noun [sub-noun] verb — at most three tokens", () => {
    for (const path of paths) {
      expect(
        path.split(" ").length,
        `"${path}" is deeper than noun/sub-noun/verb`,
      ).toBeLessThanOrEqual(3)
    }
  })

  it("has a summary and a lowercase, space-separated path for every command", () => {
    for (const c of registry.commands) {
      expect(c.summary.length, `"${c.path}" has no summary`).toBeGreaterThan(0)
      expect(c.path).toMatch(/^[a-z]+( [a-z-]+){1,2}$/)
    }
  })
})

describe("dispatch", () => {
  const r = new Registry([
    { path: "task update", summary: "", run: async () => {} },
    { path: "task status list", summary: "", run: async () => {} },
    { path: "task list", summary: "", run: async () => {} },
  ])

  it("prefers the longest matching path", () => {
    // THE case the grammar exists for: `task status list` must not be read as
    // `task list`-with-an-argument, nor `task update <id>` as a sub-noun.
    expect(r.match(["task", "status", "list"])?.command.path).toBe("task status list")
    expect(r.match(["task", "list"])?.command.path).toBe("task list")
  })

  it("treats everything after the path as arguments", () => {
    const m = r.match(["task", "update", "abc-123", "--status", "done"])
    expect(m?.command.path).toBe("task update")
    expect(m?.args).toEqual(["abc-123", "--status", "done"])
  })

  it("returns null for an unknown path rather than guessing", () => {
    expect(r.match(["task"])).toBeNull()
    expect(r.match(["nope", "list"])).toBeNull()
  })

  it("rejects a duplicate path at construction", () => {
    expect(
      () =>
        new Registry([
          { path: "task list", summary: "", run: async () => {} },
          { path: "task list", summary: "", run: async () => {} },
        ]),
    ).toThrow(/duplicate/)
  })

  it("lists the commands under a noun, for a partial command", () => {
    expect(
      r
        .under("task")
        .map((c) => c.path)
        .sort(),
    ).toEqual(["task list", "task status list", "task update"])
  })
})
