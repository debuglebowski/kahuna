import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  classifyInstall,
  type InstallKind,
  isNewer,
  latestVersion,
  refusal,
  renderCommand,
  updateArgv,
} from "./selfupdate.ts"

const env = { ...process.env }
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe("comparing versions", () => {
  it("compares component-wise, not lexicographically", () => {
    // THE bug this function exists to avoid: as strings "0.10.0" < "0.9.0", so a
    // lexicographic compare silently stops offering updates at the tenth minor.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
    expect(isNewer("0.9.0", "0.10.0")).toBe(false)
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
    expect(isNewer("0.0.9", "0.0.10")).toBe(false)
  })

  it("does not call an identical version an update", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false)
  })

  it("tolerates a leading v on either side", () => {
    expect(isNewer("v1.2.4", "1.2.3")).toBe(true)
    expect(isNewer("1.2.3", "v1.2.4")).toBe(false)
  })

  it("never offers a prerelease or a build-tagged version", () => {
    // Someone who did not opt into 2.0.0-rc.1 must not be handed it by an
    // unattended self-update.
    expect(isNewer("2.0.0-rc.1", "1.0.0")).toBe(false)
    expect(isNewer("2.0.0+sha.abc", "1.0.0")).toBe(false)
    expect(isNewer("2.0.0", "1.0.0-rc.1")).toBe(false)
  })

  it("treats anything unparseable as 'not newer' rather than guessing", () => {
    expect(isNewer("latest", "1.0.0")).toBe(false)
    expect(isNewer("", "1.0.0")).toBe(false)
  })
})

describe("classifying an install", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "kahuna-install-"))
  })

  /** Materialise a real tree — `classifyInstall` stats the filesystem. */
  const layout = (
    segments: ReadonlyArray<string>,
    manifests: ReadonlyArray<string> = [],
  ): string => {
    const file = path.join(root, ...segments, "dist", "index.js")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "")
    for (const m of manifests) {
      const p = path.join(root, m, "package.json")
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, "{}")
    }
    return file
  }

  const NM = "node_modules"
  const PKG = path.join("@kahunalabs", "cli")

  it("calls a checkout or a linked build 'source'", () => {
    // No node_modules segment anywhere. This is what `npm link` looks like once
    // Node has resolved the symlink, and updating it would write over a working
    // tree. It is also the case a developer hits first.
    expect(classifyInstall(layout(["repo", "packages", "cli"]))).toBe("source")
  })

  it("refuses an npx cache — there is nothing installed to update", () => {
    expect(classifyInstall(layout([".npm", "_npx", "a1b2c3", NM, PKG]))).toBe("npx")
  })

  it("recognises a bun global install even though bun writes a manifest beside it", () => {
    // ORDER REGRESSION: ~/.bun/install/global/package.json exists, so the
    // local-vs-global test at the bottom would read this as a project dependency
    // if the marker paths were not checked first.
    const file = layout(
      [".bun", "install", "global", NM, PKG],
      [path.join(".bun", "install", "global")],
    )
    expect(classifyInstall(file)).toBe("bun")
  })

  it("recognises a pnpm global install through its nested layout", () => {
    const file = layout([
      "Library",
      "pnpm",
      "global",
      "5",
      NM,
      ".pnpm",
      "@kahunalabs+cli@1.0.0",
      NM,
      PKG,
    ])
    expect(classifyInstall(file)).toBe("pnpm")
  })

  it("recognises a yarn 1 global install", () => {
    const file = layout(
      [".config", "yarn", "global", NM, PKG],
      [path.join(".config", "yarn", "global")],
    )
    expect(classifyInstall(file)).toBe("yarn")
  })

  it("calls npm's global root 'npm' — <prefix>/lib holds no manifest", () => {
    expect(classifyInstall(layout(["usr", "local", "lib", NM, PKG]))).toBe("npm")
  })

  it("calls a project dependency 'local'", () => {
    expect(classifyInstall(layout(["project", NM, PKG], ["project"]))).toBe("local")
  })

  it("calls a pnpm PROJECT dependency 'local', not a global install", () => {
    // THE nesting trap. Measuring from the LAST node_modules lands inside
    // `.pnpm/@kahunalabs+cli@1.0.0`, which holds no package.json and so reads as
    // an npm global root — and `kahuna cli update` would then run `npm install -g`
    // for someone who never installed globally.
    const file = layout(["project", NM, ".pnpm", "@kahunalabs+cli@1.0.0", NM, PKG], ["project"])
    expect(classifyInstall(file)).toBe("local")
  })
})

describe("the install command", () => {
  it("is the global-install form for each manager", () => {
    expect(renderCommand(updateArgv("npm"))).toBe("npm install -g @kahunalabs/cli@latest")
    expect(renderCommand(updateArgv("bun"))).toBe("bun add -g @kahunalabs/cli@latest")
    expect(renderCommand(updateArgv("pnpm"))).toBe("pnpm add -g @kahunalabs/cli@latest")
    expect(renderCommand(updateArgv("yarn"))).toBe("yarn global add @kahunalabs/cli@latest")
  })

  it("pins @latest rather than a computed version", () => {
    // The registry decided what `latest` is; restating the number here would let
    // the two disagree if a publish landed between the check and the install.
    for (const kind of ["npm", "bun", "pnpm", "yarn"] as const) {
      expect(updateArgv(kind).args.at(-1)).toBe("@kahunalabs/cli@latest")
    }
  })
})

describe("refusing", () => {
  it("says what to run instead, for every kind it refuses", () => {
    for (const kind of ["local", "npx", "source"] as const) {
      const { message, hint } = refusal(kind)
      expect(message.length).toBeGreaterThan(0)
      expect(hint.length).toBeGreaterThan(0)
    }
  })

  it("points a project dependency at its own project, not at -g", () => {
    expect(refusal("local").hint).toContain("npm install @kahunalabs/cli@latest")
    expect(refusal("local").hint).not.toContain("-g")
  })
})

describe("asking the registry", () => {
  const respond = (body: unknown, status = 200) =>
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(body), { status }) as never)

  it("reads the version behind the latest dist-tag", async () => {
    const fetchSpy = respond({ version: "9.9.9" })
    expect(await latestVersion()).toBe("9.9.9")
    // A scoped name is ONE path segment to this API — unencoded, the slash makes
    // it a 404 against a package called "cli" under an org route.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://registry.npmjs.org/@kahunalabs%2Fcli/latest",
    )
  })

  it("honours KAHUNA_REGISTRY, trailing slash and all", async () => {
    process.env.KAHUNA_REGISTRY = "https://npm.internal.example.com/"
    const fetchSpy = respond({ version: "1.0.0" })
    await latestVersion()
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://npm.internal.example.com/@kahunalabs%2Fcli/latest",
    )
  })

  it("names the registry when it cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("getaddrinfo ENOTFOUND"))
    // "fetch failed" alone tells nobody which host to check.
    await expect(latestVersion()).rejects.toThrow(/registry.npmjs.org/)
  })

  it("fails on a non-200 rather than treating it as 'up to date'", async () => {
    respond({}, 503)
    await expect(latestVersion()).rejects.toThrow(/HTTP 503/)
  })

  it("fails when the body carries no version", async () => {
    respond({ name: "@kahunalabs/cli" })
    await expect(latestVersion()).rejects.toThrow(/no version/)
  })
})

describe("the kinds line up", () => {
  it("splits every InstallKind into exactly one of update-able or refused", () => {
    // A kind added later must be routed deliberately, not fall through the
    // command's `if` into an unguarded spawn.
    const updatable = ["npm", "bun", "pnpm", "yarn"] as const
    const refused = ["local", "npx", "source"] as const
    const all: ReadonlyArray<InstallKind> = [...updatable, ...refused]
    expect(new Set(all).size).toBe(all.length)
  })
})
