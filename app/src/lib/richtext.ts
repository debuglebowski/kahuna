/**
 * Shared shape helpers for `richtext` field values. The stored value is an
 * envelope `{ doc, text }` — TipTap/ProseMirror JSON plus its extracted plain
 * text — so filters, list previews and labels read `.text` without parsing
 * the doc. Pure (no React / DOM), like `conditions.ts`.
 */

export interface RichTextDoc {
  readonly type: "doc"
  readonly content?: ReadonlyArray<unknown>
}

export interface RichTextValue {
  readonly doc: RichTextDoc
  readonly text: string
}

export const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] }

/** Mirrors the engine's `isRichText` validation guard. */
export const isRichTextValue = (v: unknown): v is RichTextValue => {
  if (typeof v !== "object" || v === null) return false
  const o = v as { doc?: unknown; text?: unknown }
  return (
    typeof o.text === "string" &&
    typeof o.doc === "object" &&
    o.doc !== null &&
    (o.doc as { type?: unknown }).type === "doc"
  )
}

export const isRichTextEmpty = (v: unknown): boolean =>
  !isRichTextValue(v) || richTextPlain(v).trim() === ""

/** Collect the text nodes of a ProseMirror doc fragment (defensive fallback
 *  for envelopes whose `text` went missing — the engine normally requires it). */
const walkText = (node: unknown, out: string[]): void => {
  if (typeof node !== "object" || node === null) return
  const o = node as { type?: unknown; text?: unknown; content?: unknown }
  if (o.type === "text" && typeof o.text === "string") out.push(o.text)
  else if (Array.isArray(o.content)) {
    if (out.length > 0) out.push(" ")
    for (const child of o.content) walkText(child, out)
  }
}

export const richTextPlain = (v: unknown): string => {
  if (!isRichTextValue(v)) return ""
  if (v.text !== "") return v.text
  const out: string[] = []
  walkText(v.doc, out)
  return out.join("")
}

/** One-line preview for table cells / labels. */
export const richTextPreview = (v: unknown, max = 140): string => {
  const plain = richTextPlain(v).replace(/\s+/g, " ").trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
