import { Placeholder } from "@tiptap/extensions"
import { EditorContent, type JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  EMPTY_DOC,
  isRichTextValue,
  type RichTextDoc,
  type RichTextValue,
  richTextPlain,
  sameDoc,
} from "../../lib/richtext"
import { Mention, MentionWithTrigger } from "./MentionExtension"
import { MentionResolutionProvider } from "./MentionResolution"
import { createMentionTriggerStore, MentionTriggerMenu, mentionSuggestion } from "./MentionTrigger"
import { RichTextToolbar } from "./RichTextToolbar"

/** Compact prose ruleset for ProseMirror content — same approach as
 *  `MarkdownView` (design tokens, no typography plugin). Height is deliberately
 *  absent: it differs per mode (content-sized with a floor vs. filling). */
const PROSE =
  "text-sm text-foreground [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2 [&_.ProseMirror]:outline-none [&_.ProseMirror>*+*]:mt-2 [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_hr]:border-border [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc"

/**
 * TipTap editor over a `richtext` field value (the `{ doc, text }` envelope).
 * Uncontrolled while focused: the editor owns its state and emits envelopes
 * via `onChange` (callers debounce/save); a changed server `value` is applied
 * only when unfocused, so live-collection refetches never steal the caret.
 * Readonly is the same component with `editable: false` and no toolbar.
 */
export function RichTextEditor({
  value,
  editable,
  placeholder,
  onChange,
  onBlur,
  fill = false,
  toolbarRight,
  chrome,
}: {
  value: unknown
  editable: boolean
  placeholder?: string
  onChange?: (v: RichTextValue) => void
  onBlur?: () => void
  /** Stretch over the parent's height instead of sizing to content. The parent
   *  must be a flex column (the editor becomes a `flex-1` item of it); the
   *  content area then scrolls inside the frame, so the toolbar stays put and the
   *  box never grows past the parent. */
  fill?: boolean
  /** Right-aligned slot in the toolbar row (only shown while editable) — e.g. a
   *  save-status indicator that should share the toolbar's line. */
  toolbarRight?: ReactNode
  /** Show the editing chrome (toolbar + framed surface + placeholder) even when
   *  `editable` is false. Defaults to `editable`. Forced on for a tile that must
   *  look identical whether interactive or inert (the dashboard layout editor),
   *  so the read-only render still reads as "this is where you'd write". */
  chrome?: boolean
}) {
  const showChrome = chrome ?? editable
  // Latest callbacks behind refs — the editor instance captures its options once.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur

  // A doc whose nodes this build's extensions don't know (written by a newer
  // build, or corrupted) must degrade to a plain-text fallback, not throw.
  const [broken, setBroken] = useState(false)
  // Read inside `onUpdate`, which captured its options once and so can't see the
  // state. On the broken path TipTap has already re-parsed the doc to an EMPTY
  // one; letting that empty doc reach `onChange` would autosave away content this
  // build merely failed to display. Today that's unreachable (the early return
  // below means `EditorContent` never mounts, so `onUpdate` never fires) — this
  // makes it unreachable by construction rather than by coincidence.
  const brokenRef = useRef(false)
  brokenRef.current = broken

  // One trigger store per editor instance — several editors can be mounted at
  // once (a record page with two document tiles), and each needs its own menu.
  const triggerStore = useRef(createMentionTriggerStore()).current

  const editor = useEditor({
    extensions: [
      StarterKit,
      // The `@` trigger only where text can be written; read-only surfaces get
      // the plain reader node. Both register the SAME node type, so a document
      // renders identically either way — only authoring differs.
      editable ? MentionWithTrigger(mentionSuggestion(triggerStore)) : Mention,
      // With forced chrome the surface looks editable while inert, so the
      // placeholder must show without `editable` too; otherwise keep the default
      // (placeholder only while editable) so read-only views stay blank.
      Placeholder.configure({
        placeholder: placeholder ?? "Write…",
        showOnlyWhenEditable: chrome !== true,
      }),
    ],
    content: structuredClone(isRichTextValue(value) ? value.doc : EMPTY_DOC) as JSONContent,
    editable,
    enableContentCheck: true,
    // Can fire during the initial render — defer the state write.
    onContentError: () => queueMicrotask(() => setBroken(true)),
    onUpdate: ({ editor: e }) => {
      if (brokenRef.current) return
      onChangeRef.current?.({ doc: e.getJSON() as RichTextDoc, text: e.getText() })
    },
    onBlur: () => onBlurRef.current?.(),
  })

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  // External sync: apply a changed server doc only when it actually differs and
  // the user isn't typing. The difference test MUST be structural, not a string
  // compare: the server doc came back through Postgres `jsonb`, which reorders
  // object keys (by length, then bytewise), so a stringified comparison is always
  // unequal for any doc holding a text node and would re-`setContent` on every
  // refetch — remounting every node view (and so refetching every mention chip).
  // `serverJson` stays the effect dep, since a primitive is the right dep shape.
  const serverJson = JSON.stringify(isRichTextValue(value) ? value.doc : EMPTY_DOC)
  useEffect(() => {
    if (!editor || editor.isFocused) return
    // Re-parsed rather than closed over, so the string stays the only dependency.
    const serverDoc = JSON.parse(serverJson)
    if (sameDoc(editor.getJSON(), serverDoc)) return
    try {
      editor.commands.setContent(serverDoc, { emitUpdate: false })
    } catch {
      setBroken(true)
    }
  }, [editor, serverJson])

  if (broken) {
    const plain = richTextPlain(value)
    return (
      <div className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
        <p className="text-muted-foreground">
          This document was written with features this version can't display. Reload the page to
          update.
        </p>
        {plain && <p className="whitespace-pre-wrap">{plain}</p>}
      </div>
    )
  }

  return (
    // Resolution is scoped to the document, not the chip: one request per editor
    // instead of one per mention, and one shared cache the chips read.
    <MentionResolutionProvider doc={isRichTextValue(value) ? value.doc : EMPTY_DOC}>
      {/* Fixed-positioned at the caret, so it sits outside the editor's own box
          and cannot be clipped by a tile's `overflow-hidden`. */}
      {editable && <MentionTriggerMenu store={triggerStore} />}
      <div
        className={cn(
          showChrome &&
            "border border-input bg-background transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          // Corner radius by role: filling, the editor IS its container's surface,
          // so it takes the container radius (what cards and widget tiles use) —
          // at zero tile padding its corners then sit flush inside the tile's.
          // Content-sized, it's an input among inputs (Input/Textarea's radius).
          showChrome && (fill ? "rounded-xl" : "rounded-md"),
          // Fill mode: a flex item taking the parent column's leftover height.
          // `min-h-0` so it shrinks to that height instead of to its content;
          // `overflow-hidden` keeps the scrolling content inside the rounded frame.
          fill && "flex min-h-0 flex-1 flex-col overflow-hidden",
        )}
      >
        {showChrome && editor && <RichTextToolbar editor={editor} right={toolbarRight} />}
        <EditorContent
          editor={editor}
          className={cn(
            PROSE,
            !showChrome && "[&_.ProseMirror]:px-0",
            // Fill mode: the content area takes the height left under the toolbar
            // and scrolls itself, and `.ProseMirror` stretches over all of it so
            // the whole box is clickable, not just the typed lines. Otherwise it
            // sizes to the content, with a few lines' worth as the floor.
            fill
              ? "flex min-h-0 flex-1 flex-col overflow-y-auto [&_.ProseMirror]:flex-1"
              : "[&_.ProseMirror]:min-h-24",
          )}
        />
      </div>
    </MentionResolutionProvider>
  )
}
