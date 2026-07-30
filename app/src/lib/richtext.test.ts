import { describe, expect, it } from "vitest"
import {
  EMPTY_DOC,
  isRichTextEmpty,
  isRichTextValue,
  richTextPlain,
  richTextPreview,
} from "./richtext"

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

describe("isRichTextValue", () => {
  it("accepts the { doc, text } envelope, rejects everything else", () => {
    expect(isRichTextValue({ doc: doc("x"), text: "x" })).toBe(true)
    expect(isRichTextValue({ doc: EMPTY_DOC, text: "" })).toBe(true)
    expect(isRichTextValue("x")).toBe(false)
    expect(isRichTextValue(null)).toBe(false)
    expect(isRichTextValue(doc("x"))).toBe(false) // bare doc, no envelope
    expect(isRichTextValue({ doc: doc("x") })).toBe(false) // text missing
    expect(isRichTextValue({ doc: { type: "paragraph" }, text: "x" })).toBe(false)
  })
})

describe("isRichTextEmpty", () => {
  it("empty for non-envelopes and whitespace-only text", () => {
    expect(isRichTextEmpty(undefined)).toBe(true)
    expect(isRichTextEmpty({ doc: EMPTY_DOC, text: "  \n" })).toBe(true)
    expect(isRichTextEmpty({ doc: doc("hi"), text: "hi" })).toBe(false)
  })
})

describe("richTextPlain", () => {
  it("prefers the stored text, walks the doc when it is blank", () => {
    expect(richTextPlain({ doc: doc("ignored"), text: "stored" })).toBe("stored")
    expect(richTextPlain({ doc: doc("walked"), text: "" })).toBe("walked")
    expect(richTextPlain("nope")).toBe("")
  })

  it("doc walk joins blocks with spaces", () => {
    const multi = {
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "one" }] },
          { type: "paragraph", content: [{ type: "text", text: "two" }] },
        ],
      },
      text: "",
    }
    expect(richTextPlain(multi)).toContain("one")
    expect(richTextPlain(multi)).toContain("two")
    expect(richTextPlain(multi)).not.toBe("onetwo")
  })
})

describe("richTextPreview", () => {
  it("collapses whitespace and ellipsizes past max", () => {
    expect(richTextPreview({ doc: EMPTY_DOC, text: "a\n\n  b" })).toBe("a b")
    const long = "x".repeat(200)
    const p = richTextPreview({ doc: EMPTY_DOC, text: long })
    expect(p.length).toBe(140)
    expect(p.endsWith("…")).toBe(true)
    expect(richTextPreview({ doc: EMPTY_DOC, text: "short" }, 10)).toBe("short")
  })
})
