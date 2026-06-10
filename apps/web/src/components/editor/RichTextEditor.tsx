import { Placeholder } from "@tiptap/extensions"
import { EditorContent, type JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  EMPTY_DOC,
  isRichTextValue,
  type RichTextDoc,
  richTextPlain,
  type RichTextValue,
} from "../../lib/richtext"
import { RichTextToolbar } from "./RichTextToolbar"

/** Compact prose ruleset for ProseMirror content — same approach as
 *  `MarkdownView` (design tokens, no typography plugin). */
const PROSE =
  "text-sm text-foreground [&_.ProseMirror]:min-h-24 [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2 [&_.ProseMirror]:outline-none [&_.ProseMirror>*+*]:mt-2 [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_hr]:border-border [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc"

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
}: {
  value: unknown
  editable: boolean
  placeholder?: string
  onChange?: (v: RichTextValue) => void
  onBlur?: () => void
  /** Stretch over the parent's height (flex item) instead of sizing to content. */
  fill?: boolean
}) {
  // Latest callbacks behind refs — the editor instance captures its options once.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur

  // A doc whose nodes this build's extensions don't know (written by a newer
  // build, or corrupted) must degrade to a plain-text fallback, not throw.
  const [broken, setBroken] = useState(false)

  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: placeholder ?? "Write…" })],
    content: structuredClone(isRichTextValue(value) ? value.doc : EMPTY_DOC) as JSONContent,
    editable,
    enableContentCheck: true,
    // Can fire during the initial render — defer the state write.
    onContentError: () => queueMicrotask(() => setBroken(true)),
    onUpdate: ({ editor: e }) =>
      onChangeRef.current?.({ doc: e.getJSON() as RichTextDoc, text: e.getText() }),
    onBlur: () => onBlurRef.current?.(),
  })

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  // External sync: apply a changed server doc only when it actually differs and
  // the user isn't typing. Our own save echo serializes equal → no-op.
  const serverJson = JSON.stringify(isRichTextValue(value) ? value.doc : EMPTY_DOC)
  useEffect(() => {
    if (!editor || editor.isFocused) return
    if (JSON.stringify(editor.getJSON()) === serverJson) return
    try {
      editor.commands.setContent(JSON.parse(serverJson), { emitUpdate: false })
    } catch {
      setBroken(true)
    }
  }, [editor, serverJson])

  if (broken) {
    const plain = richTextPlain(value)
    return (
      <div className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
        <p className="text-muted-foreground">
          This document was written with features this version can't display.
        </p>
        {plain && <p className="whitespace-pre-wrap">{plain}</p>}
      </div>
    )
  }

  return (
    <div
      className={cn(
        editable &&
          "rounded-md border border-input bg-background transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        fill && "flex flex-1 flex-col",
      )}
    >
      {editable && editor && <RichTextToolbar editor={editor} />}
      <EditorContent
        editor={editor}
        className={cn(
          PROSE,
          !editable && "[&_.ProseMirror]:px-0",
          // Stretch the ProseMirror area over the remaining height so the whole
          // box is clickable, not just the typed lines.
          fill && "flex min-h-0 flex-1 flex-col [&_.ProseMirror]:flex-1",
        )}
      />
    </div>
  )
}
