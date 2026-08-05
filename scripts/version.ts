/**
 * One version for the whole repo.
 *
 *   bun scripts/version.ts 0.1.0     set every package to 0.1.0
 *   bun scripts/version.ts --check   assert they already agree
 *
 * WHY A SCRIPT RATHER THAN A CONVENTION: four manifests that must hold the same
 * string will not, eventually. The `--check` mode runs in CI, so the moment one
 * drifts the build says so instead of a release shipping a CLI that claims to be
 * a different version than the server it was built alongside.
 *
 * The git tag is the release trigger, but it is NOT the source of the version —
 * these files are. A tag that disagrees with them is a mistake worth failing on,
 * which is what the publish workflow asserts. Deriving the version from the tag
 * instead would mean the source that built an artifact never records what it
 * built, and `git show v0.1.0:packages/cli/package.json` would say 0.0.0.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

/** Every manifest that carries a version: the workspace root plus each member. */
const manifests = (): ReadonlyArray<string> => {
  const packages = path.join(ROOT, "packages")
  const members = readdirSync(packages, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(packages, e.name, "package.json"))
    .filter((p) => {
      try {
        readFileSync(p)
        return true
      } catch {
        return false // a directory under packages/ that is not a package
      }
    })
  return [path.join(ROOT, "package.json"), ...members]
}

const versionOf = (file: string): string =>
  (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "(none)"

const rel = (file: string): string => path.relative(ROOT, file)

const [arg] = process.argv.slice(2)

if (!arg) {
  console.error("usage: bun scripts/version.ts <x.y.z> | --check")
  process.exit(2)
}

const files = manifests()

if (arg === "--check") {
  const versions = new Map(files.map((f) => [rel(f), versionOf(f)]))
  const distinct = new Set(versions.values())
  if (distinct.size === 1) {
    console.log(`all ${versions.size} packages at ${[...distinct][0]}`)
    process.exit(0)
  }
  console.error("package versions disagree:\n")
  for (const [file, version] of versions) console.error(`  ${version.padEnd(12)} ${file}`)
  console.error("\nRun `bun run version:set <x.y.z>` to set them all.")
  process.exit(1)
}

// Semver, strictly. A tag like `v0.1` or `0.1.0-rc.1 ` would otherwise be
// written into four files and only fail later, at publish, in another repo's CI.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(arg)) {
  console.error(`"${arg}" is not a semantic version (x.y.z, optionally -prerelease).`)
  process.exit(2)
}

for (const file of files) {
  const text = readFileSync(file, "utf8")
  // A targeted replacement rather than parse-and-stringify: rewriting the JSON
  // would reorder or reformat fields biome then has an opinion about, turning a
  // version bump into a diff nobody can read.
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${arg}"`)
  if (next === text) {
    console.error(`no "version" field in ${rel(file)}`)
    process.exit(1)
  }
  writeFileSync(file, next)
  console.log(`${rel(file).padEnd(34)} -> ${arg}`)
}

console.log(`\nNow: git commit -am "release ${arg}" && git tag v${arg} && git push --follow-tags`)
