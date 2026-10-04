import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configPath, loadConfig, requireHost, requireSession, saveConfig } from "./config.ts"
import { EXIT } from "./errors.ts"

let dir: string
const env = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kahuna-config-"))
  process.env.XDG_CONFIG_HOME = dir
  for (const k of ["KAHUNA_HOST", "KAHUNA_TOKEN"]) delete process.env[k]
})
afterEach(() => {
  process.env = { ...env }
})

describe("the config file", () => {
  it("is written 0600 — it holds a live session cookie", () => {
    saveConfig({ host: "http://x", cookie: "s=1" })
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it("round-trips", () => {
    saveConfig({ host: "http://x", cookie: "s=1", email: "k@example.com" })
    expect(loadConfig()).toEqual({ host: "http://x", cookie: "s=1", email: "k@example.com" })
  })

  it("treats a missing file as empty, but REFUSES to guess at a corrupt one", () => {
    expect(loadConfig()).toEqual({})
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), "{ not json")
    // Starting fresh here would silently drop the stored session.
    expect(() => loadConfig()).toThrow(/not valid JSON/)
  })

  it("leaves no temp file holding the credential behind", () => {
    saveConfig({ host: "http://x", cookie: "secret" })
    expect(() =>
      statSync(path.join(path.dirname(configPath()), `.config.json.${process.pid}`)),
    ).toThrow()
  })
})

describe("which deployment", () => {
  it("uses the stored host", () => {
    saveConfig({ host: "https://prod" })
    expect(requireHost()).toBe("https://prod")
  })

  it("lets KAHUNA_HOST override without touching the file", () => {
    saveConfig({ host: "https://prod" })
    process.env.KAHUNA_HOST = "https://staging"
    expect(requireHost()).toBe("https://staging")
    expect(loadConfig().host).toBe("https://prod")
  })

  it("strips a trailing slash, so URLs never double up", () => {
    process.env.KAHUNA_HOST = "https://staging/"
    expect(requireHost()).toBe("https://staging")
  })

  it("REFUSES to guess when nothing is configured", () => {
    // It used to fall back to http://localhost:3100, which meant a CLI could ask
    // for a password while quietly aiming at the wrong machine.
    try {
      requireHost()
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(EXIT.usage)
      expect((e as { message: string }).message).toContain("No deployment configured")
    }
  })

  it("never invents localhost", () => {
    expect(() => requireHost()).toThrow()
    expect(() => requireHost({})).toThrow()
  })
})

describe("requiring a session", () => {
  it("returns the host and cookie together", () => {
    saveConfig({ host: "https://prod", cookie: "s=1", email: "k@example.com" })
    expect(requireSession()).toEqual({
      host: "https://prod",
      cookie: "s=1",
      email: "k@example.com",
    })
  })

  it("asks for a host before it asks for a sign-in", () => {
    // Order matters: "not signed in" is confusing advice when the real problem
    // is that the CLI does not know where to sign in TO.
    try {
      requireSession()
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as { message: string }).message).toContain("No deployment configured")
    }
  })

  it("reports not-signed-in once a host is known", () => {
    saveConfig({ host: "https://prod" })
    try {
      requireSession()
      expect.unreachable("should have thrown")
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(EXIT.unauthenticated)
    }
  })
})
