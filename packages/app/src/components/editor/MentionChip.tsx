/**
 * The inline chip a `mention` node renders as. Deliberately shaped like the
 * `user`-kind field pill in `lib/fieldDisplay.tsx` — same rounded-full muted
 * pill, same icon-then-truncated-label layout, same `stopPropagation` so clicking
 * a mention inside a clickable row doesn't also trigger the row.
 *
 * TWO STATES, and the difference is the whole permission story:
 *
 *   LINKED — we have a route, so render a `<Link>`.
 *   INERT  — no route: either the caller may not read the target, or the target
 *            has no page at all. Renders as a plain span with the cached label.
 *
 * The two are deliberately INDISTINGUISHABLE. An inert chip must not explain
 * itself: "you can't see this" would confirm that a record exists in a concept the
 * reader is barred from, which is the existence oracle the read-permission model
 * refuses everywhere else (restricted reads fail as NotFound, never 403). So the
 * label in the document is all a reader ever gets, and that label is already prose
 * the author typed — the accepted trade.
 *
 * Reader-only for now: it displays whatever label the document cached. Live
 * resolution (which can replace the label and supply the href) arrives with
 * `resolveMentions`; until then `href` is always null and every chip is inert.
 */

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { clientHrefFor, clientLabelFor, iconForKind } from "../../lib/mentionKinds"
import { useResolvedMention } from "./MentionResolution"

const PILL =
  "inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 align-baseline text-[0.9em] font-medium leading-tight"

export function MentionChip({ node, selected }: ReactNodeViewProps) {
  const attrs = node.attrs as { kind?: unknown; targetId?: unknown; label?: unknown }
  const kind = typeof attrs.kind === "string" ? attrs.kind : ""
  const targetId = typeof attrs.targetId === "string" ? attrs.targetId : ""
  const cached = typeof attrs.label === "string" ? attrs.label : ""

  // Live resolution when the document has it; the stored attrs otherwise. A
  // resolved LABEL wins over the cached one so a renamed target reads correctly
  // without rewriting the document — the cache is a fallback, not the truth.
  const resolved = useResolvedMention(kind, targetId)
  const ref = {
    kind,
    targetId,
    label: resolved?.label ?? cached,
    href: resolved?.href ?? null,
  }
  const label = clientLabelFor(ref) || cached
  const href = clientHrefFor(ref)
  const Icon = iconForKind(kind)

  // An atom node view: `contentEditable={false}` keeps the caret out of the chip,
  // so the label can go stale but can never be edited into a lie.
  const body = (
    <>
      <Icon size={12} className="shrink-0 opacity-70" />
      <span className="max-w-60 truncate">{label || "@"}</span>
    </>
  )

  return (
    <NodeViewWrapper as="span" className="inline">
      {href ? (
        <Link
          to={href}
          contentEditable={false}
          onClick={(e) => e.stopPropagation()}
          className={cn(PILL, "text-foreground hover:bg-accent", selected && "ring-2 ring-ring")}
        >
          {body}
        </Link>
      ) : (
        <span
          contentEditable={false}
          className={cn(PILL, "text-muted-foreground", selected && "ring-2 ring-ring")}
        >
          {body}
        </span>
      )}
    </NodeViewWrapper>
  )
}
