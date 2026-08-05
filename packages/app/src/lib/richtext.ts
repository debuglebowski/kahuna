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

/** Mirrors the engine's `mentionText`. Never emits the `targetId` — see the
 *  reasoning on the engine copy in `engine/domain/richtext.ts`. */
const mentionText = (attrs: unknown): string => {
  const label = (attrs as { label?: unknown } | null)?.label
  return typeof label === "string" && label !== "" ? `@${label}` : ""
}

/** Collect the text nodes of a ProseMirror doc fragment (defensive fallback
 *  for envelopes whose `text` went missing — the engine normally requires it). */
const walkText = (node: unknown, out: string[]): void => {
  if (typeof node !== "object" || node === null) return
  const o = node as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown }
  if (o.type === "text" && typeof o.text === "string") out.push(o.text)
  else if (o.type === "mention") out.push(mentionText(o.attrs))
  else if (Array.isArray(o.content)) {
    if (out.length > 0) out.push(" ")
    for (const child of o.content) walkText(child, out)
  }
}

/**
 * Structural equality for two ProseMirror docs, insensitive to key ORDER.
 *
 * Needed because a doc that round-trips through Postgres `jsonb` comes back with
 * its keys reordered — jsonb sorts object keys by length, then bytewise, so the
 * `{type, text}` that ProseMirror emits is stored and returned as `{text, type}`.
 * `JSON.stringify(a) === JSON.stringify(b)` is therefore ALWAYS false for any doc
 * containing a text node, which silently defeats an equality guard written that
 * way. Byte-stability is unachievable through jsonb; compare structurally instead.
 *
 * `undefined` and absent are treated as the same thing (JSON cannot express the
 * difference). Everything else is strict: a false "these are equal" would skip a
 * legitimate sync and leave stale content on screen, which is worse than a
 * spurious one, so this leans strict wherever it is a judgement call.
 */
export const sameDoc = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  // Past the identity check, a null on either side can only be a mismatch.
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => sameDoc(v, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (ao[key] === undefined && bo[key] === undefined) continue
    if (!sameDoc(ao[key], bo[key])) return false
  }
  return true
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
