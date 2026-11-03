import { createWriteStream, readFileSync, statSync } from "node:fs"
import { basename } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Field } from "@kahunalabs/contract"
import { requireSession } from "../config.ts"
import { CliError, EXIT, exitCodeForStatus } from "../errors.ts"
import { requireConfirmation } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { findField } from "../resolve.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Attachments: metadata over RPC, bytes over plain HTTP.
 *
 * Upload is multipart to `/api/records/:id/attachments` (records) or
 * `/api/buckets/:id/attachments` (a Files widget's own bucket); download is a
 * binary GET. Neither can ride the RPC transport, so both are hand-rolled here
 * with the same Origin header rest.ts sends.
 */
const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

/** The field defs of a record's concept (incl. archived, so a file still filed
 *  under an archived property shows its name) — what `--field` resolves
 *  against. A record id is a lineage; any of its versions names the concept. */
const recordFields = async (api: Api, recordId: string): Promise<ReadonlyArray<Field>> => {
  const versions = await api.call((c) => c.listVersions({ recordId }))
  const conceptId = versions[0]?.conceptId
  if (!conceptId) throw new CliError(`No record ${recordId}.`, EXIT.notFound)
  return api.call((c) => c.listFields({ conceptId, includeArchived: true }))
}

/** Resolve `--field` (name or id) to one of the record's FILE properties. */
const fileFieldOf = (fields: ReadonlyArray<Field>, name: string): Field => {
  const field = findField(
    fields.filter((f) => !f.archivedAt),
    name,
  )
  if (field.kind !== "file") {
    throw new CliError(`"${field.name}" is a ${field.kind} field, not a file property.`, EXIT.usage)
  }
  return field
}

/**
 * POST one file to an upload route (multipart) and return the stored row's id.
 * Shared by `attachment upload` and `record create --file` (which stages first).
 */
export const postFile = async (
  session: { host: string; cookie?: string | null },
  path: string,
  file: string,
  bytes: Uint8Array,
): Promise<{ id: string }> => {
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(bytes)]), basename(file))
  const res = await fetch(`${session.host}${path}`, {
    method: "POST",
    body: form,
    // The session cookie is attached by hand: never follow a redirect with it.
    redirect: "manual",
    headers: { cookie: session.cookie ?? "", origin: session.host },
  }).catch((e: unknown) => {
    throw new CliError(
      `Cannot reach ${session.host} (${e instanceof Error ? e.message : String(e)}).`,
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
  return (await res.json()) as { id: string }
}

/** Read a local file for upload, or fail with a usable message. */
export const readUpload = (file: string): Uint8Array => {
  try {
    statSync(file)
    return new Uint8Array(readFileSync(file))
  } catch {
    throw new CliError(`Cannot read ${file}.`, EXIT.notFound)
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
      await withApi(async (api) => {
        const recordId = ctx.flags.record as string | undefined
        const files = await api.call((c) =>
          c.listFiles({
            recordId,
            bucketId: ctx.flags.bucket as string | undefined,
            conceptId: ctx.flags.concept as string | undefined,
            includeArchived: Boolean(ctx.flags.archived),
          }),
        )
        // Which property each file is the value of (blank = a loose Files-panel
        // file). Names need the concept's fields; a record listing has them to
        // hand, other scopes fall back to the field id.
        const names = new Map<string, string>()
        if (recordId && files.some((f) => f.fieldId)) {
          for (const f of await recordFields(api, recordId)) names.set(f.id, f.name)
        }
        // Property files in their property's order, loose files after.
        const ordered = [...files].sort((a, b) =>
          a.fieldId === b.fieldId ? a.position - b.position : a.fieldId ? -1 : b.fieldId ? 1 : 0,
        )
        printRows(
          ctx.format,
          ordered.map((f) => ({
            id: f.id,
            filename: f.filename,
            field: f.fieldId ? (names.get(f.fieldId) ?? f.fieldId) : "",
            size: f.sizeBytes ?? "",
            type: f.mimeType ?? "",
            uploaded: f.createdAt,
            archived: f.archivedAt ? "yes" : "",
          })),
          ["id", "filename", "field", "size", "type", "uploaded", "archived"],
        )
      })
    },
  },
  {
    path: "attachment upload",
    summary: "Upload a file onto a record (optionally into a file property) or a bucket",
    usage: "attachment upload <path> --record <id> [--field <file-property>] | --bucket <id>",
    options: {
      record: { type: "string" },
      bucket: { type: "string" },
      field: { type: "string" },
    },
    run: async (ctx) => {
      const [file] = ctx.args
      const recordId = ctx.flags.record as string | undefined
      const bucketId = ctx.flags.bucket as string | undefined
      const fieldName = ctx.flags.field as string | undefined
      if (fieldName && !recordId) {
        throw new CliError("--field needs --record <id> (a bucket has no properties).", EXIT.usage)
      }
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

      const session = requireSession()
      // Resolve the property up front, so a typo fails before any bytes move —
      // and never silently lands the file loose in the Files panel instead.
      const field =
        fieldName && recordId
          ? await withApi(async (api) => fileFieldOf(await recordFields(api, recordId), fieldName))
          : undefined
      if (ctx.flags["dry-run"]) {
        note(
          `Would upload ${basename(file)} (${bytes.length} bytes)${field ? ` into "${field.name}"` : ""}.`,
        )
        return
      }

      await postFile(
        session,
        recordId
          ? `/api/records/${recordId}/attachments${field ? `?field=${encodeURIComponent(field.id)}` : ""}`
          : `/api/buckets/${bucketId}/attachments`,
        file,
        bytes,
      )
      note(`Uploaded ${basename(file)}${field ? ` into "${field.name}"` : ""}.`)
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
      const session = requireSession()
      const res = await fetch(`${session.host}/api/attachments/${id}/download`, {
        redirect: "manual",
        headers: { cookie: session.cookie ?? "", origin: session.host },
      }).catch((e: unknown) => {
        throw new CliError(
          `Cannot reach ${session.host} (${e instanceof Error ? e.message : String(e)}).`,
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
    path: "attachment move",
    summary: "Put a record's file into a file property, or back into the Files panel",
    usage: "attachment move <id> --record <record-id> --field <file-property> | --loose",
    options: { record: { type: "string" }, field: { type: "string" }, loose: { type: "boolean" } },
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which attachment?", EXIT.usage)
      const fieldName = ctx.flags.field as string | undefined
      const loose = Boolean(ctx.flags.loose)
      if (!fieldName === !loose) {
        throw new CliError("Pass --field <file-property> OR --loose.", EXIT.usage)
      }
      await withApi(async (api) => {
        let field: Field | undefined
        if (fieldName) {
          // A property is resolved against the file's record's concept — the
          // server re-checks that the two match, so a wrong --record can only
          // fail, never file the attachment somewhere unintended.
          const recordId = ctx.flags.record as string | undefined
          if (!recordId) throw new CliError("--field needs --record <record-id>.", EXIT.usage)
          field = fileFieldOf(await recordFields(api, recordId), fieldName)
        }
        const target = field ? `"${field.name}"` : "the Files panel"
        if (ctx.flags["dry-run"]) {
          note(`Would move attachment ${id} into ${target}.`)
          return
        }
        await api.call((c) => c.moveFile({ id, fieldId: field?.id ?? null }))
        note(`Moved attachment ${id} into ${target}.`)
      })
    },
  },
  {
    path: "attachment reorder",
    summary: "Order the files of a multi-file property",
    usage: "attachment reorder --record <id> --field <file-property> <attachment-id>...",
    options: { record: { type: "string" }, field: { type: "string" } },
    run: async (ctx) => {
      const recordId = ctx.flags.record as string | undefined
      const fieldName = ctx.flags.field as string | undefined
      if (!recordId || !fieldName) {
        throw new CliError("Need --record <id> --field <file-property>.", EXIT.usage)
      }
      if (ctx.args.length === 0) throw new CliError("Which attachments, in what order?", EXIT.usage)
      await withApi(async (api) => {
        const field = fileFieldOf(await recordFields(api, recordId), fieldName)
        if (ctx.flags["dry-run"]) {
          note(`Would reorder ${ctx.args.length} file(s) in "${field.name}".`)
          return
        }
        const files = await api.call((c) =>
          c.reorderFieldFiles({ recordId, fieldId: field.id, ids: [...ctx.args] }),
        )
        printRows(
          ctx.format,
          files
            .filter((f) => !f.archivedAt)
            .map((f, i) => ({ position: i + 1, id: f.id, filename: f.filename })),
          ["position", "id", "filename"],
        )
      })
    },
  },
  {
    path: "attachment archive",
    summary: "Archive an attachment",
    usage: "attachment archive <id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which attachment?", EXIT.usage)
      await withApi(async (api) => {
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
      await withApi(async (api) => {
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
      await withApi(async (api) => {
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
      await withApi(async (api) => {
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
