import { loadConfig, resolveProfile } from "../config.ts"
import { note, printOne } from "../output.ts"
import type { Command } from "../registry.ts"
import { health, version } from "../rest.ts"

export const systemCommands: ReadonlyArray<Command> = [
  {
    path: "system health",
    summary: "Is the deployment up and is its database reachable",
    usage: "system health [--profile <name>] [--json]",
    run: async (ctx) => {
      // Deliberately does NOT require a session: this is the command you run
      // when something is wrong, which includes "my credential stopped working".
      const config = loadConfig()
      const { profile } = resolveProfile(config, ctx.profile)
      const result = await health(profile.host)
      printOne(ctx.format, { host: profile.host, ok: result.ok })
    },
  },
  {
    path: "system version",
    summary: "Which build is running, and whether a newer one is published",
    usage: "system version [--profile <name>] [--json]",
    run: async (ctx) => {
      const { profile } = resolveProfile(loadConfig(), ctx.profile)
      const info = await version(profile)
      printOne(ctx.format, {
        host: profile.host,
        running: info.current,
        latest: info.latest ?? "unknown",
        updateAvailable: info.updateAvailable,
      })
      if (info.updateAvailable && ctx.format !== "json") {
        note(`A newer build is published: ${info.latest}`)
      }
    },
  },
]
