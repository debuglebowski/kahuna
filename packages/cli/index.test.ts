import { afterEach, describe, expect, it, vi } from "vitest"
import { EXIT } from "./errors.ts"
import { run } from "./index.ts"
import pkg from "./package.json" with { type: "json" }

/** Capture stdout without letting the test's own output pollute it. */
const capture = async (argv: ReadonlyArray<string>): Promise<{ code: number; out: string }> => {
  let out = ""
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  const code = await run(argv)
  spy.mockRestore()
  return { code, out }
}

afterEach(() => vi.restoreAllMocks())

describe("--version", () => {
  it("prints the bare version on stdout and exits 0", async () => {
    const { code, out } = await capture(["--version"])
    expect(code).toBe(EXIT.ok)
    // Bare, so `km --version` is greppable and quotable in a bug report —
    // no prefix, no banner, nothing to strip.
    expect(out).toBe(`${pkg.version}\n`)
  })

  it("answers to -v as well", async () => {
    expect((await capture(["-v"])).out).toBe(`${pkg.version}\n`)
  })

  it("needs no profile, no host and no network", async () => {
    // The point of the command: it works on a machine that has never signed in,
    // which is exactly the machine someone is debugging when they ask for it.
    const saved = { ...process.env }
    for (const k of ["KM_HOST", "KM_PROFILE", "KM_TOKEN"]) delete process.env[k]
    process.env.XDG_CONFIG_HOME = "/nonexistent-on-purpose"
    try {
      const { code, out } = await capture(["--version"])
      expect(code).toBe(EXIT.ok)
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/)
    } finally {
      process.env = saved
    }
  })
})

describe("help", () => {
  it("is what a bare invocation gets", async () => {
    const { code, out } = await capture([])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain("km <noun>")
  })

  it("lists --version among the global flags", async () => {
    expect((await capture(["help"])).out).toContain("--version")
  })
})

describe("an unknown command", () => {
  it("exits 2 rather than 0, so a typo cannot look like success", async () => {
    const { code } = await capture(["definitely-not-a-noun"])
    expect(code).toBe(EXIT.usage)
  })
})
