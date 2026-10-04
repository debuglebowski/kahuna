import { createInterface } from "node:readline/promises"
import { browserLogin } from "../browser-login.ts"
import { loadConfig, requireSession, saveConfig, stripSlash } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printOne } from "../output.ts"
import type { Command } from "../registry.ts"
import { signIn, signOut } from "../rest.ts"
import { makeRuntime } from "../transport.ts"

/** Read a secret without echoing it. Falls back to a plain read when stdin is
 *  not a TTY (a pipe), which is how CI supplies it. */
const prompt = async (question: string, secret = false): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !secret })
  try {
    if (!secret) return (await rl.question(question)).trim()
    process.stderr.write(question)
    const muted = rl.question("")
    const output = rl as unknown as { output?: NodeJS.WriteStream }
    const write = output.output?.write.bind(output.output)
    if (output.output && write) output.output.write = (() => true) as typeof write
    const answer = await muted
    if (output.output && write) output.output.write = write
    process.stderr.write("\n")
    return answer.trim()
  } finally {
    rl.close()
  }
}

/**
 * WHICH DEPLOYMENT, and never guessed.
 *
 * `--host`, then KAHUNA_HOST, then whatever a previous sign-in stored. If none of
 * those know, ask — and if there is nobody to ask, fail. This used to fall
 * through to `http://localhost:3100`, so someone with a remote deployment was
 * asked for their password by a CLI quietly aiming at their own laptop.
 */
const resolveHost = async (flagHost: string | undefined): Promise<string> => {
  const known = flagHost ?? process.env.KAHUNA_HOST ?? loadConfig().host
  if (known) return stripSlash(known)
  if (!process.stdin.isTTY) {
    throw new CliError(
      "No deployment configured.",
      EXIT.usage,
      "Pass --host <url>, or set KAHUNA_HOST.",
    )
  }
  const asked = await prompt("Deployment URL: ")
  if (!asked) throw new CliError("A deployment URL is required.", EXIT.usage)
  return stripSlash(asked)
}

export const authCommands: ReadonlyArray<Command> = [
  {
    path: "auth login",
    summary: "Sign in to a deployment and store the session",
    usage: "auth login [--host <url>] [--browser] [--email <address>]",
    options: {
      host: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      browser: { type: "boolean" },
    },
    run: async (ctx) => {
      const host = await resolveHost(ctx.flags.host as string | undefined)
      note(`Signing in to ${host}`)

      if (ctx.flags.browser) {
        const viaBrowser = await browserLogin(host)
        saveConfig({ host, cookie: viaBrowser.cookie, email: viaBrowser.email })
        note("Signed in.")
        return
      }

      const email = (ctx.flags.email as string | undefined) ?? (await prompt("Email: "))
      // --password exists for scripts, but it lands in shell history and `ps`,
      // so the interactive path stays the default and is never echoed.
      const password =
        (ctx.flags.password as string | undefined) ??
        process.env.KAHUNA_PASSWORD ??
        (await prompt("Password: ", true))

      if (!email || !password) {
        throw new CliError("Email and password are required.", EXIT.usage)
      }

      const result = await signIn(host, email, password)
      saveConfig({ host, cookie: result.cookie, email: result.email })
      note(`Signed in as ${result.email}.`)
    },
  },
  {
    path: "auth logout",
    summary: "Drop the stored session",
    usage: "auth logout",
    run: async () => {
      const config = loadConfig()
      if (config.cookie && config.host) {
        await signOut({ host: config.host, cookie: config.cookie })
      }
      // Keep the host — only the credential goes. Dropping it too would make the
      // next `kahuna auth login` ask for the deployment URL again.
      saveConfig({ host: config.host })
      note("Signed out.")
    },
  },
  {
    path: "auth whoami",
    summary: "Show who you are signed in as, and what you may do",
    usage: "auth whoami [--json]",
    run: async (ctx) => {
      const session = requireSession()
      const api = makeRuntime(session)
      try {
        const access = await api.call((c) => c.myAccess())
        printOne(ctx.format, {
          host: session.host,
          email: session.email ?? "",
          ...(access as Record<string, unknown>),
        })
      } finally {
        await api.dispose()
      }
    },
  },
]
