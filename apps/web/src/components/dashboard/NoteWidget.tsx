import { RichTextEditor } from "@/components/editor/RichTextEditor"
import type { DashboardWidget } from "@/lib/api"
import { isRichTextEmpty } from "@/lib/richtext"
import { cn } from "@/lib/utils"

type Note = Extract<DashboardWidget, { type: "note" }>

const APPEARANCE: Record<NonNullable<Note["appearance"]>, string> = {
  plain: "",
  info: "rounded-lg bg-info/10 px-3 py-2",
  warn: "rounded-lg bg-warning/10 px-3 py-2",
  success: "rounded-lg bg-success/10 px-3 py-2",
}

/** Free-form rich text on the canvas — read-only here; written in the widget
 *  settings panel (dashboard pages never edit the body). */
export function NoteWidget({ widget }: { widget: Note }) {
  if (!widget.content || isRichTextEmpty(widget.content)) {
    return (
      <p className="text-sm text-muted-foreground">
        An empty note — write something in the widget settings.
      </p>
    )
  }
  const scroll = widget.overflow === "scroll"
  return (
    // cancel-drag: text selection / scrolling must never start a tile drag.
    <div
      className={cn(
        "cancel-drag h-full",
        APPEARANCE[widget.appearance ?? "plain"],
        scroll
          ? "overflow-y-auto"
          : "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-20px),transparent)]",
      )}
    >
      <RichTextEditor value={widget.content} editable={false} />
    </div>
  )
}
