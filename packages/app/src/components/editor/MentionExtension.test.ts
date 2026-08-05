/**
 * Schema-level tests for the `mention` node. These drive real ProseMirror (via
 * TipTap's schema builder) rather than a DOM editor, so they run in the plain
 * vitest environment alongside the other pure-logic tests.
 *
 * What they exist to prove is the ROLLOUT contract: a document containing a
 * mention must parse cleanly in a build that knows the node (no content error, so
 * no degrade-to-plain-text), it must round-trip verbatim through JSON, and its
 * derived text must match what the engine derives server-side.
 */

import { generateText, getSchema } from "@tiptap/core"
import { Node as PMNode } from "@tiptap/pm/model"
import StarterKit from "@tiptap/starter-kit"
import { describe, expect, it } from "vitest"
import { Mention } from "./MentionExtension"

const EXTENSIONS = [StarterKit, Mention]
const schema = getSchema(EXTENSIONS)

const mentionDoc = (attrs: Record<string, unknown>) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "mention", attrs }] }],
})

/** Parse the way TipTap does with `enableContentCheck` on: `fromJSON` throws on a
 *  node the schema doesn't know, which is what triggers the editor's `broken`
 *  fallback for the WHOLE field. */
const parse = (doc: unknown) => PMNode.fromJSON(schema, doc)

describe("mention node schema", () => {
  it("is registered as an inline atom", () => {
    const spec = schema.nodes.mention
    if (!spec) throw new Error("the mention node is not in the schema")
    expect(spec.isInline).toBe(true)
    expect(spec.isAtom).toBe(true)
    // Atom + no content means the caret cannot enter the chip, so the cached
    // label can go stale but can never be edited into a lie.
    expect(spec.isLeaf).toBe(true)
  })

  it("parses a mention document without a content error", () => {
    const node = parse(mentionDoc({ kind: "record", targetId: "abc", label: "Acme Corp" }))
    const mention = node.firstChild?.firstChild
    expect(mention?.type.name).toBe("mention")
    expect(mention?.attrs).toMatchObject({ kind: "record", targetId: "abc", label: "Acme Corp" })
  })

  it("round-trips verbatim through JSON — the server stores `doc` opaquely", () => {
    const input = mentionDoc({ kind: "person", targetId: "user-1", label: "Ada" })
    expect(parse(input).toJSON()).toEqual(input)
  })

  it("survives a node missing attrs, because every attr has a default", () => {
    // Without defaults ProseMirror throws while computing attrs, turning one
    // malformed mention into a whole broken document.
    expect(() => parse(mentionDoc({}))).not.toThrow()
    const bare = parse(mentionDoc({})).firstChild?.firstChild
    expect(bare?.attrs).toEqual({ kind: null, targetId: null, label: "" })
  })

  it("accepts an unknown KIND — a future kind must not break the document", () => {
    // The rollout bet: unknown attr VALUES are fine, unknown node TYPES are not.
    // This is why there is one node with a `kind` attr instead of six node types.
    expect(() =>
      parse(mentionDoc({ kind: "task", targetId: "t1", label: "Ship it" })),
    ).not.toThrow()
  })

  it("rejects an unknown node type — the hazard the staged rollout exists for", () => {
    const future = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "someFutureNode", attrs: {} }] }],
    }
    expect(() => parse(future)).toThrow()
  })

  describe("derived text", () => {
    // `generateText` is the same path `editor.getText()` takes: TipTap compiles
    // `renderText` into the node spec as `toText` and calls it with `{node, …}`.
    // Must agree with `mentionText` in lib/richtext.ts and the engine's copy.
    const textOf = (doc: Parameters<typeof generateText>[0]) =>
      generateText(doc, EXTENSIONS, { blockSeparator: " " })

    it("contributes @label", () => {
      expect(textOf(mentionDoc({ kind: "record", targetId: "a", label: "Acme" }))).toBe("@Acme")
    })

    it("reads inline among text", () => {
      const mixed = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "see " },
              { type: "mention", attrs: { kind: "record", targetId: "a", label: "Acme Corp" } },
              { type: "text", text: " for terms" },
            ],
          },
        ],
      }
      expect(textOf(mixed)).toBe("see @Acme Corp for terms")
    })

    it("THE ANTI-ORACLE GUARD: an unlabelled mention emits nothing, never its id", () => {
      const secret = "11111111-2222-3333-4444-555555555555"
      expect(textOf(mentionDoc({ kind: "record", targetId: secret }))).toBe("")
      expect(textOf(mentionDoc({ kind: "record", targetId: secret, label: "" }))).toBe("")
    })
  })
})
