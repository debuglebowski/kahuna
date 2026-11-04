import { describe, expect, it } from "vitest"
import { asRichText, markdownToRichText } from "./richtext.ts"

const doc = (md: string) => markdownToRichText(md).doc

describe("markdown → rich text", () => {
  it("turns plain text into one paragraph", () => {
    expect(markdownToRichText("hello")).toEqual({
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
      },
      text: "hello",
    })
  })

  it("keeps blank-line paragraphs apart and soft line breaks inside one", () => {
    expect(doc("one\ntwo\n\nthree").content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "one\ntwo" }] },
      { type: "paragraph", content: [{ type: "text", text: "three" }] },
    ])
  })

  it("maps headings, clamped to the editor's levels", () => {
    expect(doc("## Scope").content).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Scope" }] },
    ])
  })

  it("maps bullet and ordered lists, nested, with a paragraph first in every item", () => {
    expect(doc("- a\n- b\n  - c").content).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
          },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "b" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ])
    expect(doc("3. x\n4. y").content?.[0]).toMatchObject({
      type: "orderedList",
      attrs: { start: 3 },
    })
  })

  it("maps links and inline marks, nesting marks", () => {
    expect(doc("see **[the policy](https://x.se/p)** and `cfg` ~~old~~ *now*").content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          {
            type: "text",
            text: "the policy",
            marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://x.se/p" } }],
          },
          { type: "text", text: " and " },
          { type: "text", text: "cfg", marks: [{ type: "code" }] },
          { type: "text", text: " " },
          { type: "text", text: "old", marks: [{ type: "strike" }] },
          { type: "text", text: " " },
          { type: "text", text: "now", marks: [{ type: "italic" }] },
        ],
      },
    ])
  })

  it("drops the link mark from an unsafe href but keeps the text", () => {
    expect(doc("[x](javascript:alert(1))").content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
    ])
  })

  it("decodes character references — a text node is literal, not HTML", () => {
    expect(markdownToRichText("R&amp;D &lt;3 &#229;").text).toBe("R&D <3 å")
  })

  it("maps quotes, code blocks, rules and hard breaks", () => {
    expect(doc("> q\n\n```sh\nls\n```\n\n---\n\na  \nb").content).toEqual([
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }],
      },
      { type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "ls" }] },
      { type: "horizontalRule" },
      {
        type: "paragraph",
        content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }],
      },
    ])
  })

  it("degrades what the editor has no node for to text instead of an unknown node", () => {
    const table = doc("| a | b |\n|---|---|\n| 1 | 2 |").content
    expect(table).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a", marks: [{ type: "bold" }] },
          { type: "text", text: " | " },
          { type: "text", text: "b", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "1" },
          { type: "text", text: " | " },
          { type: "text", text: "2" },
        ],
      },
    ])
    expect(markdownToRichText("- [x] done").text).toBe("[x] done")
    expect(markdownToRichText("![logo](l.png)").text).toBe("logo")
    expect(markdownToRichText("<div>raw</div>").text).toBe("<div>raw</div>")
  })

  it("derives text the way the server's walk does: a space per container", () => {
    // list + item + paragraph each open a container, hence the runs of spaces.
    // The server re-derives this on write; app/src/lib/cliRichtext.test.ts pins
    // the two walks equal.
    expect(markdownToRichText("# Title\n\nBody\n\n- one\n- two").text).toBe("Title Body   one  two")
  })

  it("normalises CRLF so Windows files don't carry \\r into text nodes", () => {
    expect(markdownToRichText("a\r\n\r\nb").text).toBe("a b")
  })

  it("never yields an empty doc", () => {
    expect(doc("   ")).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })
})

describe("already-rich-text values", () => {
  const pm = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
  }
  it("accepts the envelope and a bare doc, re-deriving text", () => {
    expect(asRichText({ doc: pm, text: "stale" })).toEqual({ doc: pm, text: "x" })
    expect(asRichText(pm)).toEqual({ doc: pm, text: "x" })
  })
  it("rejects anything else", () => {
    expect(asRichText({ a: 1 })).toBeNull()
    expect(asRichText({ doc: { type: "paragraph" } })).toBeNull()
    expect(asRichText("x")).toBeNull()
  })
})
