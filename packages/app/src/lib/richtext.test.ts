import { describe, expect, it } from "vitest"
import {
  EMPTY_DOC,
  isRichTextEmpty,
  isRichTextValue,
  richTextPlain,
  richTextPreview,
  sameDoc,
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

describe("walkText: mentions", () => {
  // These mirror `engine/test/richtext.test.ts` — the engine's walk is
  // authoritative and this one is the defensive fallback, so they must agree.
  const mentionDoc = (attrs: Record<string, unknown>) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "mention", attrs }] }],
  })

  it("contributes @label, so a mention-only doc is not empty", () => {
    const v = { doc: mentionDoc({ kind: "record", targetId: "abc", label: "Acme" }), text: "" }
    expect(richTextPlain(v)).toBe("@Acme")
    expect(isRichTextEmpty(v)).toBe(false)
  })

  it("never emits the targetId, and an unlabelled mention stays empty", () => {
    const secret = "11111111-2222-3333-4444-555555555555"
    for (const attrs of [
      { kind: "record", targetId: secret },
      { kind: "record", targetId: secret, label: "" },
      { kind: "record", targetId: secret, label: 42 },
    ]) {
      const v = { doc: mentionDoc(attrs), text: "" }
      expect(richTextPlain(v)).not.toContain(secret)
      expect(isRichTextEmpty(v)).toBe(true)
    }
  })

  it("reads inline among text the way the engine does", () => {
    const v = {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "see " },
              { type: "mention", attrs: { kind: "record", targetId: "x", label: "Acme Corp" } },
              { type: "text", text: " for terms" },
            ],
          },
        ],
      },
      text: "",
    }
    expect(richTextPlain(v)).toBe("see @Acme Corp for terms")
  })
})

describe("sameDoc", () => {
  it("THE JSONB GUARD: a doc reordered by Postgres is still the same doc", () => {
    // Verified against PG16: `{"type":"text","text":"hi"}`::jsonb comes back as
    // `{"text": "hi", "type": "text"}` — jsonb sorts keys by length then bytewise.
    // ProseMirror emits {type, text}, so JSON.stringify comparison is always false
    // for any doc with a text node. This is the regression this function prevents.
    const emitted = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    }
    const stored = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ text: "hi", type: "text" }] }],
    }
    expect(JSON.stringify(emitted)).not.toBe(JSON.stringify(stored)) // the trap
    expect(sameDoc(emitted, stored)).toBe(true)
  })

  it("treats undefined and absent as the same", () => {
    expect(sameDoc({ a: 1 }, { a: 1, b: undefined })).toBe(true)
    expect(sameDoc({ type: "paragraph" }, { type: "paragraph", content: undefined })).toBe(true)
  })

  it("is strict about everything else", () => {
    expect(sameDoc(doc("a"), doc("b"))).toBe(false)
    expect(sameDoc({ a: 1 }, { a: "1" })).toBe(false)
    expect(sameDoc({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    // an absent `content` is NOT an empty one — a paragraph with no children and
    // one with an empty child list are different docs
    expect(sameDoc({ type: "paragraph" }, { type: "paragraph", content: [] })).toBe(false)
    expect(sameDoc([1, 2], [1, 2, 3])).toBe(false)
    expect(sameDoc([1, 2], [2, 1])).toBe(false) // array ORDER is meaningful
    expect(sameDoc({ a: 1 }, [1])).toBe(false)
    expect(sameDoc(null, {})).toBe(false)
    expect(sameDoc(EMPTY_DOC, null)).toBe(false)
  })

  it("compares mention attrs, so a changed target is a changed doc", () => {
    const at = (targetId: string) => ({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "mention", attrs: { kind: "record", targetId } }] },
      ],
    })
    expect(sameDoc(at("a"), at("a"))).toBe(true)
    expect(sameDoc(at("a"), at("b"))).toBe(false)
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
