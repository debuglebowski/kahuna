import { attachmentSecurityHeaders } from "./headers"

/** Closed allowlist: HTML, SVG, XML and unknown types must never render in our origin. */
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "application/pdf",
  "text/plain",
])

const baseType = (mimeType: string | null | undefined): string =>
  mimeType?.split(";")[0]?.trim().toLowerCase() ?? ""

export const isInlineSafe = (mimeType: string | null | undefined): boolean => {
  const base = baseType(mimeType)
  return INLINE_SAFE_TYPES.has(base) || base.startsWith("audio/") || base.startsWith("video/")
}

/** The actual download route's response builder, kept free of DB/auth dependencies. */
export const attachmentResponse = (
  attachment: { filename: string; mimeType: string | null },
  body: ReadableStream<Uint8Array> | Uint8Array,
  requestedInline: boolean,
): Response => {
  const inline = requestedInline && isInlineSafe(attachment.mimeType)
  const preview = !inline
    ? "none"
    : baseType(attachment.mimeType) === "application/pdf"
      ? "pdf"
      : "sandboxed"
  // The plain `filename=` is the fallback for clients that ignore `filename*`, and
  // header values must be Latin-1: a raw "—" or "ü" here made the Response
  // constructor THROW, so the file could be uploaded but never downloaded. ASCII
  // only; the real name rides in `filename*`.
  const safeName = attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, "_")
  return new Response(body as unknown as BodyInit, {
    headers: {
      ...attachmentSecurityHeaders(preview),
      // Never trust a filename extension to select inline rendering. nosniff
      // also keeps HTML bytes mislabeled as PDF from being interpreted as HTML.
      "content-type": inline ? (attachment.mimeType as string) : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    },
  })
}
