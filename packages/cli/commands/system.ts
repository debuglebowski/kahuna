import { requireHost, requireSession } from "../config.ts"
import { note, printOne } from "../output.ts"
import pkg from "../package.json" with { type: "json" }
import type { Command } from "../registry.ts"
import { health, version } from "../rest.ts"

export const systemCommands: ReadonlyArray<Command> = [
  {
    path: "system health",
    summary: "Is the deployment up and is its database reachable",
    usage: "system health [--json]",
    run: async (ctx) => {
      // Needs the host but NOT a session: this is the command you run when
      // something is wrong, and "my credential stopped working" is one of the
      // things that can be wrong.
      const host = requireHost()
      const result = await health(host)
      printOne(ctx.format, { host, ok: result.ok })
    },
  },
  {
    path: "system version",
    summary: "Which build is running, and whether a newer one is published",
    usage: "system version [--json]",
    run: async (ctx) => {
      const session = requireSession()
      const info = await version(session)
      printOne(ctx.format, {
        host: session.host,
        server: info.current,
        cli: pkg.version,
        latest: info.latest ?? "unknown",
        updateAvailable: info.updateAvailable,
      })
      if (ctx.format === "json") return
      if (info.updateAvailable) note(`A newer server build is published: ${info.latest}`)
      // The CLI carries its own COPY of the wire contract, compiled in at build
      // time. Against a server built from different sources, a procedure whose
      // shape changed fails inside a schema decode with a message about a field
      // nobody typed. Naming the skew here turns that into something actionable.
      if (info.current !== "dev" && info.current !== pkg.version) {
        note(
          `Note: this CLI is ${pkg.version} and the server is ${info.current}. ` +
            "If a command fails to decode a response, update the CLI first.",
        )
      }
    },
  },
]
