import type { Attachment } from "./api"

/**
 * Pure helpers for the Files surfaces (record version tile + dashboard widget):
 * mime classification, size formatting, and the widget's sort/filter knobs.
 * No React — kept testable.
 */

export type FileKind = "image" | "pdf" | "doc" | "other"

/**
 * May this viewer archive/restore/delete this file? Uploader-or-admin, mirroring
 * the server's own gate (`assertCanMutateAttachment`) so the UI offers exactly
 * what the API will allow — a button that 403s is worse than no button.
 */
export const canMutateFile = (
  file: Pick<Attachment, "createdBy">,
  viewer: { userId: string | undefined; admin: boolean },
): boolean => viewer.admin || (!!viewer.userId && file.createdBy === viewer.userId)

const DOC_MIME =
  /^(text\/|application\/(msword|vnd\.openxmlformats|vnd\.ms-|vnd\.oasis\.opendocument|rtf|json|csv))/
const DOC_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|txt|md|csv|json|rtf)$/i

/** Coarse bucket for icons + the widget's file-type filter. Falls back to the
 *  filename extension when the mime type is missing/opaque. */
export const fileKind = (mimeType: string | null, filename = ""): FileKind => {
  const mime = mimeType ?? ""
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf" || /\.pdf$/i.test(filename)) return "pdf"
  if (DOC_MIME.test(mime) || DOC_EXT.test(filename)) return "doc"
  if (!mime && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(filename)) return "image"
  return "other"
}

/** "1.4 MB" — binary steps, one decimal above KB. Null reads as a dash. */
export const formatBytes = (n: number | null): string => {
  if (n == null) return "—"
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB"]
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[i]}`
}

export type FileSort = "newest" | "name" | "size"
export type FileTypeFilter = "all" | "image" | "doc" | "pdf" | "other"

/**
 * Where a dropped file goes, for a Files widget in a given place — the one rule
 * behind whether a drop zone appears at all. Pure, because it decides a surface a
 * person is looking for and got wrong twice; a React-internal condition can't be
 * pinned by a test.
 *
 * - Own bucket / one record → that is the owner.
 * - A wide scope (whole org, a concept) owns nothing, BUT on a record page the open
 *   record is an unambiguous destination, so it takes the drop and the file
 *   attaches there ("widened"). Off a record page it stays browse-only.
 * - `allowUpload: false` is honoured everywhere; absent means yes. It used to be
 *   opt-in, which shipped upload surfaces that silently refused uploads.
 */
export type UploadTarget =
  /** The widget's own bucket — usable as-is. */
  | { kind: "bucket"; bucketId: string; shared: boolean }
  /** The open record, because the widget's scope owns nothing of its own. The
   *  copy has to name the destination: "uploads to the org" is meaningless. */
  | { kind: "record"; recordId: string }
  /** A pinned record version — needs the id → record hop before uploading. */
  | { kind: "recordVersion"; recordVersionId: string }
  /** Browse only: nowhere for a file to go. */
  | null

export const uploadTarget = (
  widget: {
    // "instance" is the pre-rename value, still decodable for one release.
    scope: "recordVersion" | "instance" | "concept" | "org" | "widget"
    recordVersionId?: string | null
    bucketId?: string | null
    bucketShared?: boolean
    allowUpload?: boolean
  },
  /** The open record, when rendering on a record dashboard. */
  recordId?: string,
): UploadTarget => {
  if (widget.allowUpload === false) return null
  if (widget.scope === "widget")
    return widget.bucketId
      ? { kind: "bucket", bucketId: widget.bucketId, shared: widget.bucketShared !== false }
      : null
  if (widget.scope === "recordVersion" || widget.scope === "instance")
    return widget.recordVersionId
      ? { kind: "recordVersion", recordVersionId: widget.recordVersionId }
      : null
  return recordId ? { kind: "record", recordId } : null
}

/** Apply the widget's display knobs: type filter → sort → limit. */
export const arrangeFiles = (
  files: ReadonlyArray<Attachment>,
  opts: { sort?: FileSort; fileType?: FileTypeFilter; limit?: number | null } = {},
): Attachment[] => {
  const filtered =
    !opts.fileType || opts.fileType === "all"
      ? [...files]
      : [...files].filter((f) => fileKind(f.mimeType, f.filename) === opts.fileType)
  const sort = opts.sort ?? "newest"
  filtered.sort((a, b) =>
    sort === "name"
      ? a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" })
      : sort === "size"
        ? (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return opts.limit != null && opts.limit > 0 ? filtered.slice(0, opts.limit) : filtered
}
