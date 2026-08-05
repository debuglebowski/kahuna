import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { envPath } from "./env"

/**
 * `env.ts` resolves the repo-root `.env` by counting `..` segments up from its
 * own directory, and swallows a miss in a `catch` so a checkout without a `.env`
 * still boots. Those two facts together mean a wrong depth is INVISIBLE: the
 * server starts, then dies on the first request with a Postgres error naming
 * neither this file nor the missing variable.
 *
 * That is not hypothetical — the file moved from `app/server` to
 * `packages/app/server` when the workspace split landed, which changed the
 * correct depth from two segments to three.
 */
describe("env path resolution", () => {
  it("resolves to the repo root, not a directory inside it", () => {
    const root = path.dirname(envPath)
    // The root is the one place with the workspace manifest and the Dockerfile.
    expect(existsSync(path.join(root, "package.json"))).toBe(true)
    expect(existsSync(path.join(root, "Dockerfile"))).toBe(true)
    expect(existsSync(path.join(root, "packages"))).toBe(true)
    expect(path.basename(envPath)).toBe(".env")
  })

  it("resolves above the package, so no package-local .env can shadow it", () => {
    const pkgRoot = path.resolve(import.meta.dirname, "..")
    expect(envPath.startsWith(`${pkgRoot}${path.sep}`)).toBe(false)
  })
})
