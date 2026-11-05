import { CliError, EXIT } from "./errors.ts"
import type { OrgMember } from "./rest.ts"

/**
 * A person as typed → a member's user id. Assignees are stored as BetterAuth
 * user ids, which nobody has to hand, so the CLI takes what people know: a user
 * id, an email, a name, or `me` (resolved by the caller — it needs a request).
 *
 * Exact beats loose: user id, then email, then full name (all case-insensitive
 * except the id), then a UNIQUE prefix of a name or email. Ambiguity is refused
 * with the candidates listed — guessing between two Annas assigns work to the
 * wrong person silently. Null when nothing matches; the caller decides whether
 * that is an error (assigning) or a raw pass-through (filtering a list, where a
 * former member can still hold tasks).
 */
export const matchMember = (members: ReadonlyArray<OrgMember>, input: string): OrgMember | null => {
  const s = input.trim()
  const n = s.toLowerCase()
  const byId = members.find((m) => m.userId === s)
  if (byId) return byId
  const exact = members.filter(
    (m) => m.email?.toLowerCase() === n || m.name?.trim().toLowerCase() === n,
  )
  if (exact.length === 1 && exact[0]) return exact[0]
  const loose =
    exact.length > 1
      ? exact
      : members.filter(
          (m) => m.email?.toLowerCase().startsWith(n) || m.name?.toLowerCase().startsWith(n),
        )
  if (loose.length === 1 && loose[0]) return loose[0]
  if (loose.length > 1) {
    throw new CliError(
      `"${input}" matches ${loose.length} members.`,
      EXIT.usage,
      loose.map((m) => `  ${describeMember(m)}`).join("\n"),
    )
  }
  return null
}

export const describeMember = (m: OrgMember): string =>
  [m.name, m.email && `<${m.email}>`, m.userId].filter(Boolean).join("  ")
