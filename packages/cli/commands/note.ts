import { readFileSync } from "node:fs"
import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { requireConfirmation, withVersion } from "../mutate.ts"
import { printRows, note as say } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Notes on a record, or standalone.
 *
 * `listNotes` REQUIRES a subject, unlike `listTasks` — so `--record` is
 * mandatory for listing and optional for creating. That asymmetry is the API's,
 * and pretending otherwise would mean inventing a listing the server cannot do.
 */
const withApi = async <T>(
  profileFlag: string | undefined,
  f: (api: Api) => Promise<T>,
): Promise<T> => {
  const { profile } = resolveProfile(loadConfig(), profileFlag)
  const api = makeRuntime(profile)
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

/** Body from an argument, a file, or stdin — a note is prose, and prose comes
 *  from a pipe as often as from a flag. */
const readBody = async (args: ReadonlyArray<string>, file: unknown): Promise<string> => {
  if (typeof file === "string") {
    try {
      return readFileSync(file, "utf8")
    } catch {
      throw new CliError(`Cannot read ${file}.`, EXIT.notFound)
    }
  }
  if (args.length > 0) return args.join(" ")
  if (process.stdin.isTTY) {
    throw new CliError(
      "Nothing to write.",
      EXIT.usage,
      "Pass the text, --file <path>, or pipe it in.",
    )
  }
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8").trim()
}

export const noteCommands: ReadonlyArray<Command> = [
  {
    path: "note list",
    summary: "Notes on a record",
    usage: "note list --record <id> [--archived]",
    options: { record: { type: "string" }, archived: { type: "boolean" } },
    run: async (ctx) => {
      const subjectId = (ctx.flags.record as string | undefined) ?? ctx.args[0]
      if (!subjectId) {
        throw new CliError(
          "Which record?",
          EXIT.usage,
          "listNotes needs a subject — there is no org-wide note listing.",
        )
      }
      await withApi(ctx.profile, async (api) => {
        const notes = await api.call((c) =>
          c.listNotes({ subjectId, includeArchived: Boolean(ctx.flags.archived) }),
        )
        printRows(
          ctx.format,
          notes.map((n) => ({
            id: n.id,
            body: n.body.length > 80 ? `${n.body.slice(0, 77)}...` : n.body,
            created: n.createdAt,
            archived: n.archivedAt ? "yes" : "",
          })),
          ["id", "body", "created", "archived"],
        )
      })
    },
  },
  {
    path: "note create",
    summary: "Write a note, on a record or standalone",
    usage: "note create [text] [--record <id>] [--file <path>]",
    options: { record: { type: "string" }, file: { type: "string" } },
    run: async (ctx) => {
      const body = await readBody(ctx.args, ctx.flags.file)
      if (!body) throw new CliError("The note is empty.", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          say(`Would write a ${body.length}-character note.`)
          return
        }
        const created = await api.call((c) =>
          c.createNote({ subjectId: (ctx.flags.record as string | undefined) ?? null, body }),
        )
        say(`Wrote note ${created.id}.`)
      })
    },
  },
  {
    path: "note update",
    summary: "Replace a note's text",
    usage: "note update <id> [text] [--file <path>]",
    options: { file: { type: "string" }, record: { type: "string" } },
    run: async (ctx) => {
      const [id, ...rest] = ctx.args
      if (!id) throw new CliError("Which note?", EXIT.usage)
      const body = await readBody(rest, ctx.flags.file)
      if (!body) throw new CliError("The note is empty.", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          say(`Would replace note ${id}.`)
          return
        }
        // A note's subject is needed to re-read it, because listNotes is
        // subject-scoped. `--record` supplies it; without one we can still write
        // using the version we get back from the failed attempt's error, so ask.
        const subjectId = ctx.flags.record as string | undefined
        if (!subjectId) {
          throw new CliError(
            "note update needs --record <id>.",
            EXIT.usage,
            "Notes are read through their subject, so the CLI cannot find one by id alone.",
          )
        }
        await withVersion(
          async () => {
            const notes = await api.call((c) => c.listNotes({ subjectId, includeArchived: true }))
            const found = notes.find((n) => n.id === id)
            if (!found) throw new CliError(`No note ${id} on that record.`, EXIT.notFound)
            return found
          },
          (current) =>
            api.call((c) => c.updateNote({ id, expectedVersion: current.version, body })),
        )
        say(`Updated note ${id}.`)
      })
    },
  },
  {
    path: "note delete",
    summary: "PURGE a note",
    usage: "note delete <id> --yes",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which note?", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete note ${id}`)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          say(`Would PURGE note ${id}.`)
          return
        }
        await api.call((c) => c.deleteNote({ id }))
        say(`Purged note ${id}.`)
      })
    },
  },
]
