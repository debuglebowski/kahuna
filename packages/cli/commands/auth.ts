import { createInterface } from "node:readline/promises"
import { DEFAULT_HOST, loadConfig, resolveProfile, saveConfig, upsertProfile } from "../config.ts"
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
    // Mute the echo by intercepting the output stream while reading.
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

export const authCommands: ReadonlyArray<Command> = [
  {
    path: "auth login",
    summary: "Sign in to a deployment and store the session",
    usage: "auth login [--host <url>] [--email <address>] [--profile <name>]",
    options: {
      host: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
    },
    run: async (ctx) => {
      const config = loadConfig()
      const name = ctx.profile ?? process.env.KM_PROFILE ?? config.current ?? "default"
      const host = (
        (ctx.flags.host as string | undefined) ??
        process.env.KM_HOST ??
        config.profiles[name]?.host ??
        DEFAULT_HOST
      ).replace(/\/+$/, "")

      const email = (ctx.flags.email as string | undefined) ?? (await prompt("Email: "))
      // --password exists for scripts, but it lands in shell history and `ps`,
      // so the interactive path stays the default and is never echoed.
      const password =
        (ctx.flags.password as string | undefined) ??
        process.env.KM_PASSWORD ??
        (await prompt("Password: ", true))

      if (!email || !password) {
        throw new CliError("Email and password are required.", EXIT.usage)
      }

      const result = await signIn(host, email, password)
      upsertProfile(name, { host, cookie: result.cookie, email: result.email })
      note(`Signed in to ${host} as ${result.email} (profile "${name}").`)
    },
  },
  {
    path: "auth logout",
    summary: "Drop the stored session for a profile",
    usage: "auth logout [--profile <name>]",
    run: async (ctx) => {
      const config = loadConfig()
      const { name, profile } = resolveProfile(config, ctx.profile)
      await signOut(profile)
      const stored = config.profiles[name]
      if (stored) {
        // Keep the profile and its host — only the credential goes. Deleting the
        // whole entry would make `km auth login` ask for the host again.
        config.profiles[name] = { host: stored.host }
        saveConfig(config)
      }
      note(`Signed out of profile "${name}".`)
    },
  },
  {
    path: "auth whoami",
    summary: "Show who you are signed in as, and what you may do",
    usage: "auth whoami [--profile <name>] [--json]",
    run: async (ctx) => {
      const { name, profile } = resolveProfile(loadConfig(), ctx.profile)
      const api = makeRuntime(profile)
      try {
        const access = await api.call((c) => c.myAccess())
        printOne(ctx.format, {
          profile: name,
          host: profile.host,
          email: profile.email ?? "",
          ...(access as Record<string, unknown>),
        })
      } finally {
        await api.dispose()
      }
    },
  },
]
