#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { accessCommands } from "./commands/access.ts"
import { attachmentCommands } from "./commands/attachment.ts"
import { authCommands } from "./commands/auth.ts"
import { automationCommands } from "./commands/automation.ts"
import { bulkCommands } from "./commands/bulk.ts"
import { conceptCommands } from "./commands/concept.ts"
import { dashboardCommands } from "./commands/dashboard.ts"
import { eventCommands } from "./commands/event.ts"
import { labelCommands } from "./commands/label.ts"
import { noteCommands } from "./commands/note.ts"
import { organizationCommands } from "./commands/organization.ts"
import { profileCommands } from "./commands/profile.ts"
import { recordCommands } from "./commands/record.ts"
import { relationCommands } from "./commands/relation.ts"
import { systemCommands } from "./commands/system.ts"
import { taskCommands } from "./commands/task.ts"
import { versionCommands } from "./commands/version.ts"
import { CliError, EXIT, toFailure } from "./errors.ts"
import type { Format } from "./output.ts"
import { note } from "./output.ts"
import pkg from "./package.json" with { type: "json" }
import { Registry } from "./registry.ts"

/**
 * `km` — the Kingsmaker command line.
 *
 *   km <noun> [<sub-noun>] <verb> [target] [--flags]
 *
 * Dispatch is a longest-prefix match over the registry; see registry.ts for why
 * that is unambiguous. Everything after the matched path is a positional
 * argument or a flag.
 */
export const registry = new Registry([
  ...authCommands,
  ...profileCommands,
  ...conceptCommands,
  ...bulkCommands,
  ...taskCommands,
  ...noteCommands,
  ...attachmentCommands,
  ...accessCommands,
  ...organizationCommands,
  ...dashboardCommands,
  ...automationCommands,
  ...labelCommands,
  ...recordCommands,
  ...relationCommands,
  ...versionCommands,
  ...eventCommands,
  ...systemCommands,
])

/** Flags every command accepts. Command-specific options are merged on top. */
const GLOBAL_OPTIONS = {
  json: { type: "boolean" as const },
  csv: { type: "boolean" as const },
  profile: { type: "string" as const },
  yes: { type: "boolean" as const, short: "y" },
  "dry-run": { type: "boolean" as const },
  help: { type: "boolean" as const, short: "h" },
}

const usage = (): string => {
  const lines = [
    "km — the Kingsmaker command line",
    "",
    "Usage: km <noun> [sub-noun] <verb> [args] [--flags]",
    "",
  ]
  let noun = ""
  for (const c of [...registry.commands].sort((a, b) => a.path.localeCompare(b.path))) {
    const head = c.path.split(" ")[0] ?? ""
    if (head !== noun) {
      lines.push("")
      noun = head
    }
    lines.push(`  km ${c.path.padEnd(22)} ${c.summary}`)
  }
  lines.push(
    "",
    "Global flags:",
    "  --version, -v     print this CLI's version and exit",
    "  --json            machine-readable output (stdout only)",
    "  --csv             comma-separated output",
    "  --profile <name>  which deployment to talk to",
    "  --yes, -y         do not ask before a destructive change",
    "  --dry-run         print what would happen and write nothing",
    "",
    "Environment: KM_HOST, KM_PROFILE, KM_TOKEN, XDG_CONFIG_HOME",
  )
  return lines.join("\n")
}

const formatOf = (flags: Record<string, unknown>): Format => {
  if (flags.json) return "json"
  if (flags.csv) return "csv"
  return "table"
}

export const run = async (argv: ReadonlyArray<string>): Promise<number> => {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`)
    return EXIT.ok
  }

  // The BARE version number on stdout, and no network. `--version` is what a
  // script greps and what a bug report quotes, so it answers instantly and
  // works before sign-in, on an unreachable host, with no profile configured.
  //
  // Not to be confused with `km system version`, which asks the DEPLOYMENT what
  // it is running and compares the two.
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${pkg.version}\n`)
    return EXIT.ok
  }

  const matched = registry.match(argv)
  if (!matched) {
    // A known noun with an unknown verb is a different mistake from an unknown
    // noun, and deserves a different answer: list what that noun can do.
    const noun = argv[0] ?? ""
    const near = registry.under(noun)
    note(`Unknown command: km ${argv.join(" ")}`)
    if (near.length > 0) {
      note("")
      note(`Commands under "${noun}":`)
      for (const c of near) note(`  km ${c.path.padEnd(22)} ${c.summary}`)
    } else {
      note("Run `km help` for the full list.")
    }
    return EXIT.usage
  }

  const { command, args } = matched
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...args],
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      // A typo'd flag must not be swallowed as a positional — `--jsno` silently
      // producing a table is exactly the kind of quiet wrongness that erodes
      // trust in a tool's output.
      strict: true,
    })
  } catch (e) {
    note(`km ${command.path}: ${e instanceof Error ? e.message : String(e)}`)
    if (command.usage) note(`Usage: km ${command.usage}`)
    return EXIT.usage
  }

  if (parsed.values.help) {
    process.stdout.write(`${command.summary}\n\nUsage: km ${command.usage ?? command.path}\n`)
    return EXIT.ok
  }

  try {
    await command.run({
      args: parsed.positionals,
      flags: parsed.values,
      format: formatOf(parsed.values),
      profile: parsed.values.profile as string | undefined,
    })
    return EXIT.ok
  } catch (e) {
    const { message, hint, exitCode } = toFailure(e)
    note(`km ${command.path}: ${message}`)
    if (hint) note(hint)
    if (exitCode === EXIT.usage && command.usage) note(`Usage: km ${command.usage}`)
    return exitCode
  }
}

/**
 * Only self-execute when this file IS the program, so tests can import `run`
 * without the CLI running itself.
 *
 * REALPATH, not the raw argv. An installed CLI is invoked through
 * `node_modules/.bin/km`, which is a SYMLINK to this file: `process.argv[1]` is
 * the link, `import.meta.url` is its target, and comparing them directly makes
 * this false for every real user. The command then exits 0 having done nothing
 * — silence a script reads as success. Caught by installing the packed tarball
 * and running it through the bin symlink, which CI now does.
 */
const isEntrypoint = (): boolean => {
  const argv = process.argv[1]
  if (!argv) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      // Anything that escapes `run` is a bug in the CLI, not a user error.
      const { message } = toFailure(e instanceof CliError ? e : new Error(String(e)))
      note(`km: ${message}`)
      process.exitCode = EXIT.failed
    })
}
