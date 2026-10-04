/**
 * Assert that every first-party module the server imports actually exists.
 *
 * WHY THIS EXISTS: `server/automations.ts` imports `../src/lib/conditions` —
 * client-tree code that is genuinely server runtime code — and the Dockerfile
 * copied `server`, `engine` and `db` but not `src`.
 * The image built clean, passed its per-file `test -f` assertions, and then
 * could not boot at all: `Cannot find module '../src/lib/conditions'`, thrown at
 * import time before anything listened. Per-file assertions only catch omissions
 * somebody thought to list; this catches the general case.
 *
 * Run as a Docker build step, so it must not need a database, a network, or any
 * environment: it reads files and resolves paths, nothing more.
 *
 * Scope is deliberately FIRST-PARTY ONLY — relative specifiers, the `#engine` /
 * `#db` subpath imports, and `@kahunalabs/*` workspace packages (our own source
 * behind a package name; see `resolveWorkspace`). Other bare specifiers
 * (`effect`, `better-auth`) are the package manager's problem, and `bun build`
 * proved a poor proxy for all of this: it descends
 * into node_modules and fails on a benign export mismatch inside
 * @better-auth/kysely-adapter, on a dialect Bun never loads.
 *
 * Not `bun -e 'import("./server/index.ts")'` either: importing the server
 * EXECUTES it (opens a pool, starts listening) — not something a build stage
 * should do.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/** Extensions Bun will try, in order, for an extensionless specifier. */
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"]

/**
 * Two different roots, and conflating them is the bug this comment prevents.
 *
 * `PKG` is this package (`packages/app`) — it owns the `imports` map, so
 * `#engine` / `#db` resolve relative to IT, not to the repo root. The map used
 * to live in the root manifest; if this ever reads the wrong one it finds no
 * map, resolves nothing, and the whole guard passes vacuously — worse than
 * failing, because it looks green.
 *
 * `REPO` is the workspace root, needed only to locate sibling packages
 * (`packages/contract`) and to print paths a human can find.
 */
const PKG = path.resolve(import.meta.dirname, "..")
const REPO = path.resolve(PKG, "../..")
const pkgManifest = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as {
  imports?: Record<string, string>
}
const IMPORT_MAP = pkgManifest.imports ?? {}
if (Object.keys(IMPORT_MAP).length === 0) {
  console.error(
    `no "imports" map in ${path.join(PKG, "package.json")} — every #engine/#db ` +
      "specifier would resolve to nothing and this check would pass without checking.",
  )
  process.exit(2)
}

/**
 * First-party workspace packages. These LOOK like third-party bare specifiers,
 * so the "bare = the package manager's problem" rule below would skip them — but
 * they are our own source, shipped by their own `COPY`, and a missing one breaks
 * boot exactly like a missing relative import. `@kahunalabs/contract` is the
 * case that matters: every server module imports it.
 *
 * Resolved through the workspace directory rather than the node_modules symlink,
 * so this reports the real path when the link exists but its target was never
 * copied into the image.
 */
const WORKSPACE_SCOPE = "@kahunalabs/"
const resolveWorkspace = (spec: string): string | null => {
  const rest = spec.slice(WORKSPACE_SCOPE.length) // "contract" | "contract/x"
  const [pkg, ...sub] = rest.split("/")
  if (!pkg) return null
  const dir = path.join(REPO, "packages", pkg)
  if (sub.length > 0) return path.join(dir, ...sub)
  // No subpath: read the member's own `exports`/`main` rather than assuming a
  // filename, so renaming the entry file cannot silently pass this check.
  try {
    const pkgJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      exports?: Record<string, string> | string
      main?: string
    }
    const entry =
      typeof pkgJson.exports === "string"
        ? pkgJson.exports
        : (pkgJson.exports?.["."] ?? pkgJson.main)
    return entry ? path.join(dir, entry) : null
  } catch {
    return null
  }
}

/** Resolve a `#`-prefixed specifier through THIS package's `imports` map. */
const resolveSubpath = (spec: string): string | null => {
  // Exact keys first ("#engine"), then wildcard keys ("#engine/*").
  const exact = IMPORT_MAP[spec]
  if (exact) return path.join(PKG, exact)
  for (const [key, target] of Object.entries(IMPORT_MAP)) {
    if (!key.endsWith("/*")) continue
    const prefix = key.slice(0, -1) // "#engine/"
    if (!spec.startsWith(prefix)) continue
    return path.join(PKG, target.replace("*", spec.slice(prefix.length)))
  }
  return null
}

/** A file path for `base`, trying each extension and an index file. */
const resolveFile = (base: string): string | null => {
  for (const ext of EXTS) {
    const p = base + ext
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of EXTS.slice(1)) {
      const p = path.join(base, `index${ext}`)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * Every static import/export specifier in a source file that survives to
 * RUNTIME. A regex, not a parser: this runs in a build stage with no dev
 * dependencies, and the failure it guards against (a whole directory absent from
 * the image) is not subtle enough to need an AST.
 *
 * `import type` / `export type` are SKIPPED, and that distinction is the whole
 * reason this isn't a two-line regex: types are erased before the module is
 * loaded, so a type-only import of a file that isn't in the image is completely
 * fine. `src/lib/conditions.ts` does exactly that — `import type { Field,
 * RecordVersion } from "./api"`, where api.ts is client code the image has no reason
 * to ship. Counting it as a dependency would demand we copy the entire client
 * tree to satisfy an import that doesn't exist at runtime.
 *
 * Inline `import { type A, b }` is still a runtime import (it loads the module
 * for `b`), so only the statement-level `import type` form is dropped.
 */
const specifiersOf = (src: string): ReadonlyArray<string> => {
  const out: string[] = []
  const patterns = [
    // `import ... from "x"` / bare `import "x"`, but NOT `import type ... from`.
    /(?:^|\n)\s*import\s+(?!type\s)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    // `export * from "x"` / `export { ... } from "x"`, but NOT `export type`.
    /(?:^|\n)\s*export\s+(?!type\s)(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) if (m[1]) out.push(m[1])
  }
  return out
}

// Several entries, because the image has more than one: the server plus every
// deploy-path script the entrypoint runs. A script reached only by `migrate`
// would otherwise go unchecked until it failed mid-deploy.
const entries = process.argv.slice(2)
if (entries.length === 0) {
  console.error("usage: bun scripts/check-image-imports.ts <entry.ts> [entry.ts ...]")
  process.exit(2)
}

const seen = new Set<string>()
const missing: Array<{ from: string; spec: string }> = []

const walk = (file: string): void => {
  const abs = path.resolve(file)
  if (seen.has(abs)) return
  seen.add(abs)

  let src: string
  try {
    src = readFileSync(abs, "utf8")
  } catch {
    return // unreadable: reported by whoever referenced it
  }

  for (const spec of specifiersOf(src)) {
    const isRelative = spec.startsWith(".")
    const isSubpath = spec.startsWith("#")
    const isWorkspace = spec.startsWith(WORKSPACE_SCOPE)
    if (!isRelative && !isSubpath && !isWorkspace) continue // bare package — not our concern

    const base = isWorkspace
      ? resolveWorkspace(spec)
      : isSubpath
        ? resolveSubpath(spec)
        : path.resolve(path.dirname(abs), spec)
    const resolved = base ? resolveFile(base) : null
    if (!resolved) {
      missing.push({ from: path.relative(REPO, abs), spec })
      continue
    }
    walk(resolved)
  }
}

for (const entry of entries) walk(entry)

if (missing.length > 0) {
  console.error(`\n${missing.length} unresolved first-party import(s):\n`)
  for (const m of missing) console.error(`  ${m.from}\n    -> ${m.spec}`)
  console.error("\nA module the server imports is not present. If it is a new")
  console.error("cross-tree import (e.g. server -> src/lib), add it to the Dockerfile.\n")
  process.exit(1)
}

console.log(
  `import graph ok — ${seen.size} first-party modules resolved from ${entries.join(", ")}`,
)
