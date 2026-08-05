import { CliError, EXIT } from "./errors.ts"

/**
 * Read-then-write, because almost every mutation in this API takes an
 * `expectedVersion` (`updateRecord(id, expectedVersion, patch)`, and the same
 * for tasks, notes, archive and publish).
 *
 * The CLI therefore cannot write without first reading the current version, and
 * two writers racing will collide. That is a property of the API, not of any one
 * command, so it lives here — one helper — rather than being re-derived (and
 * re-broken) per command.
 *
 * ONE retry, and only on a version conflict. A conflict means someone else's
 * write landed between our read and our write; re-reading and re-applying is
 * usually right and always what the user meant. Retrying forever would turn a
 * genuine fight over a record into an infinite loop, and retrying anything else
 * would replay a write the server rejected on purpose.
 */
const CONFLICT = "VERSION_CONFLICT"

const isConflict = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === CONFLICT

export interface Versioned {
  readonly version: number
}

export const withVersion = async <T extends Versioned, R>(
  read: () => Promise<T>,
  write: (current: T) => Promise<R>,
  options?: { readonly retry?: boolean },
): Promise<R> => {
  const current = await read()
  try {
    return await write(current)
  } catch (e) {
    if (!isConflict(e) || options?.retry === false) throw e
    // Re-read and try exactly once more.
    const fresh = await read()
    try {
      return await write(fresh)
    } catch (again) {
      if (!isConflict(again)) throw again
      throw new CliError(
        "The record kept changing while this command ran.",
        EXIT.conflict,
        "Something else is writing to it — retry when it settles.",
      )
    }
  }
}

/**
 * Guard a destructive, irreversible action.
 *
 * `delete` PURGES — the archive/restore pair is the reversible one. The web app
 * guards this with a confirm dialog; a CLI has to guard it with a flag, or the
 * first person to shell-loop a delete finds out afterwards.
 */
export const requireConfirmation = (
  flags: { yes?: unknown; "dry-run"?: unknown },
  what: string,
): void => {
  if (flags["dry-run"]) return
  if (flags.yes) return
  throw new CliError(
    `Refusing to ${what} without confirmation.`,
    EXIT.usage,
    "This cannot be undone. Pass --yes to proceed, or --dry-run to see what would happen.",
  )
}
