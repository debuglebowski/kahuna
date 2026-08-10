import { existsSync } from "node:fs"
import path from "node:path"
import { CliError, EXIT } from "./errors.ts"

/**
 * Is a newer `allt` published, and what would install it?
 *
 * WHY THIS EXISTS AT ALL: the CLI carries a COPY of the wire contract, compiled
 * in at build time. Against a deployment built from newer sources, a procedure
 * whose shape changed fails inside a schema decode with a message about a field
 * nobody typed. `commands/system.ts` already detects that skew and says "update
 * the CLI first" — this is the half that lets someone act on it.
 *
 * NOT to be confused with `server/version.ts`, which polls GHCR for the SERVER
 * image. Different artifact, different registry, different release cadence.
 *
 * Everything here is pure except `latestVersion` (one fetch) and the `existsSync`
 * in `classifyInstall`, so the interesting decisions are all testable without a
 * network or a package manager.
 */

/** The published name. Used in the registry URL and in every install command. */
export const PACKAGE = "@alltinghq/cli"

/** Overridable for a corporate mirror; npm's public registry otherwise. */
export const registryBase = (): string =>
  (process.env.ALLT_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "")

/**
 * Parse `1.2.3` / `v1.2.3` into comparable parts. Anything with a prerelease or
 * build suffix (`1.2.3-rc.1`, `1.2.3+sha`) is rejected: those must never be
 * offered as an upgrade to someone who did not opt into them.
 */
const parseSemver = (raw: string): readonly [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const
}

/**
 * Is `a` newer than `b`? Component-wise, NOT lexicographic — as strings
 * `"0.10.0" < "0.9.0"`, which would silently stop offering updates after the
 * tenth minor release.
 *
 * A DELIBERATE DUPLICATE of `server/version.ts`. That module lives in
 * `packages/app`, which is private and never published; importing it would put
 * an unresolvable path inside the tarball that reaches other people. Fifteen
 * lines is the cheaper of the two failures.
 */
export const isNewer = (a: string, b: string): boolean => {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

/**
 * The version behind npm's `latest` dist-tag.
 *
 * The dist-tag, NOT a scan of every published version — and that is the
 * difference from `server/version.ts`, which has to page through GHCR's tag list
 * and sort it because registry tags arrive in insertion order with no notion of
 * "current". On npm the publisher owns this pointer and `npm publish` sets it,
 * so it is both cheaper and more honest. `isNewer` still gates whatever comes
 * back, so a prerelease mis-tagged as `latest` can never be offered.
 *
 * The `%2F` is required: a scoped name is one path segment to this API.
 */
export const latestVersion = async (): Promise<string> => {
  const url = `${registryBase()}/${PACKAGE.replace("/", "%2F")}/latest`
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: "application/json" } })
  } catch (e) {
    // "fetch failed" on its own is unactionable — name what could not be
    // reached, the same way rest.ts does for the deployment.
    throw new CliError(
      `Cannot reach the npm registry at ${registryBase()} (${e instanceof Error ? e.message : String(e)}).`,
      EXIT.failed,
      "Check your network, or point ALLT_REGISTRY at a mirror.",
    )
  }
  if (!res.ok) {
    throw new CliError(
      `The registry did not answer for ${PACKAGE} (HTTP ${res.status}).`,
      EXIT.failed,
    )
  }
  const body = (await res.json().catch(() => null)) as { version?: string } | null
  if (!body?.version) {
    throw new CliError(`The registry returned no version for ${PACKAGE}.`, EXIT.failed)
  }
  return body.version
}

/**
 * How this copy of `allt` was installed — which decides what can replace it, and
 * whether replacing it is our business at all.
 *
 * `bun`/`pnpm`/`yarn`/`npm` are global installs: this command owns them and
 * upgrades them without asking. The other three are refusals, for reasons that
 * are about blast radius rather than caution:
 *
 *   - `source`  — a checkout or an `npm link`. Installing would write over
 *                 somebody's working tree.
 *   - `local`   — a project dependency. Installing would rewrite that project's
 *                 lockfile, and our CWD is not reliably its root, so we could
 *                 hit the wrong project or strand a stray package.json.
 *   - `npx`     — an ephemeral cache. There is nothing installed to update.
 */
export type InstallKind = "npm" | "bun" | "pnpm" | "yarn" | "local" | "npx" | "source"

const has = (haystack: string, needle: string): boolean =>
  haystack.includes(needle.replaceAll("/", path.sep))

/**
 * ORDER MATTERS, and not for tidiness: Bun writes a `package.json` NEXT TO its
 * global `node_modules` (`~/.bun/install/global/package.json`), so the
 * local-vs-global test at the bottom reads a Bun global install as a project
 * dependency unless the marker paths are checked first.
 *
 * `selfPath` is the resolved real path of this module — `fileURLToPath(
 * import.meta.url)`. Node resolves symlinks there, which is what makes an
 * `npm link` land in `source` rather than looking like a global install.
 */
export const classifyInstall = (selfPath: string): InstallKind => {
  const nm = `${path.sep}node_modules${path.sep}`
  // THE FIRST node_modules, not the last. pnpm nests — a project dependency
  // lives at `<project>/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>/…` — and
  // measuring from the LAST segment puts us inside `.pnpm/<pkg>@<v>`, which
  // holds no manifest and so reads as a global npm install. That misfire would
  // run `npm install -g` on behalf of someone who never installed globally.
  const at = selfPath.indexOf(nm)

  // An installed package ALWAYS lives under a node_modules directory. No such
  // segment means a source checkout, a linked dev build, or a bare bundle.
  if (at === -1) return "source"

  if (has(selfPath, "/_npx/")) return "npx"
  if (has(selfPath, "/.bun/install/global/")) return "bun"
  // `/pnpm/global/` and NOT a bare `.pnpm`: every pnpm install has a `.pnpm`
  // directory, including project-local ones, so the bare marker cannot tell the
  // two apart. Only `global` is evidence of a global install.
  if (has(selfPath, "/pnpm/global/")) return "pnpm"
  if (has(selfPath, "/.config/yarn/global/") || has(selfPath, "/.yarn/global/")) return "yarn"

  // npm's global root is `<prefix>/lib/node_modules`, and `<prefix>/lib` holds
  // no manifest. A project's `node_modules` always sits beside one.
  const enclosing = selfPath.slice(0, at)
  return existsSync(path.join(enclosing, "package.json")) ? "local" : "npm"
}

export interface UpdateCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/** The argv that upgrades a global install of each kind. */
export const updateArgv = (kind: "npm" | "bun" | "pnpm" | "yarn"): UpdateCommand => {
  const spec = `${PACKAGE}@latest`
  switch (kind) {
    case "bun":
      return { command: "bun", args: ["add", "-g", spec] }
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", spec] }
    case "yarn":
      return { command: "yarn", args: ["global", "add", spec] }
    default:
      return { command: "npm", args: ["install", "-g", spec] }
  }
}

/** Printable form of an argv, for `--dry-run` and for every error hint. */
export const renderCommand = ({ command, args }: UpdateCommand): string =>
  [command, ...args].join(" ")

/** Why we will not update this install, and what to run instead. */
export const refusal = (kind: "local" | "npx" | "source"): { message: string; hint: string } => {
  switch (kind) {
    case "npx":
      return {
        message: "This CLI is running from an npx cache, so there is no install to update.",
        hint: `Run \`npx ${PACKAGE}@latest\` to get the newest version.`,
      }
    case "local":
      return {
        message: `This CLI is a dependency of a project, not a global install.`,
        hint: `Run \`npm install ${PACKAGE}@latest\` in that project — updating it from here would rewrite its lockfile.`,
      }
    default:
      return {
        message: "This CLI is running from a source checkout or a linked build.",
        hint: "Update it with git, then `bun run cli:build`.",
      }
  }
}
