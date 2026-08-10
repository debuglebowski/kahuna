import type { ParseArgsConfig } from "node:util"
import type { Format } from "./output.ts"

/**
 * The command table. One entry per `noun [sub-noun] verb` path.
 *
 * THE GRAMMAR, restated because the parser depends on it:
 *
 *   km <noun> [<sub-noun>] <verb> [target] [--flags]
 *
 * The first token after a noun is a verb or a sub-noun — NEVER an id. That is
 * what lets dispatch match the longest known path and treat everything after it
 * as arguments, with no guessing and no ambiguity between `task status list`
 * (the status catalogue) and `task update <id> --status done` (one task's
 * status). `registry.test.ts` enforces it, so the rule cannot decay into a
 * parser special case.
 */
export interface CommandContext {
  /** Positional arguments after the command path. */
  readonly args: ReadonlyArray<string>
  /** Parsed flags for this command, plus the global ones. */
  readonly flags: Record<string, string | boolean | Array<string | boolean> | undefined>
  readonly format: Format
}

export interface Command {
  /** Space-separated path, e.g. "record relation add". */
  readonly path: string
  /** One line, shown in `km help`. */
  readonly summary: string
  /** Usage line shown on a usage error, without the leading `km`. */
  readonly usage?: string
  /** Command-specific flags, merged with the global set. */
  readonly options?: ParseArgsConfig["options"]
  readonly run: (ctx: CommandContext) => Promise<void>
}

/** Verbs the grammar allows. A path whose last token is not here is a bug. */
export const VERBS = new Set([
  "list",
  "get",
  "create",
  "update",
  "delete",
  "archive",
  "restore",
  // Domain verbs, only where the domain really has one.
  "login",
  "logout",
  "whoami",
  "add",
  "remove",
  "health",
  "version",
  "search",
  "open",
  "publish",
  "discard",
  "transition",
  "assign",
  "unassign",
  "reorder",
  "set",
  "move",
  "types",
  "sync",
  "check",
  "import",
  "export",
  "upload",
  "download",
  "purge",
  "holders",
  // Deactivation is its own reversible pair, NOT archive/restore. Reusing
  // `restore` here would make one verb mean two different mechanisms, which is
  // exactly what "a verb means the same thing under every noun" forbids.
  "deactivate",
  "reactivate",
  "changed",
  "runs",
  "test",
] as const)

export class Registry {
  private readonly byPath = new Map<string, Command>()
  /** Longest path first, so matching never stops at a shorter prefix. */
  private readonly paths: Array<Array<string>> = []

  constructor(commands: ReadonlyArray<Command>) {
    for (const c of commands) {
      if (this.byPath.has(c.path)) throw new Error(`duplicate command path: ${c.path}`)
      this.byPath.set(c.path, c)
      this.paths.push(c.path.split(" "))
    }
    this.paths.sort((a, b) => b.length - a.length)
  }

  get commands(): ReadonlyArray<Command> {
    return [...this.byPath.values()]
  }

  /**
   * Longest-prefix match over argv. Returns the command and the positionals
   * that follow it, or null when nothing matches.
   */
  match(argv: ReadonlyArray<string>): { command: Command; args: ReadonlyArray<string> } | null {
    for (const path of this.paths) {
      if (path.length > argv.length) continue
      if (path.every((token, i) => token === argv[i])) {
        const command = this.byPath.get(path.join(" "))
        if (command) return { command, args: argv.slice(path.length) }
      }
    }
    return null
  }

  /** Every path starting with this noun — for "did you mean" on a partial. */
  under(prefix: string): ReadonlyArray<Command> {
    return this.commands.filter((c) => c.path === prefix || c.path.startsWith(`${prefix} `))
  }
}
