/**
 * Assert that every first-party module the server imports actually exists.
 *
 * WHY THIS EXISTS: `server/automations.ts` imports `../src/lib/conditions` —
 * client-tree code that is genuinely server runtime code — and the Dockerfile
 * copied `app/server`, `app/engine`, `app/db` and `app/rpc` but not `app/src`.
 * The image built clean, passed its per-file `test -f` assertions, and then
 * could not boot at all: `Cannot find module '../src/lib/conditions'`, thrown at
 * import time before anything listened. Per-file assertions only catch omissions
 * somebody thought to list; this catches the general case.
 *
 * Run as a Docker build step, so it must not need a database, a network, or any
 * environment: it reads files and resolves paths, nothing more.
 *
 * Scope is deliberately FIRST-PARTY ONLY — relative specifiers and the `#engine`
 * / `#db` subpath imports. Bare specifiers (`effect`, `better-auth`) are the
 * package manager's problem, and `bun build` proved a poor proxy: it descends
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

/** `imports` map from the ROOT package.json — how `#engine` / `#db` resolve. */
const ROOT = path.resolve(import.meta.dirname, "../..")
const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  imports?: Record<string, string>
}
const IMPORT_MAP = rootPkg.imports ?? {}

/** Resolve a `#`-prefixed specifier through the root `imports` map. */
const resolveSubpath = (spec: string): string | null => {
  // Exact keys first ("#engine"), then wildcard keys ("#engine/*").
  const exact = IMPORT_MAP[spec]
  if (exact) return path.join(ROOT, exact)
  for (const [key, target] of Object.entries(IMPORT_MAP)) {
    if (!key.endsWith("/*")) continue
    const prefix = key.slice(0, -1) // "#engine/"
    if (!spec.startsWith(prefix)) continue
    return path.join(ROOT, target.replace("*", spec.slice(prefix.length)))
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
 * Instance } from "./api"`, where api.ts is client code the image has no reason
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

const entry = process.argv[2]
if (!entry) {
  console.error("usage: bun scripts/check-image-imports.ts <entry.ts>")
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
    if (!isRelative && !isSubpath) continue // bare package — not our concern

    const base = isSubpath ? resolveSubpath(spec) : path.resolve(path.dirname(abs), spec)
    const resolved = base ? resolveFile(base) : null
    if (!resolved) {
      missing.push({ from: path.relative(ROOT, abs), spec })
      continue
    }
    walk(resolved)
  }
}

walk(entry)

if (missing.length > 0) {
  console.error(`\n${missing.length} unresolved first-party import(s):\n`)
  for (const m of missing) console.error(`  ${m.from}\n    -> ${m.spec}`)
  console.error("\nA module the server imports is not present. If it is a new")
  console.error("cross-tree import (e.g. server -> src/lib), add it to the Dockerfile.\n")
  process.exit(1)
}

console.log(`import graph ok — ${seen.size} first-party modules resolved from ${entry}`)
