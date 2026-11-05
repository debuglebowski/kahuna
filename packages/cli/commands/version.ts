import {
  latestVersionName,
  nextVersionName,
  type RecordVersion,
  versionDate,
} from "@kahunalabs/contract"
import { requireSession, type Session } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { withVersion } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import { matchMember } from "../people.ts"
import type { Command } from "../registry.ts"
import { orgMembers, sessionUserId } from "../rest.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Draft → published, for concepts with versioning switched on — plus the
 * release info that makes the version list a policy's Document History: a
 * name ("1.2.0"), a change note, a date, author and approver.
 *
 * `listVersions` / `import` take a RECORD id (the lineage); `publish`,
 * `approve`, `reject`, `withdraw`, `update` and `discard` take a VERSION id. The
 * rename made that distinction visible in the names, so the commands keep it
 * visible in their arguments too.
 */
const withApi = async <T>(f: (api: Api, session: Session) => Promise<T>): Promise<T> => {
  const session = requireSession()
  const api = makeRuntime(session)
  try {
    return await f(api, session)
  } finally {
    await api.dispose()
  }
}

/** A version id addresses one version; a record id addresses the lineage. */
const recordIdOf = async (api: Api, id: string): Promise<string> => {
  const detail = await api.call((c) => c.getRecord({ id })).catch(() => null)
  return detail ? detail.recordVersion.recordId : id
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** A person as typed (id, email, name, `me`) → their user id. */
const resolvePerson = async (session: Session, input: string): Promise<string> => {
  if (input.trim().toLowerCase() === "me") return await sessionUserId(session)
  const member = matchMember(await orgMembers(session), input)
  if (member) return member.userId
  throw new CliError(
    `No member matches "${input}".`,
    EXIT.notFound,
    "Pass a user id, email, name, or `me`. `kahuna organization member list` shows user ids.",
  )
}

const label = (v: RecordVersion): string => v.release.name ?? `v${v.versionSeq}`

const RELEASE_HELP = `
Release info (all optional):
  --name 1.2.0        version name, free text; defaults to the latest named
                      version with its last number bumped (1.1.0 → 1.1.1)
  --note "..."        change note
  --date YYYY-MM-DD   document date (default: the day it's published)`

const RELEASE_OPTIONS = {
  name: { type: "string" },
  note: { type: "string" },
  date: { type: "string" },
} as const

export const versionCommands: ReadonlyArray<Command> = [
  {
    path: "record version list",
    summary: "The version history of one record",
    usage: "record version list <record-id | version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      await withApi(async (api, session) => {
        const recordId = await recordIdOf(api, id)
        const versions = await api.call((c) => c.listVersions({ recordId }))
        const people = await orgMembers(session).catch(() => [])
        const nameOf = (userId: string | null) =>
          userId ? (people.find((m) => m.userId === userId)?.name ?? userId) : null
        printRows(
          ctx.format,
          versions.map((v) => {
            const r = v.release
            return {
              id: v.id,
              name: label(v),
              status: r.pending
                ? `awaiting ${nameOf(r.pending.approverId)}`
                : r.historical
                  ? "imported"
                  : v.archivedAt
                    ? "archived"
                    : v.versionStatus,
              date: v.versionStatus === "published" ? versionDate(v) : "",
              author: nameOf(r.publishedBy) ?? r.attributedAuthor ?? "",
              approver: nameOf(r.approvedBy) ?? r.attributedApprover ?? "",
              note: r.pending?.note ?? r.note ?? "",
            }
          }),
          ["id", "name", "status", "date", "author", "approver", "note"],
        )
      })
    },
  },
  {
    path: "record version create",
    summary: "Open a new draft cloned from the record",
    usage: "record version create <record-id | version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      await withApi(async (api) => {
        const recordId = await recordIdOf(api, id)
        if (ctx.flags["dry-run"]) {
          note(`Would open a new draft on ${recordId}.`)
          return
        }
        const draft = await api.call((c) => c.newVersion({ recordId }))
        note(`Opened draft ${draft.id} (v${draft.versionSeq}).`)
      })
    },
  },
  {
    path: "record version publish",
    summary: "Publish a draft (permanent), or send it for approval",
    usage:
      "record version publish <version-id> [--name 1.2.0] [--note ...] [--date YYYY-MM-DD] [--approver <person>]",
    help: `${RELEASE_HELP}
  --approver <person> request approval instead of publishing: the draft locks
                      and publishes when they approve (\`record version approve\`).
                      Required when the concept says every publish needs
                      approval. A user id, email, name, or \`me\`.`,
    options: { ...RELEASE_OPTIONS, approver: { type: "string" } },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(async (api, session) => {
        const approverInput = str(ctx.flags.approver)
        const approverId = approverInput ? await resolvePerson(session, approverInput) : undefined
        const current = (await api.call((c) => c.getRecord({ id }))).recordVersion
        const versions = await api.call((c) => c.listVersions({ recordId: current.recordId }))
        const name =
          str(ctx.flags.name) ??
          nextVersionName(latestVersionName(versions.filter((v) => !v.archivedAt)))
        if (ctx.flags["dry-run"]) {
          note(
            approverId
              ? `Would request approval of ${name} (${id}) from ${approverInput}.`
              : `Would publish ${name} (${id}). Publishing is permanent.`,
          )
          return
        }
        const result = await withVersion(
          async () => (await api.call((c) => c.getRecord({ id }))).recordVersion,
          (fresh) =>
            api.call((c) =>
              c.publishVersion({
                id,
                expectedVersion: fresh.version,
                name,
                note: str(ctx.flags.note),
                effectiveDate: str(ctx.flags.date),
                approverId,
              }),
            ),
        )
        note(
          result.release.pending
            ? `Requested approval of ${name} from ${approverInput} — it publishes when they approve.`
            : `Published ${label(result)} (v${result.versionSeq}, ${result.id}).`,
        )
      })
    },
  },
  {
    path: "record version approve",
    summary: "Sign off a version you were asked to approve — publishes it",
    usage: "record version approve <version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would approve and publish ${id}.`)
          return
        }
        const v = await api.call((c) => c.approveVersion({ id }))
        note(`Approved — published ${label(v)} (v${v.versionSeq}).`)
      })
    },
  },
  {
    path: "record version reject",
    summary: "Refuse a version you were asked to approve",
    usage: "record version reject <version-id> [--reason ...]",
    options: { reason: { type: "string" } },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would reject ${id}.`)
          return
        }
        await api.call((c) => c.rejectVersion({ id, reason: str(ctx.flags.reason) }))
        note(`Rejected ${id}; the draft is editable again.`)
      })
    },
  },
  {
    path: "record version withdraw",
    summary: "Pull back an approval request; the draft unlocks",
    usage: "record version withdraw <version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would withdraw the approval request on ${id}.`)
          return
        }
        await api.call((c) => c.withdrawApproval({ id }))
        note(`Withdrew the approval request on ${id}.`)
      })
    },
  },
  {
    path: "record version update",
    summary: "Set the name / note / date / names of a published version (backfill)",
    usage:
      "record version update <version-id> [--name ...] [--note ...] [--date ...] [--author ...] [--approver ...]",
    help: `
  --name / --note / --date   as for \`record version publish\`
  --author <name>     recorded author, for history from before Kahuna
  --approver <name>   recorded approver, likewise (free text, not a member)

Only the flags you pass change; pass "" to clear one. Refused on a version
approved in Kahuna — what was signed off can't be rewritten.`,
    options: { ...RELEASE_OPTIONS, author: { type: "string" }, approver: { type: "string" } },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      const clearable = (v: unknown) => (typeof v === "string" ? v || null : undefined)
      const info = {
        name: clearable(ctx.flags.name),
        note: clearable(ctx.flags.note),
        effectiveDate: clearable(ctx.flags.date),
        attributedAuthor: clearable(ctx.flags.author),
        attributedApprover: clearable(ctx.flags.approver),
      }
      if (Object.values(info).every((v) => v === undefined))
        throw new CliError("Nothing to change.", EXIT.usage, "Pass --name, --note, --date, …")
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would update the version info of ${id}.`)
          return
        }
        const v = await api.call((c) => c.setVersionInfo({ id, ...info }))
        note(`Updated ${label(v)} (${v.id}).`)
      })
    },
  },
  {
    path: "record version import",
    summary: "Add a pre-Kahuna Document History row as a version before the first",
    usage:
      "record version import <record-id | version-id> --name 1.0.0 --date YYYY-MM-DD [--note ...] [--author ...] [--approver ...]",
    help: `Each import goes BEFORE every existing version, so import the rows newest
first (1.0.2, then 1.0.1, then 1.0.0); a date after the current oldest
version's is refused. The content was never captured: an imported version
carries the oldest real version's text, is frozen, and can't be pinned.

  --author / --approver are recorded names (free text).`,
    options: {
      ...RELEASE_OPTIONS,
      author: { type: "string" },
      approver: { type: "string" },
    },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      const name = str(ctx.flags.name)
      const effectiveDate = str(ctx.flags.date)
      if (!name || !effectiveDate)
        throw new CliError("A history row needs --name and --date.", EXIT.usage)
      await withApi(async (api) => {
        const recordId = await recordIdOf(api, id)
        if (ctx.flags["dry-run"]) {
          note(`Would import ${name} (${effectiveDate}) into ${recordId}.`)
          return
        }
        const v = await api.call((c) =>
          c.importHistoricalVersion({
            recordId,
            name,
            effectiveDate,
            note: str(ctx.flags.note),
            attributedAuthor: str(ctx.flags.author),
            attributedApprover: str(ctx.flags.approver),
          }),
        )
        note(`Imported ${label(v)} (${v.id}).`)
      })
    },
  },
  {
    path: "record version discard",
    summary: "Throw away an unpublished draft",
    usage: "record version discard <version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would discard draft ${id}.`)
          return
        }
        await api.call((c) => c.discardDraft({ id }))
        note(`Discarded draft ${id}.`)
      })
    },
  },
]
