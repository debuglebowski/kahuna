import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Any browser launch goes through child_process.spawn — mocked so a regression
// fails the assertion instead of opening a tab on whoever runs the suite.
const spawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn,
}))

const { EXIT } = await import("./errors.ts")
const { run } = await import("./index.ts")

const capture = async (argv: ReadonlyArray<string>) => {
  let out = ""
  let err = ""
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c)
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err += String(c)
    return true
  })
  const code = await run(argv)
  vi.restoreAllMocks()
  return { code, out, err }
}

describe("record open", () => {
  let dir: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kahuna-open-"))
    mkdirSync(path.join(dir, "kahuna"))
    writeFileSync(
      path.join(dir, "kahuna", "config.json"),
      JSON.stringify({ host: "https://kahuna.example.com", cookie: "c" }),
    )
    process.env.XDG_CONFIG_HOME = dir
    delete process.env.KAHUNA_HOST
    delete process.env.KAHUNA_NO_BROWSER
    spawn.mockClear()
  })

  afterEach(() => {
    process.env = { ...saved }
    rmSync(dir, { recursive: true, force: true })
  })

  // Found 2026-11-03: the usage line advertised `--print` but the strict parser
  // rejected it as an unknown option, in either position.
  for (const argv of [
    ["record", "open", "abc", "--print"],
    ["record", "open", "--print", "abc"],
  ]) {
    it(`accepts ${argv.slice(2).join(" ")}: prints the URL, opens no browser`, async () => {
      const { code, out, err } = await capture(argv)
      expect(err).toBe("")
      expect(code).toBe(EXIT.ok)
      expect(out).toBe("https://kahuna.example.com/records/abc\n")
      expect(spawn).not.toHaveBeenCalled()
    })
  }

  it("without --print: prints the URL AND opens it", async () => {
    spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
    const { code, out } = await capture(["record", "open", "abc"])
    expect(code).toBe(EXIT.ok)
    expect(out).toBe("https://kahuna.example.com/records/abc\n")
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[1]).toEqual(["https://kahuna.example.com/records/abc"])
  })

  it("KAHUNA_NO_BROWSER suppresses the launch", async () => {
    process.env.KAHUNA_NO_BROWSER = "1"
    const { out } = await capture(["record", "open", "abc"])
    expect(out).toBe("https://kahuna.example.com/records/abc\n")
    expect(spawn).not.toHaveBeenCalled()
  })
})
