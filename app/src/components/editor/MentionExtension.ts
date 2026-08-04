/**
 * The `mention` node: an inline atom referencing a record, person, page, concept,
 * dashboard or file from inside rich text.
 *
 * ONE node type with a `kind` attr, not one node type per kind. The reason is the
 * failure mode when a build meets a document it doesn't fully understand: TipTap's
 * `enableContentCheck` treats an unknown node TYPE as a broken document and
 * degrades the whole field to plain text (see `RichTextEditor`'s `broken` state),
 * whereas ProseMirror's attribute check only rejects unknown attribute NAMES, not
 * unknown VALUES. So a 7th kind added later (tasks, once they have a URL) degrades
 * to an unstyled-but-working chip inside an otherwise intact document, instead of
 * blanking every field that holds one. Six node types would mean six such hazards.
 *
 * ATOM, and the label lives in an attr rather than as editable child content. With
 * `atom: false` the caret could enter the chip and the reader could backspace a
 * character out of "Acme Corp" — leaving a label that misdescribes what it points
 * at, indistinguishable from a merely stale cache. Since the whole permission model
 * accepts the cached label as trustworthy-enough prose, it must not be editable.
 *
 * The three attrs are the entire contract; nothing else may be added. The server
 * passes `doc` through opaquely (the RPC envelope types it as an open record) and
 * only ever re-derives `text`, so what is stored round-trips verbatim. Resist
 * adding `conceptId`, `versionSeq` or a resolution timestamp: each is a second
 * source of truth that can disagree with the resolver.
 */

import { mergeAttributes, Node, ReactNodeViewRenderer } from "@tiptap/react"
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion"
import { MentionChip } from "./MentionChip"

export const MENTION_NAME = "mention"

/** Every attr carries a default. Without one, ProseMirror THROWS while computing
 *  attrs for a node that lacks it — turning a single malformed mention into a
 *  whole broken document. Defaults plus the chip's own null-checks degrade the
 *  one node instead. */
export const Mention = Node.create({
  name: MENTION_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  // Dragging an atom between documents needs a drop handler with its own
  // permission story; not part of this.
  draggable: false,

  addAttributes() {
    return {
      kind: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-kind"),
        renderHTML: (attrs) => (attrs.kind ? { "data-kind": attrs.kind } : {}),
      },
      targetId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-target-id"),
        renderHTML: (attrs) => (attrs.targetId ? { "data-target-id": attrs.targetId } : {}),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (attrs) => (attrs.label ? { "data-label": attrs.label } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-mention": "" }, HTMLAttributes)]
  },

  /**
   * How `editor.getText()` sees a mention. Must agree with `mentionText` in
   * `lib/richtext.ts` (and so with the engine's authoritative copy), because the
   * client's derived text decides whether a field looks empty BEFORE the server
   * re-derives — `InstanceForm` drops a field it reads as empty, which would make
   * a mention-only field vanish on create.
   *
   * An unlabelled mention contributes nothing, and never its `targetId`: derived
   * text is readable by anyone who can read the host record, so an id here would
   * publish the identity of a record they may not be allowed to see.
   */
  renderText({ node }) {
    const label = node.attrs.label
    return typeof label === "string" && label !== "" ? `@${label}` : ""
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChip)
  },
})

/**
 * The same node WITH the `@` trigger attached — the authoring half.
 *
 * Separate from `Mention` so a build can display mentions without being able to
 * create them: the reader must reach every open tab one deploy before the writer
 * exists, or a stale tab meets a node type it doesn't know and blanks the whole
 * field. Read-only surfaces also simply don't need the plugin.
 */
export const MentionWithTrigger = (suggestion: Record<string, unknown>) =>
  Mention.extend({
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...suggestion,
        } as SuggestionOptions),
      ]
    },
  })
