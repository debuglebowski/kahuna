import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CliError, EXIT } from "../errors.ts"
import { note, printOne } from "../output.ts"
import pkg from "../package.json" with { type: "json" }
import type { Command } from "../registry.ts"
import {
  classifyInstall,
  isNewer,
  latestVersion,
  refusal,
  renderCommand,
  type UpdateCommand,
  updateArgv,
} from "../selfupdate.ts"

/**
 * `allt cli update` — upgrade THIS binary.
 *
 * The noun split, restated because it is easy to get backwards: `allt system *`
 * asks the DEPLOYMENT about itself, `allt cli *` and `--version` are about the
 * command line in your hand. `allt system version` reports the server image from
 * GHCR; this reports the npm package.
 *
 * The decisions all live in selfupdate.ts so they can be tested without a
 * network or a package manager. What is left here is the spawn.
 */

/**
 * Run the package manager and wait.
 *
 * STDOUT GOES TO FD 2, deliberately. output.ts opens with "data on stdout,
 * everything else on stderr", and npm's progress chatter is not data — inherited
 * onto our stdout it would sit inside `allt cli update --json` and break every
 * consumer piping us to jq. The child still writes to a real terminal, so an
 * interactive run looks exactly the same.
 */
const runInstall = async (cmd: UpdateCommand): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd.command, [...cmd.args], {
      stdio: ["ignore", 2, 2],
      // npm and pnpm are `.cmd` shims on Windows, which Node will not exec
      // directly — the same guard browser-login.ts uses to launch a browser.
      shell: process.platform === "win32",
    })

    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(
        new CliError(
          e.code === "ENOENT"
            ? `\`${cmd.command}\` is not on your PATH.`
            : `Could not run \`${cmd.command}\` (${e.message}).`,
          EXIT.failed,
          `Run \`${renderCommand(cmd)}\` yourself.`,
        ),
      )
    })

    child.on("close", (code) => {
      if (code === 0) return resolve()
      reject(
        new CliError(
          `\`${renderCommand(cmd)}\` exited ${code ?? "abnormally"}.`,
          EXIT.failed,
          // The overwhelmingly common failure for a global install: npm's
          // default prefix is root-owned on macOS and most Linux distributions.
          "If that was a permissions error, re-run it with sudo — or move your global prefix somewhere you own.",
        ),
      )
    })
  })

export const cliCommands: ReadonlyArray<Command> = [
  {
    path: "cli update",
    summary: "Upgrade this CLI to the newest published version",
    usage: "cli update [--dry-run] [--json]",
    run: async (ctx) => {
      // No session and no host: the CLI is upgradable on a machine that has
      // never signed in, and on one whose deployment is down. This talks to the
      // npm registry, not to your deployment.
      const current = pkg.version
      const latest = await latestVersion()

      if (!isNewer(latest, current)) {
        printOne(ctx.format, { current, latest, updateAvailable: false })
        if (ctx.format !== "json") note("Already on the newest published version.")
        return
      }

      const kind = classifyInstall(fileURLToPath(import.meta.url))
      if (kind === "local" || kind === "npx" || kind === "source") {
        const { message, hint } = refusal(kind)
        throw new CliError(`${message} ${latest} is published.`, EXIT.failed, hint)
      }

      const cmd = updateArgv(kind)
      const rendered = renderCommand(cmd)

      if (ctx.flags["dry-run"]) {
        printOne(ctx.format, {
          current,
          latest,
          updateAvailable: true,
          manager: kind,
          command: rendered,
          updated: false,
        })
        if (ctx.format !== "json") note(`Would run: ${rendered}`)
        return
      }

      if (ctx.format !== "json") note(`Updating ${current} -> ${latest} with \`${rendered}\`…`)
      await runInstall(cmd)

      printOne(ctx.format, {
        current,
        latest,
        updateAvailable: true,
        manager: kind,
        command: rendered,
        updated: true,
      })
      // `current` above is the version that RAN this command; the process still
      // holds the old bundle in memory. Saying which version is now on disk
      // avoids the "it says 0.0.8, did it work?" question.
      if (ctx.format !== "json") note(`Updated to ${latest}. Run \`allt --version\` to confirm.`)
    },
  },
]
