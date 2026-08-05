import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { CliError, EXIT } from "./errors.ts"

/**
 * Where the CLI keeps its profiles, and the session cookie for each.
 *
 * THE FILE HOLDS A LIVE CREDENTIAL. It is written 0600 through a temp file +
 * rename, so a crash mid-write cannot leave a half-parsed config, and the
 * secret is never briefly world-readable between create and chmod.
 */
export interface Profile {
  /** Base URL of the deployment, no trailing slash — e.g. `http://localhost:3100`. */
  readonly host: string
  /** The BetterAuth session cookie, verbatim, as sent back by sign-in. */
  readonly cookie?: string
  /** Who this session belongs to. Display only; the server decides identity. */
  readonly email?: string
}

export interface Config {
  /** Name of the profile commands use when `--profile` is absent. */
  current?: string
  profiles: Record<string, Profile>
}

const EMPTY: Config = { profiles: {} }

/**
 * XDG first, then `~/.config`. Not `~/.kingsmaker`: a user who has set
 * XDG_CONFIG_HOME has said where config belongs, and ignoring that scatters
 * state they expect to be able to back up or wipe in one place.
 */
export const configDir = (): string =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "kingsmaker")

export const configPath = (): string => path.join(configDir(), "config.json")

export const loadConfig = (): Config => {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Config
    return { current: raw.current, profiles: raw.profiles ?? {} }
  } catch (e) {
    // Absent is normal — a first run has no config. Present but unparseable is
    // NOT: silently starting from scratch would drop the user's other profiles
    // on the next save.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ...EMPTY }
    throw new CliError(
      `${configPath()} is not valid JSON.`,
      EXIT.failed,
      "Fix or delete the file, then run `km auth login` again.",
    )
  }
}

export const saveConfig = (config: Config): void => {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.config.json.${process.pid}`)
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600) // explicit: an inherited umask can widen the mode above
  renameSync(tmp, configPath())
}

/** The default host, used when a profile is created without one. */
export const DEFAULT_HOST = "http://localhost:3100"

const stripSlash = (url: string): string => url.replace(/\/+$/, "")

export interface Resolved {
  readonly name: string
  readonly profile: Profile
  /** True when the host came from KM_HOST rather than the stored profile. */
  readonly hostOverridden: boolean
}

/**
 * Which deployment this invocation talks to, and with which credential.
 *
 * Precedence is explicit-beats-implicit: `--profile`, then `KM_PROFILE`, then
 * the stored `current`. `KM_HOST` overrides the host of whichever profile that
 * lands on, so CI can point an existing profile at a different deployment
 * without writing to disk.
 */
export const resolveProfile = (config: Config, flag?: string): Resolved => {
  const name = flag ?? process.env.KM_PROFILE ?? config.current ?? "default"
  const stored = config.profiles[name]
  const envHost = process.env.KM_HOST

  if (!stored && !envHost) {
    throw new CliError(
      flag || process.env.KM_PROFILE ? `No profile named "${name}".` : "No profile configured.",
      EXIT.usage,
      "Run `km auth login --host <url>`, or set KM_HOST.",
    )
  }

  const profile: Profile = {
    ...(stored ?? {}),
    host: stripSlash(envHost ?? stored?.host ?? DEFAULT_HOST),
  }
  return { name, profile, hostOverridden: Boolean(envHost) }
}

/** Write one profile back, creating it if new, and make it current. */
export const upsertProfile = (name: string, patch: Partial<Profile> & { host: string }): void => {
  const config = loadConfig()
  config.profiles[name] = { ...config.profiles[name], ...patch }
  config.current ??= name
  saveConfig(config)
}
