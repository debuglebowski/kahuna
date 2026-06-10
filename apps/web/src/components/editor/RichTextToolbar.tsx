import type { Editor } from "@tiptap/react"
import { useEditorState } from "@tiptap/react"
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  SquareCode,
  Strikethrough,
  TextQuote,
  Undo2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { IconButton } from "../ui"

/** One formatting action; active/enabled snapshot comes from `useEditorState`. */
function Action({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string
  icon: typeof Bold
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <IconButton
      aria-label={label}
      disabled={disabled}
      // Keep the editor selection: a mousedown on a button would blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(active && "bg-accent text-foreground")}
    >
      <Icon size={15} />
    </IconButton>
  )
}

const Divider = () => <span className="mx-0.5 h-4 w-px self-center bg-border" />

/** Fixed formatting bar for {@link RichTextEditor}. Link entry is a plain
 *  prompt for v1 (matches the minimal toolbar scope). */
export function RichTextToolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })

  const setLink = () => {
    const prev = (editor.getAttributes("link").href as string | undefined) ?? ""
    if (s.link && prev) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
      return
    }
    const href = window.prompt("Link URL", prev)
    if (!href) return
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run()
  }

  const chain = () => editor.chain().focus()
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      <Action label="Bold" icon={Bold} active={s.bold} onClick={() => chain().toggleBold().run()} />
      <Action
        label="Italic"
        icon={Italic}
        active={s.italic}
        onClick={() => chain().toggleItalic().run()}
      />
      <Action
        label="Strikethrough"
        icon={Strikethrough}
        active={s.strike}
        onClick={() => chain().toggleStrike().run()}
      />
      <Action label="Code" icon={Code} active={s.code} onClick={() => chain().toggleCode().run()} />
      <Divider />
      <Action
        label="Heading 1"
        icon={Heading1}
        active={s.h1}
        onClick={() => chain().toggleHeading({ level: 1 }).run()}
      />
      <Action
        label="Heading 2"
        icon={Heading2}
        active={s.h2}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      />
      <Action
        label="Heading 3"
        icon={Heading3}
        active={s.h3}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      />
      <Divider />
      <Action
        label="Bullet list"
        icon={List}
        active={s.bulletList}
        onClick={() => chain().toggleBulletList().run()}
      />
      <Action
        label="Numbered list"
        icon={ListOrdered}
        active={s.orderedList}
        onClick={() => chain().toggleOrderedList().run()}
      />
      <Action
        label="Quote"
        icon={TextQuote}
        active={s.blockquote}
        onClick={() => chain().toggleBlockquote().run()}
      />
      <Action
        label="Code block"
        icon={SquareCode}
        active={s.codeBlock}
        onClick={() => chain().toggleCodeBlock().run()}
      />
      <Action label={s.link ? "Remove link" : "Link"} icon={Link2} active={s.link} onClick={setLink} />
      <Divider />
      <Action
        label="Undo"
        icon={Undo2}
        disabled={!s.canUndo}
        onClick={() => chain().undo().run()}
      />
      <Action
        label="Redo"
        icon={Redo2}
        disabled={!s.canRedo}
        onClick={() => chain().redo().run()}
      />
    </div>
  )
}
