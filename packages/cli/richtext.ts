import { lexer, type Token, type Tokens } from "marked"

/**
 * Markdown → the `{ doc, text }` envelope a `richtext` field stores.
 *
 * `doc` is ProseMirror JSON in the node vocabulary the SPA's editor (TipTap
 * StarterKit) knows: paragraph, heading, bulletList/orderedList/listItem,
 * blockquote, codeBlock, horizontalRule, hardBreak; marks bold, italic, strike,
 * code, link. A node the editor does NOT know would make the record's document
 * unrenderable, so everything outside that set degrades to plain text rather
 * than being passed through: tables become one paragraph per row, task-list
 * checkboxes become a "[ ] " prefix, raw HTML stays as literal text, images
 * become their alt text.
 *
 * `text` is the server's own derivation (blocks joined with a space). The
 * server recomputes it on every write anyway, so this copy only has to be a
 * string — it is computed rather than left empty so a dry run shows it.
 */

type Mark = { readonly type: string; readonly attrs?: Record<string, unknown> }
type PMNode = {
  readonly type: string
  readonly attrs?: Record<string, unknown>
  readonly content?: ReadonlyArray<PMNode>
  readonly text?: string
  readonly marks?: ReadonlyArray<Mark>
}

export interface RichText {
  readonly doc: PMNode
  readonly text: string
}

/** Links the editor will render. Anything else (javascript:, data:) keeps its
 *  text and loses the link — the doc is shown to every reader of the record. */
const SAFE_HREF = /^(?:https?:|mailto:|tel:|#|\/)/i

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/** marked leaves character references in text verbatim (`&amp;` stays
 *  `&amp;`); its renderer would emit them as HTML, but a ProseMirror text node
 *  is literal, so decode them here or the reader sees "&amp;". */
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[ref.toLowerCase()] ?? whole
  })

const textNode = (text: string, marks: ReadonlyArray<Mark>): PMNode | null =>
  text === "" ? null : marks.length ? { type: "text", text, marks } : { type: "text", text }

/** Inline tokens → text nodes carrying the marks of every enclosing token. */
const inline = (tokens: ReadonlyArray<Token> | undefined, marks: ReadonlyArray<Mark>): PMNode[] => {
  const out: PMNode[] = []
  const push = (n: PMNode | null) => {
    if (n) out.push(n)
  }
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text":
        // A tight list item's text token nests its own inline tokens.
        if ("tokens" in t && t.tokens?.length) out.push(...inline(t.tokens, marks))
        else push(textNode(decode(t.text), marks))
        break
      case "escape":
        push(textNode(t.text, marks))
        break
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, [...marks, { type: "bold" }]))
        break
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, [...marks, { type: "italic" }]))
        break
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, [...marks, { type: "strike" }]))
        break
      case "codespan":
        // TipTap's code mark excludes every other mark.
        push(textNode(decode((t as Tokens.Codespan).text), [{ type: "code" }]))
        break
      case "br":
        out.push({ type: "hardBreak" })
        break
      case "link": {
        const link = t as Tokens.Link
        const next = SAFE_HREF.test(link.href)
          ? [...marks, { type: "link", attrs: { href: link.href } }]
          : marks
        out.push(...inline(link.tokens, next))
        break
      }
      case "image":
        push(textNode(decode((t as Tokens.Image).text), marks))
        break
      default:
        // Inline HTML and anything marked adds later: keep the source text.
        push(textNode("raw" in t ? t.raw : "", marks))
    }
  }
  return out
}

const paragraph = (content: PMNode[]): PMNode =>
  content.length ? { type: "paragraph", content } : { type: "paragraph" }

const listItem = (item: Tokens.ListItem): PMNode => {
  const children = blocks(item.tokens.filter((t) => t.type !== "checkbox"))
  // TipTap's listItem is `paragraph block*` — the first child must be a paragraph.
  if (children[0]?.type !== "paragraph") children.unshift(paragraph([]))
  if (item.task) {
    const first = children[0] as PMNode
    const box: PMNode = { type: "text", text: item.checked ? "[x] " : "[ ] " }
    children[0] = paragraph([box, ...(first.content ?? [])])
  }
  return { type: "listItem", content: children }
}

const blocks = (tokens: ReadonlyArray<Token>): PMNode[] => {
  const out: PMNode[] = []
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break
      case "paragraph":
        out.push(paragraph(inline((t as Tokens.Paragraph).tokens, [])))
        break
      // A tight list item's body: a block-level "text" token with inline children.
      case "text":
        out.push(
          paragraph(
            "tokens" in t && t.tokens?.length
              ? inline(t.tokens, [])
              : inline([{ type: "text", raw: t.raw, text: t.text } as Token], []),
          ),
        )
        break
      case "heading": {
        const h = t as Tokens.Heading
        const content = inline(h.tokens, [])
        out.push({
          type: "heading",
          attrs: { level: Math.min(Math.max(h.depth, 1), 6) },
          ...(content.length ? { content } : {}),
        })
        break
      }
      case "list": {
        const l = t as Tokens.List
        const items = l.items.map(listItem)
        if (l.ordered) {
          const start = typeof l.start === "number" ? l.start : 1
          out.push({ type: "orderedList", attrs: { start }, content: items })
        } else {
          out.push({ type: "bulletList", content: items })
        }
        break
      }
      case "blockquote": {
        const inner = blocks((t as Tokens.Blockquote).tokens)
        out.push({ type: "blockquote", content: inner.length ? inner : [paragraph([])] })
        break
      }
      case "code": {
        const c = t as Tokens.Code
        out.push({
          type: "codeBlock",
          attrs: { language: c.lang ? c.lang.split(/\s/)[0] : null },
          ...(c.text ? { content: [{ type: "text", text: c.text }] } : {}),
        })
        break
      }
      case "hr":
        out.push({ type: "horizontalRule" })
        break
      case "table": {
        // No table node in the editor: one paragraph per row, cells " | "-joined,
        // header row bold so it still reads as a header.
        const tb = t as Tokens.Table
        const row = (cells: ReadonlyArray<Tokens.TableCell>, marks: ReadonlyArray<Mark>) => {
          const content: PMNode[] = []
          cells.forEach((cell, i) => {
            if (i > 0) content.push({ type: "text", text: " | " })
            content.push(...inline(cell.tokens, marks))
          })
          return paragraph(content)
        }
        out.push(row(tb.header, [{ type: "bold" }]))
        for (const r of tb.rows) out.push(row(r, []))
        break
      }
      default: {
        // Block HTML and anything newer: its source, as a plain paragraph.
        const raw = ("raw" in t ? t.raw : "").trim()
        if (raw) out.push(paragraph([{ type: "text", text: raw }]))
      }
    }
  }
  return out
}

/** The plain-text projection, matching the server's `richTextWalk`. */
const walk = (node: PMNode, out: string[]): void => {
  if (node.type === "text" && typeof node.text === "string") out.push(node.text)
  else if (Array.isArray(node.content)) {
    if (out.length > 0) out.push(" ")
    for (const child of node.content) walk(child, out)
  }
}

export const plainText = (doc: PMNode): string => {
  const out: string[] = []
  walk(doc, out)
  return out.join("")
}

/** Markdown (plain text is markdown too) → `{ doc, text }`. */
export const markdownToRichText = (markdown: string): RichText => {
  const content = blocks(lexer(markdown.replace(/\r\n?/g, "\n")))
  const doc: PMNode = { type: "doc", content: content.length ? content : [paragraph([])] }
  return { doc, text: plainText(doc) }
}

/** A value that is already rich text: the `{ doc, text }` envelope, or a bare
 *  ProseMirror doc. Null when it is neither — the caller decides what that means. */
export const asRichText = (value: unknown): RichText | null => {
  if (typeof value !== "object" || value === null) return null
  const v = value as { type?: unknown; doc?: unknown }
  const doc = v.type === "doc" ? v : v.doc
  if (typeof doc !== "object" || doc === null || (doc as { type?: unknown }).type !== "doc")
    return null
  return { doc: doc as PMNode, text: plainText(doc as PMNode) }
}
