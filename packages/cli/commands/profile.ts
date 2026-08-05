import { DEFAULT_HOST, loadConfig, saveConfig } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"

/**
 * Named deployments. Local file only — nothing here talks to a server, so
 * these commands work offline and before any sign-in.
 */
export const profileCommands: ReadonlyArray<Command> = [
  {
    path: "profile list",
    summary: "List configured deployments",
    usage: "profile list [--json]",
    run: async (ctx) => {
      const config = loadConfig()
      const rows = Object.entries(config.profiles).map(([name, p]) => ({
        current: name === config.current ? "*" : "",
        name,
        host: p.host,
        email: p.email ?? "",
        // Never the cookie itself — this output gets pasted into issues.
        signedIn: p.cookie ? "yes" : "no",
      }))
      if (rows.length === 0) note("No profiles yet. Run `km auth login --host <url>`.")
      printRows(ctx.format, rows, ["current", "name", "host", "email", "signedIn"])
    },
  },
  {
    path: "profile add",
    summary: "Add a deployment without signing in",
    usage: "profile add <name> --host <url>",
    options: { host: { type: "string" } },
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A profile name is required.", EXIT.usage)
      const config = loadConfig()
      if (config.profiles[name])
        throw new CliError(`Profile "${name}" already exists.`, EXIT.conflict)
      const host = ((ctx.flags.host as string | undefined) ?? DEFAULT_HOST).replace(/\/+$/, "")
      config.profiles[name] = { host }
      config.current ??= name
      saveConfig(config)
      note(`Added profile "${name}" -> ${host}.`)
    },
  },
  {
    path: "profile use",
    summary: "Make a deployment the default for later commands",
    usage: "profile use <name>",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A profile name is required.", EXIT.usage)
      const config = loadConfig()
      if (!config.profiles[name]) {
        throw new CliError(`No profile named "${name}".`, EXIT.notFound, "See `km profile list`.")
      }
      config.current = name
      saveConfig(config)
      note(`Now using "${name}" (${config.profiles[name].host}).`)
    },
  },
  {
    path: "profile remove",
    summary: "Forget a deployment and its stored session",
    usage: "profile remove <name>",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("A profile name is required.", EXIT.usage)
      const config = loadConfig()
      if (!config.profiles[name]) {
        throw new CliError(`No profile named "${name}".`, EXIT.notFound, "See `km profile list`.")
      }
      delete config.profiles[name]
      // Leaving `current` pointing at a deleted profile would make every later
      // command fail with "no profile" until someone noticed why.
      if (config.current === name) config.current = Object.keys(config.profiles)[0]
      saveConfig(config)
      note(`Removed profile "${name}".`)
    },
  },
]
