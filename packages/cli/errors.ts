/**
 * Every way this CLI can fail, mapped to an exit code a script can branch on.
 *
 * The codes are a contract with whoever writes `km … || handle $?`, so they are
 * enumerated here rather than invented per command. Anything unmapped is 1 —
 * "it failed" — never 0.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  notFound: 5,
  conflict: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** A failure with a message meant for a human and a code meant for a script. */
export class CliError extends Error {
  /** Exit status for `km ... || handle $?`. */
  readonly exitCode: ExitCode
  /** What to try instead. Printed on its own line, so it can be skipped. */
  readonly hint: string | undefined

  // Fields are declared and assigned rather than written as TypeScript
  // parameter properties: those EMIT code, so `node --experimental-strip-types`
  // refuses the file outright. The CLI has to stay runnable by plain Node.
  constructor(message: string, exitCode: ExitCode = EXIT.failed, hint?: string) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
    this.hint = hint
  }
}

/** The server's `RpcError` — `code`, `message`, `status` (see the contract). */
interface ServerError {
  readonly code?: string
  readonly message?: string
  readonly status?: number
}

const isServerError = (e: unknown): e is ServerError =>
  typeof e === "object" && e !== null && ("code" in e || "status" in e)

/**
 * Server codes worth translating. Everything else falls through to the code
 * itself: an unmapped code printed verbatim is debuggable, whereas "Request
 * failed" is not — the same reasoning as `AUTH_CONFIG_ERRORS` in the SPA.
 */
const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Not signed in.",
  NOT_A_MEMBER: "Your account is not a member of this organization.",
  DEACTIVATED: "Your account is deactivated in this organization.",
  NO_ACTIVE_ORG: "Your session has no active organization.",
  FORBIDDEN: "You do not have permission to do that.",
  MANAGED_READONLY: "That concept is managed by an integration and cannot be edited here.",
  VERSION_CONFLICT: "The record changed while this command was running.",
  NOT_FOUND: "No such record.",
  CONFLICT: "That name is already taken.",
  VALIDATION: "A value was rejected by the field's rules.",
  ILLEGAL_TRANSITION: "That enum field does not allow moving straight to that value.",
  RELATION_TARGET_MISMATCH: "That record belongs to a different concept than the relation targets.",
  FIELD_CONFIG_INVALID: "The field configuration is not valid for that kind.",
  // The block-not-cascade convention: deleting something still referenced is
  // refused rather than quietly taking its dependants with it. Each of these
  // needs to say WHAT is still using it, or the user just sees a wall.
  CONCEPT_IN_USE: "That concept still has records.",
  FIELD_IN_USE: "That field still holds values, or something references it.",
  RECORD_VERSION_IN_USE: "Another record still links to that version.",
  VERSIONING_IN_USE: "Versioning cannot be switched off while drafts or multiple versions exist.",
  TASK_STATUS_IN_USE: "Tasks still hold that status.",
  TASK_PRIORITY_IN_USE: "Tasks still hold that priority.",
  VERSION_FROZEN: "That version is published, so it cannot be edited.",
  DRAFT_EXISTS: "There is already an open draft for that record.",
  SINGLE_RECORD_PROTECTED: "A single-record concept always keeps its one record.",
  SINGLE_RECORD_CONFLICT:
    "That concept has more than one record, so it cannot become single-record.",
  RECORD_NOT_PUBLISHED: "That record has no published version yet.",
  ATTACHMENT_TOO_LARGE: "The file is larger than the server accepts.",
}

const HINTS: Record<string, string> = {
  UNAUTHENTICATED: "Run `km auth login` first.",
  NO_ACTIVE_ORG: "Ask an administrator to add you to the organization.",
  VERSION_CONFLICT: "Re-run the command; it re-reads before writing.",
  CONCEPT_IN_USE: "Delete or archive its records first, or archive the concept instead.",
  FIELD_IN_USE: "Archive the field instead — archiving keeps the data and is reversible.",
  VERSIONING_IN_USE: "Publish or discard the open drafts first.",
  VERSION_FROZEN: "Open a new draft: `km record version create <id>`.",
  DRAFT_EXISTS: "Publish or discard it: `km record version publish|discard <id>`.",
  ILLEGAL_TRANSITION: "`km concept get <concept>` shows the field's allowed values.",
}

/** HTTP status → exit code. The server speaks status; scripts want a code. */
export const exitCodeForStatus = (status: number | undefined): ExitCode => {
  switch (status) {
    case 401:
      return EXIT.unauthenticated
    case 403:
      return EXIT.forbidden
    case 404:
      return EXIT.notFound
    case 409:
      return EXIT.conflict
    default:
      return EXIT.failed
  }
}

/**
 * Normalise anything thrown — a `CliError`, the server's `RpcError`, a network
 * failure, a thrown string — into a message, a hint and an exit code.
 */
export const toFailure = (e: unknown): { message: string; hint?: string; exitCode: ExitCode } => {
  if (e instanceof CliError) return { message: e.message, hint: e.hint, exitCode: e.exitCode }

  if (isServerError(e)) {
    const code = e.code ?? ""
    const known = MESSAGES[code]
    return {
      // An unknown code is printed as-is; the server's own message follows when
      // it adds anything the code does not already say.
      message: known ?? (code || e.message || "Request failed"),
      hint: HINTS[code],
      exitCode: exitCodeForStatus(e.status),
    }
  }

  // A fetch failure is the common non-server case, and its message ("fetch
  // failed") is useless on its own — say which host could not be reached.
  if (e instanceof Error) return { message: e.message, exitCode: EXIT.failed }
  return { message: String(e), exitCode: EXIT.failed }
}
