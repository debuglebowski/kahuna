import { createWriteStream, readFileSync, statSync } from "node:fs"
import { basename } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT, exitCodeForStatus } from "../errors.ts"
import { requireConfirmation } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Attachments: metadata over RPC, bytes over plain HTTP.
 *
 * Upload is multipart to `/api/records/:id/attachments` (records) or
 * `/api/buckets/:id/attachments` (a Files widget's own bucket); download is a
 * binary GET. Neither can ride the RPC transport, so both are hand-rolled here
 * with the same Origin header rest.ts sends.
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

export const attachmentCommands: ReadonlyArray<Command> = [
  {
    path: "attachment list",
    summary: "What is attached to a record, bucket or concept",
    usage: "attachment list [--record <id>] [--bucket <id>] [--concept <id>] [--archived]",
    options: {
      record: { type: "string" },
      bucket: { type: "string" },
      concept: { type: "string" },
      archived: { type: "boolean" },
    },
    run: async (ctx) => {
      await withApi(ctx.profile, async (api) => {
        const files = await api.call((c) =>
          c.listFiles({
            recordId: ctx.flags.record as string | undefined,
            bucketId: ctx.flags.bucket as string | undefined,
            conceptId: ctx.flags.concept as string | undefined,
            includeArchived: Boolean(ctx.flags.archived),
          }),
        )
        printRows(
          ctx.format,
          files.map((f) => ({
            id: f.id,
            filename: f.filename,
            size: f.sizeBytes ?? "",
            type: f.mimeType ?? "",
            uploaded: f.createdAt,
            archived: f.archivedAt ? "yes" : "",
          })),
          ["id", "filename", "size", "type", "uploaded", "archived"],
        )
      })
    },
  },
  {
    path: "attachment upload",
    summary: "Upload a file onto a record or a bucket",
    usage: "attachment upload <path> --record <id> | --bucket <id>",
    options: { record: { type: "string" }, bucket: { type: "string" } },
    run: async (ctx) => {
      const [file] = ctx.args
      const recordId = ctx.flags.record as string | undefined
      const bucketId = ctx.flags.bucket as string | undefined
      if (!file) throw new CliError("Which file?", EXIT.usage)
      if (!recordId && !bucketId) {
        throw new CliError("Need --record <id> or --bucket <id>.", EXIT.usage)
      }
      if (recordId && bucketId) {
        // The two upload routes are different endpoints; picking one silently
        // would attach the file somewhere the user did not name.
        throw new CliError("Pass --record OR --bucket, not both.", EXIT.usage)
      }

      let bytes: Buffer
      try {
        bytes = readFileSync(file)
        statSync(file)
      } catch {
        throw new CliError(`Cannot read ${file}.`, EXIT.notFound)
      }

      const { profile } = resolveProfile(loadConfig(), ctx.profile)
      if (ctx.flags["dry-run"]) {
        note(`Would upload ${basename(file)} (${bytes.length} bytes).`)
        return
      }

      const form = new FormData()
      form.append("file", new Blob([new Uint8Array(bytes)]), basename(file))
      const url = recordId
        ? `${profile.host}/api/records/${recordId}/attachments`
        : `${profile.host}/api/buckets/${bucketId}/attachments`
      const res = await fetch(url, {
        method: "POST",
        body: form,
        headers: { cookie: profile.cookie ?? "", origin: profile.host },
      }).catch((e: unknown) => {
        throw new CliError(
          `Cannot reach ${profile.host} (${e instanceof Error ? e.message : String(e)}).`,
          EXIT.failed,
        )
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new CliError(
          body?.error === "ATTACHMENT_TOO_LARGE"
            ? `${basename(file)} is larger than the server accepts.`
            : (body?.error ?? `Upload failed (HTTP ${res.status}).`),
          exitCodeForStatus(res.status),
        )
      }
      note(`Uploaded ${basename(file)}.`)
    },
  },
  {
    path: "attachment download",
    summary: "Download an attachment",
    usage: "attachment download <id> [--out <path>]",
    options: { out: { type: "string" } },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which attachment?", EXIT.usage)
      const { profile } = resolveProfile(loadConfig(), ctx.profile)
      const res = await fetch(`${profile.host}/api/attachments/${id}/download`, {
        headers: { cookie: profile.cookie ?? "", origin: profile.host },
      }).catch((e: unknown) => {
        throw new CliError(
          `Cannot reach ${profile.host} (${e instanceof Error ? e.message : String(e)}).`,
          EXIT.failed,
        )
      })
      if (!res.ok || !res.body) {
        throw new CliError(`Download failed (HTTP ${res.status}).`, exitCodeForStatus(res.status))
      }

      // The server names the file in content-disposition; honour it rather than
      // making the caller guess, and STREAM rather than buffering — an
      // attachment can be far larger than it is polite to hold in memory.
      const disposition = res.headers.get("content-disposition") ?? ""
      const named = /filename="([^"]+)"/.exec(disposition)?.[1]
      const out = (ctx.flags.out as string | undefined) ?? named ?? id
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out))
      note(`Saved ${out}.`)
    },
  },
  {
    path: "attachment archive",
    summary: "Archive an attachment",
    usage: "attachment archive <id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which attachment?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would archive attachment ${id}.`)
          return
        }
        await api.call((c) => c.archiveFile({ id }))
        note(`Archived attachment ${id}.`)
      })
    },
  },
  {
    path: "attachment restore",
    summary: "Restore an archived attachment",
    usage: "attachment restore <id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which attachment?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would restore attachment ${id}.`)
          return
        }
        await api.call((c) => c.restoreFile({ id }))
        note(`Restored attachment ${id}.`)
      })
    },
  },
  {
    path: "attachment delete",
    summary: "PURGE an attachment",
    usage: "attachment delete <id> --yes",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which attachment?", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently delete attachment ${id}`)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would PURGE attachment ${id}. The bytes are gone for good.`)
          return
        }
        await api.call((c) => c.deleteFile({ id }))
        note(`Purged attachment ${id}.`)
      })
    },
  },
  {
    path: "attachment purge",
    summary: "Empty a Files widget's bucket",
    usage: "attachment purge --bucket <id> --yes",
    options: { bucket: { type: "string" } },
    run: async (ctx) => {
      const bucketId = ctx.flags.bucket as string | undefined
      if (!bucketId) throw new CliError("Need --bucket <id>.", EXIT.usage)
      requireConfirmation(ctx.flags, `permanently empty bucket ${bucketId}`)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would PURGE every file in bucket ${bucketId}.`)
          return
        }
        await api.call((c) => c.purgeBucket({ bucketId }))
        note(`Emptied bucket ${bucketId}.`)
      })
    },
  },
]
