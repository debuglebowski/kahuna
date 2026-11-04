import { getSchema } from "@tiptap/core"
import { Node } from "@tiptap/pm/model"
import StarterKit from "@tiptap/starter-kit"
import { describe, expect, it } from "vitest"
import { deriveRichText } from "#engine"
import { markdownToRichText } from "../../cli/richtext.ts"

/**
 * The CLI builds ProseMirror docs WITHOUT the editor (it is published to npm
 * and must not ship TipTap), so nothing there can prove its nodes are ones the
 * SPA's editor knows. A doc with an unknown node or a misplaced child stores
 * fine and then fails to render. This pins the CLI's output against the REAL
 * StarterKit schema, and its derived text against the engine's walk.
 */
const schema = getSchema([StarterKit])

const SAMPLES = {
  plain: "hello",
  policy: [
    "# Information security policy",
    "",
    "Applies to **all** staff. See [ISO 27001](https://www.iso.org/standard/27001) and `docs/`.",
    "",
    "## Scope",
    "",
    "1. Laptops",
    "2. Cloud",
    "   - Azure",
    "   - GitHub",
    "",
    "- [ ] reviewed",
    "",
    "> Quoted *rule* ~~old~~",
    "",
    "```yaml",
    "key: value",
    "```",
    "",
    "---",
    "",
    "line one  ",
    "line two",
    "",
    "| Owner | Role |",
    "|---|---|",
    "| Ana | CISO |",
    "",
    "<div>raw html</div>",
    "",
    "![diagram](d.png) R&amp;D",
  ].join("\n"),
  loose: "- a\n\n  para\n\n- ```\n  code first\n  ```",
  empty: "",
}

describe("CLI markdown → doc", () => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    it(`${name}: is a valid doc in the editor's schema`, () => {
      const { doc } = markdownToRichText(md)
      // fromJSON throws on unknown node/mark types; check() on bad content.
      expect(() => Node.fromJSON(schema, doc).check()).not.toThrow()
    })

    it(`${name}: derives the same text the engine stores`, () => {
      const rt = markdownToRichText(md)
      expect(rt.text).toBe(deriveRichText(rt).text)
    })
  }
})
