import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { cn } from "@/lib/utils"

const storageKey = (title: string) => `dashboard.section.${title}`

/**
 * A collapsible, labelled block in the dashboard config inspector (Figma-style
 * right-panel sections). Open/closed state persists per `title` across sessions,
 * so the same section stays the way the user left it on any node. An optional
 * `action` renders on the right of the header (its clicks don't toggle).
 */
export function InspectorSection({
  title,
  action,
  defaultOpen = true,
  children,
}: {
  title: string
  action?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(storageKey(title))
    return saved === null ? defaultOpen : saved === "1"
  })
  const toggle = () =>
    setOpen((o) => {
      const next = !o
      localStorage.setItem(storageKey(title), next ? "1" : "0")
      return next
    })
  return (
    <section className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          <ChevronRight
            size={13}
            className={cn("shrink-0 transition-transform", open && "rotate-90")}
          />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="space-y-4 pt-2.5">{children}</div>}
    </section>
  )
}
