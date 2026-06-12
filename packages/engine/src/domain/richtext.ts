/**
 * The rich-text `{ doc, text }` envelope shared by instance `richtext` fields
 * and task descriptions: ProseMirror JSON plus extracted plain text. The stored
 * `text` is ALWAYS derived server-side (the client's copy is shape-checked but
 * never persisted), so filters/previews/labels can't be lied to.
 */

/** A rich-text value as stored: ProseMirror doc + derived plain text. */
export interface RichTextValue {
  readonly doc: { readonly [key: string]: unknown }
  readonly text: string
}

/** Serialized-doc ceiling — bounds the per-save event row, not a UX limit. */
export const MAX_RICHTEXT_CHARS = 1_000_000

export const isRichText = (v: unknown): v is RichTextValue => {
  if (typeof v !== "object" || v === null) return false
  const o = v as { doc?: unknown; text?: unknown }
  return (
    typeof o.text === "string" &&
    typeof o.doc === "object" &&
    o.doc !== null &&
    (o.doc as { type?: unknown }).type === "doc"
  )
}

/** Collect a ProseMirror doc's text nodes, blocks joined with spaces (mirrors
 *  the web client's `richtext.ts` walk). */
export const richTextWalk = (node: unknown, out: string[]): void => {
  if (typeof node !== "object" || node === null) return
  const o = node as { type?: unknown; text?: unknown; content?: unknown }
  if (o.type === "text" && typeof o.text === "string") out.push(o.text)
  else if (Array.isArray(o.content)) {
    if (out.length > 0) out.push(" ")
    for (const child of o.content) richTextWalk(child, out)
  }
}

/** Re-derive the envelope from its doc (drops whatever `text` the caller sent). */
export const deriveRichText = (v: RichTextValue): RichTextValue => {
  const text: string[] = []
  richTextWalk(v.doc, text)
  return { doc: v.doc, text: text.join("") }
}
