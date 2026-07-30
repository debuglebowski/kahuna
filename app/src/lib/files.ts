import type { Attachment } from "./api"

/**
 * Pure helpers for the Files surfaces (instance tile + dashboard widget):
 * mime classification, size formatting, and the widget's sort/filter knobs.
 * No React — kept testable.
 */

export type FileKind = "image" | "pdf" | "doc" | "other"

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
