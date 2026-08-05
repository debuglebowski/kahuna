import { describe, expect, it } from "vitest"
import { collectMentions } from "./mentionDoc"

const mention = (kind: string, targetId: string) => ({
  type: "mention",
  attrs: { kind, targetId, label: "x" },
})

const doc = (...nodes: ReadonlyArray<unknown>) => ({
  type: "doc",
  content: [{ type: "paragraph", content: nodes }],
})

describe("collectMentions", () => {
  it("collects distinct mentions in document order", () => {
    expect(
      collectMentions(
        doc(mention("record", "a"), { type: "text", text: " and " }, mention("person", "u1")),
      ),
    ).toEqual([
      { kind: "record", targetId: "a" },
      { kind: "person", targetId: "u1" },
    ])
  })

  it("dedupes the same target mentioned twice — one resolve, not two", () => {
    expect(collectMentions(doc(mention("record", "a"), mention("record", "a")))).toHaveLength(1)
  })

  it("distinguishes the same id under different kinds", () => {
    expect(collectMentions(doc(mention("record", "x"), mention("concept", "x")))).toHaveLength(2)
  })

  it("finds mentions nested at any depth", () => {
    const nested = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [mention("dashboard", "d1")] }],
            },
          ],
        },
      ],
    }
    expect(collectMentions(nested)).toEqual([{ kind: "dashboard", targetId: "d1" }])
  })

  it("drops malformed nodes instead of throwing", () => {
    expect(collectMentions(doc(mention("notAKind", "x")))).toEqual([])
    expect(collectMentions(doc(mention("record", "")))).toEqual([])
    expect(collectMentions(doc({ type: "mention" }))).toEqual([])
    expect(collectMentions(null)).toEqual([])
    expect(collectMentions({ type: "doc" })).toEqual([])
  })

  it("agrees with the engine's extractor on a shared fixture", () => {
    // The two walks are deliberate mirrors (`engine/domain/mentions.ts`). This
    // fixture is the same shape that file's test uses.
    const shared = doc(mention("record", "a"), mention("person", "u1"), mention("record", "a"))
    expect(collectMentions(shared)).toEqual([
      { kind: "record", targetId: "a" },
      { kind: "person", targetId: "u1" },
    ])
  })
})
