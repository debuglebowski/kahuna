import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { CliError, EXIT } from "./errors.ts"

/**
 * Where the CLI keeps the deployment it talks to, and the session for it.
 *
 * ONE deployment. There is no profile list and no `--profile` flag: this is one
 * organization per deployment, and a naming scheme for a file with a single
 * entry is overhead.
 *
 * THE FILE HOLDS A LIVE CREDENTIAL. It is written 0600 through a temp file +
 * rename, so a crash mid-write cannot leave a half-parsed config, and the
 * secret is never briefly world-readable between create and chmod.
 */
export interface Config {
  /** Base URL of the deployment, no trailing slash. No default; see `requireHost`. */
  readonly host?: string
  /** The BetterAuth session cookie, verbatim, as sent back by sign-in. */
  readonly cookie?: string
  /** Who this session belongs to. Display only; the server decides identity. */
  readonly email?: string
}

/**
 * XDG first, then `~/.config`. Not `~/.kahuna`: a user who has set
 * XDG_CONFIG_HOME has said where config belongs, and ignoring that scatters
 * state they expect to be able to back up or wipe in one place.
 */
export const configDir = (): string =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "kahuna")

export const configPath = (): string => path.join(configDir(), "config.json")

/**
 * Where config lived under earlier names (`allting`, and before that
 * `kingsmaker` when this CLI was `km`). READ as a fallback, never written:
 * someone who reinstalls across a rename keeps their session instead of
 * silently landing back on the sign-in prompt.
 */
const legacyConfigPaths = (): string[] =>
  ["allting", "kingsmaker"].map((name) =>
    path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), name, "config.json"),
  )

export const loadConfig = (): Config => {
  for (const file of [configPath(), ...legacyConfigPaths()]) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Config
    } catch (e) {
      // Absent is normal — a first run has no config, and an install postdating
      // the rename has no legacy file. Present but unparseable is NOT: silently
      // starting fresh would drop the stored session and leave someone
      // wondering why they keep having to sign in.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new CliError(
          `${file} is not valid JSON.`,
          EXIT.failed,
          "Fix or delete the file, then run `kahuna auth login` again.",
        )
      }
    }
  }
  return {}
}

export const saveConfig = (config: Config): void => {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.config.json.${process.pid}`)
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600) // explicit: an inherited umask can widen the mode above
  renameSync(tmp, configPath())
}

export const stripSlash = (url: string): string => url.replace(/\/+$/, "")

/**
 * The deployment this command talks to.
 *
 * THERE IS NO DEFAULT. This used to fall back to `http://localhost:3100`, so
 * someone with a remote deployment was asked for their password by a CLI
 * quietly aiming at their own laptop, and found out when the connection failed.
 * An unconfigured CLI now says so instead of guessing.
 *
 * `KAHUNA_HOST` wins over the stored host, so CI can point at another deployment
 * without writing to disk.
 */
export const requireHost = (config: Config = loadConfig()): string => {
  const host = process.env.KAHUNA_HOST ?? config.host
  if (!host) {
    throw new CliError(
      "No deployment configured.",
      EXIT.usage,
      "Run `kahuna auth login --host <url>`, or set KAHUNA_HOST.",
    )
  }
  return stripSlash(host)
}

/** Host plus stored session — what every authenticated command needs. */
export interface Session {
  readonly host: string
  readonly cookie: string
  readonly email?: string
}

export const requireSession = (): Session => {
  const config = loadConfig()
  const host = requireHost(config)
  if (!config.cookie) {
    throw new CliError("Not signed in.", EXIT.unauthenticated, "Run `kahuna auth login` first.")
  }
  return { host, cookie: config.cookie, email: config.email }
}
