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

/**
 * A mention node's contribution to derived text: "@" + its cached label.
 *
 * An unlabelled mention contributes NOTHING, and in particular never its
 * `targetId`. Derived `text` is handed to any member who can read the host record
 * (`listInstances` returns it, `conditions.ts` filters on it), so an id here would
 * publish the identity of a record the reader may not be allowed to see — and a
 * joinable one at that. The label is a different matter: it is already visible as
 * prose, which is the accepted trade (enforcement lives at the link).
 */
const mentionText = (attrs: unknown): string => {
  const label = (attrs as { label?: unknown } | null)?.label
  return typeof label === "string" && label !== "" ? `@${label}` : ""
}

/** Collect a ProseMirror doc's text nodes, blocks joined with spaces (mirrors
 *  the web client's `richtext.ts` walk). A `mention` is a leaf carrying its text
 *  in an attr, so it sits beside the `text` case rather than in the container
 *  branch — that way it gets the same separator treatment as the inline text it
 *  visually is. */
export const richTextWalk = (node: unknown, out: string[]): void => {
  if (typeof node !== "object" || node === null) return
  const o = node as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown }
  if (o.type === "text" && typeof o.text === "string") out.push(o.text)
  else if (o.type === "mention") out.push(mentionText(o.attrs))
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
