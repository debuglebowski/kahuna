import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configPath, loadConfig, resolveProfile, saveConfig } from "./config.ts"
import { EXIT } from "./errors.ts"

let dir: string
const env = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "km-config-"))
  process.env.XDG_CONFIG_HOME = dir
  for (const k of ["KM_HOST", "KM_PROFILE", "KM_TOKEN"]) delete process.env[k]
})
afterEach(() => {
  process.env = { ...env }
})

describe("the config file", () => {
  it("is written 0600 — it holds a live session cookie", () => {
    saveConfig({ current: "a", profiles: { a: { host: "http://x", cookie: "s=1" } } })
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it("round-trips", () => {
    saveConfig({ current: "a", profiles: { a: { host: "http://x", email: "k@example.com" } } })
    expect(loadConfig()).toEqual({
      current: "a",
      profiles: { a: { host: "http://x", email: "k@example.com" } },
    })
  })

  it("treats a missing file as empty, but REFUSES to guess at a corrupt one", () => {
    expect(loadConfig()).toEqual({ profiles: {} })
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), "{ not json")
    // Starting fresh here would drop every other profile on the next save.
    expect(() => loadConfig()).toThrow(/not valid JSON/)
  })

  it("does not leave the credential in a temp file after a save", () => {
    saveConfig({ profiles: { a: { host: "http://x", cookie: "secret" } } })
    const files = readFileSync(configPath(), "utf8")
    expect(files).toContain("secret")
    expect(() =>
      statSync(path.join(path.dirname(configPath()), `.config.json.${process.pid}`)),
    ).toThrow()
  })
})

describe("which profile a command uses", () => {
  const config = {
    current: "prod",
    profiles: { prod: { host: "https://prod" }, local: { host: "http://localhost:3100" } },
  }

  it("prefers --profile over KM_PROFILE over the stored current", () => {
    expect(resolveProfile(config).name).toBe("prod")
    process.env.KM_PROFILE = "local"
    expect(resolveProfile(config).name).toBe("local")
    expect(resolveProfile(config, "prod").name).toBe("prod")
  })

  it("lets KM_HOST override the host without touching the stored profile", () => {
    process.env.KM_HOST = "https://staging"
    const r = resolveProfile(config)
    expect(r.profile.host).toBe("https://staging")
    expect(r.hostOverridden).toBe(true)
    expect(config.profiles.prod.host).toBe("https://prod")
  })

  it("strips a trailing slash, so URLs never double up", () => {
    process.env.KM_HOST = "https://staging/"
    expect(resolveProfile(config).profile.host).toBe("https://staging")
  })

  it("fails with a usage code when nothing is configured", () => {
    try {
      resolveProfile({ profiles: {} })
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(EXIT.usage)
    }
  })
})
